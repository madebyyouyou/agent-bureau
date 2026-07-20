// 轮次管道集成测试：mock api + node:test 假时钟，把「广播→并行消化→交稿即上屏→回执→pass 轮空→越权拦截→授权兜底→私聊路由」整条链路跑真
// 与生产代码同一入口 init(api)，不 mock 内部函数——测的是对外行为契约。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// DATA 目录重定向到临时目录（index.js 在 require 时按 homedir 计算）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfq-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
const { init } = require('../app/plugin/index.js');

const PID = 'test-p1';

function makeWorld() {
  const sessions = [
    { id: 'a', name: '甲', projectId: PID, commandId: 'x', presetId: 'agent', working: false },
    { id: 'b', name: '乙', projectId: PID, commandId: 'x', presetId: 'agent', working: false },
    { id: 'c', name: '丙', projectId: PID, commandId: 'x', presetId: 'agent', working: false },
  ];
  const world = { sessions, handlers: {}, cbs: {}, injected: [], events: [] };
  world.api = new Proxy({
    getSetting: () => '',
    getSessions: () => sessions,
    getSession: id => sessions.find(s => s.id === id),
    getProjects: () => [{ id: PID, path: null }],
    sendToFrontend: (ch, m) => { if (ch === 'chat') world.events.push(m.ev); },
    inputToSession: (id, data) => world.injected.push({ id, data }),
    onFrontendMessage: (name, fn) => { world.handlers[name] = fn; },
    onStatusChange: fn => { world.cbs.status = fn; },
    onTranscriptEntry: fn => { world.cbs.entry = fn; },
    onMenuDetected: () => {},
    onShutdown: () => {},
    log: () => {},
  }, { get(t, k) { return k in t ? t[k] : (() => {}); } });
  return world;
}

test('轮次管道全链路', async t => {
  // 队列式假定时器：先返回句柄再入队、tick() 排空——保住"set 之后才触发回调"的真实语义。
  // （node:test 自带的 mock.timers 在这条深嵌套定时器链上会漏火，实测不可用；此桩已在 v0.5.8 冒烟中验证）
  const real = { st: global.setTimeout, ct: global.clearTimeout, si: global.setInterval };
  let tq = [];
  global.setTimeout = (fn, ms) => { const h = { fn, dead: false }; tq.push(h); return h; };
  global.clearTimeout = h => { if (h && typeof h === 'object' && 'dead' in h) h.dead = true; else real.ct(h); };
  global.setInterval = () => ({ unref() {} });
  t.after(() => {
    global.setTimeout = real.st; global.clearTimeout = real.ct; global.setInterval = real.si;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const w = makeWorld();
  init(w.api);

  const tick = () => { let n = 0; while (tq.length && n++ < 500) { const h = tq.shift(); if (!h.dead) h.fn(); } };
  const work = (id, on) => { w.sessions.find(s => s.id === id).working = on; w.cbs.status(id, on, 'status'); tick(); };
  const speak = (id, text) => { w.cbs.entry(id, 'assistant', text); tick(); };
  const finish = (id, text) => { work(id, true); speak(id, text); work(id, false); };
  const send = m => { w.handlers.send(m); tick(); };
  const injTexts = id => w.injected.filter(x => x.id === id && x.data.includes('~')).map(x => x.data);
  const lastInj = id => injTexts(id).slice(-1)[0] || '';
  const msgs = () => w.events.filter(e => e.kind === 'msg');

  await t.test('第1幕：广播即时注入全员，持权人带最小状态标记、其余零尾注', () => {
    send({ projectId: PID, scope: 'group', text: '大家看文档，有问题现在提' });
    assert.equal(injTexts('a').length, 1);
    assert.equal(injTexts('b').length, 1);
    assert.equal(injTexts('c').length, 1);
    assert.match(lastInj('a'), /（轮到你发言：<group_message>要说的话<\/group_message>；无补充 <pass \/>）/);
    assert.doesNotMatch(lastInj('b'), /轮到你发言/); // 无发言权 = 什么都不带
    assert.doesNotMatch(lastInj('b'), /场合：/);      // v0.6.0：场合教学语言全面退役
  });

  await t.test('第2幕：持权人交稿立刻上屏，不等其他人读完', () => {
    work('a', true); work('b', true); work('c', true);
    speak('b', '<pass />'); work('b', false);
    assert.ok(w.events.some(e => e.kind === 'receipt' && e.sessionId === 'b'), '乙回执已打');
    const before = msgs().length;
    speak('a', '翻完了，两点确认。\n<group_message>正式发言A：文档无歧义。</group_message>'); work('a', false);
    const mA = msgs().find(e => e.from === '甲');
    assert.ok(mA, '甲的发言已入账');
    assert.equal(mA.text, '正式发言A：文档无歧义。');
    assert.equal(msgs().length, before + 1, '只上屏一条');
    assert.match(lastInj('b'), /正式发言A/, '新一轮广播已到乙');
    assert.match(lastInj('b'), /轮到你发言：/, '乙是新轮持权人');
    assert.match(lastInj('c'), /大家看文档/, '丙还没读完旧广播，新广播在队列里排队');
  });

  await t.test('第3幕：慢成员收工，旧轮回执照打、新广播随后注入', () => {
    speak('c', '<pass />'); work('c', false);
    assert.equal(w.events.filter(e => e.kind === 'receipt' && e.sessionId === 'c').length, 1, '轮已换不误伤旧回执');
    assert.match(lastInj('c'), /正式发言A/);
    assert.doesNotMatch(lastInj('c'), /轮到你发言/, '丙无发言权，零尾注');
  });

  await t.test('第4幕：全员 pass 的轮次直接收束，不烧任何独立授权', () => {
    finish('b', '<pass />');
    finish('c', '<pass />');
    assert.equal(w.injected.filter(x => x.data.includes('【发言权】')).length, 0);
    assert.ok(w.events.some(e => e.kind === 'sys' && /无人再补充/.test(e.text || '')), '轮次正常收束');
  });

  await t.test('第5幕：越权发言拦下留提醒；授权兜底只发给"没表态也没 pass"的人', () => {
    send({ projectId: PID, scope: 'group', text: '第二个议题' });
    work('a', true); work('b', true); work('c', true);
    const before = msgs().length;
    finish('c', '<group_message>我抢答！</group_message>');       // 丙无发言权（持权人是甲）
    assert.equal(msgs().length, before, '越权信封没有上屏');
    finish('a', '<pass />');                                       // 持权人甲弃权
    finish('b', '我记了些想法在终端，回头说。');                    // 乙：读完但没表态
    const grants = w.injected.filter(x => x.data.includes('【发言权】'));
    assert.equal(grants.length, 1, '只有乙拿到独立授权（丙 done 但排乙后面，乙先）');
    assert.match(grants[0].data, /轮到你对刚才那条群消息发言/);
    assert.ok(grants[0].id === 'b', '授权发给乙');
  });

  await t.test('第6幕：chaining 阶段被授权者交稿即上屏；拦截提醒捎带在下一次注入', () => {
    finish('b', '<group_message>正式发言B：授权后表态。</group_message>');
    const mB = msgs().find(e => e.from === '乙' && /授权后表态/.test(e.text));
    assert.ok(mB, '被授权者的发言入账');
    // 丙的越权提醒不烧独立一轮，而是随乙发言开出的新广播一起送达
    const noteInj = w.injected.filter(x => x.id === 'c' && x.data.includes('当时没有发言权，已被拦下'));
    assert.ok(noteInj.length >= 1, '丙收到拦截提醒（捎带在后续注入里）');
  });

  await t.test('第7幕：私聊路由——无 target 直达用户，成员名 target 拦下转档', () => {
    // 收掉上一幕开出的新轮，回到安静状态
    finish('a', '<pass />'); finish('c', '<pass />');
    send({ projectId: PID, scope: 'dm', targetId: 'a', text: '单独跟你说' });
    assert.match(lastInj('a'), /【私聊｜用户】\n单独跟你说/);
    assert.doesNotMatch(lastInj('a'), /场合：/, '私聊零尾注，头标即场合');
    finish('a', '<private_message>收到，我私下回你。</private_message>');
    const dm = w.events.filter(e => e.kind === 'msg' && e.scope === 'dm' && e.sessionId === 'a');
    assert.equal(dm.length, 1, '无 target 私聊直达用户');
    assert.equal(dm[0].text, '收到，我私下回你。');

    send({ projectId: PID, scope: 'dm', targetId: 'a', text: '再问一句' });
    finish('a', '<private_message target="乙">私下串一下口径</private_message>');
    const held = w.events.filter(e => e.kind === 'msg' && e.scope === 'dm' && e.sessionId === 'a').slice(-1)[0];
    assert.match(held.text, /本想私发「乙」，已被拦下/, '成员名 target 拦下转用户留档');
  });

});
