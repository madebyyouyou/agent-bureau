// 纯函数单测：信封解析 / 发言排序 / 转写清洗族 / ask 尾注剥离
// 跑法：npm test（= node --test test/）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../app/plugin/index.js');
const { parseEnvelopes, orderChain, legacySpeech, isChrome, trimBanner, plainTranscript, dedupeParts, stripAskTail } = _test;

test('parseEnvelopes：群聊信封', async t => {
  await t.test('基本提取，正文按闭合标签截取原样入账（首尾去空白，内部换行保留）', () => {
    const env = parseEnvelopes('工作过程留终端。\n<group_message>\n  结论A\n第二行\n</group_message>');
    assert.deepEqual(env.group, ['结论A\n第二行']);
    assert.equal(env.pass, false);
  });
  await t.test('大小写与标签内空白宽容', () => {
    assert.deepEqual(parseEnvelopes('< Group_Message >要点</ group_message >').group, ['要点']);
  });
  await t.test('代码围栏包着也能提取（```xml 会被剥掉）', () => {
    assert.deepEqual(parseEnvelopes('```xml\n<group_message>围栏内发言</group_message>\n```').group, ['围栏内发言']);
  });
  await t.test('未闭合不算发言', () => {
    assert.deepEqual(parseEnvelopes('<group_message>写一半没闭合').group, []);
  });
  await t.test('协议示例原文不算发言（防复述章程被误提取）', () => {
    assert.deepEqual(parseEnvelopes('<group_message>要说的话</group_message>').group, []);
  });
  await t.test('多个信封都收', () => {
    assert.deepEqual(parseEnvelopes('<group_message>一</group_message>x<group_message>二</group_message>').group, ['一', '二']);
  });
});

test('parseEnvelopes：私聊信封（v0.5.9 起 target 可省）', async t => {
  await t.test('无 target 新写法', () => {
    const env = parseEnvelopes('<private_message>老板你看下</private_message>');
    assert.equal(env.dm.length, 1);
    assert.equal(env.dm[0].target, '');
    assert.equal(env.dm[0].text, '老板你看下');
  });
  await t.test('带 target 旧写法兼容', () => {
    assert.deepEqual(parseEnvelopes('<private_message target="老板">汇报</private_message>').dm, [{ target: '老板', text: '汇报' }]);
  });
  await t.test('中文引号/方括号 target 也认', () => {
    assert.equal(parseEnvelopes('<private_message target=“老板”>a</private_message>').dm[0].target, '老板');
    assert.equal(parseEnvelopes('<private_message target=「同事甲」>b</private_message>').dm[0].target, '同事甲');
  });
  await t.test('写了成员名的照收（拦截转档由路由层决定，解析层不丢）', () => {
    assert.equal(parseEnvelopes('<private_message target="评审">私下问你</private_message>').dm[0].target, '评审');
  });
  await t.test('示例正文（…）不算私聊', () => {
    assert.deepEqual(parseEnvelopes('<private_message>…</private_message>').dm, []);
  });
});

test('parseEnvelopes：pass 标记', () => {
  assert.equal(parseEnvelopes('<pass />').pass, true);
  assert.equal(parseEnvelopes('<pass/>').pass, true);
  assert.equal(parseEnvelopes('旧协议 [PASS] 也认').pass, true);
  assert.equal(parseEnvelopes('文中提到 pass 这个词不算').pass, false);
});

test('orderChain：发言顺序（@点名优先，作者除外）', async t => {
  const names = ['工程执行', '前端主程', '评审', '视觉美术'];
  await t.test('无 @ 按默认成员顺序，作者剔除', () => {
    assert.deepEqual(orderChain(names, '大家看一下', '评审'), ['工程执行', '前端主程', '视觉美术']);
  });
  await t.test('@点名按出现顺序提前', () => {
    assert.deepEqual(orderChain(names, '先请 @视觉美术 再请 @评审 说', '前端主程'), ['视觉美术', '评审', '工程执行']);
  });
  await t.test('作者被 @ 也不进链', () => {
    assert.deepEqual(orderChain(names, '@评审 你看', '评审'), ['工程执行', '前端主程', '视觉美术']);
  });
  await t.test('长名优先匹配（防"主程"抢走"主程助理"的 @）', () => {
    assert.deepEqual(orderChain(['主程', '主程助理'], '@主程助理 来', '主程'), ['主程助理']);
    assert.deepEqual(orderChain(['主程', '主程助理'], '@主程 来', '老板'), ['主程', '主程助理']);
  });
});

test('转写清洗族（只作用于无信封的兜底通道）', async t => {
  const BANNER = '─ Worked for 4m 02s ────────';
  await t.test('trimBanner：掐头去尾（chrome 行/收工横幅），中间原样', () => {
    assert.equal(trimBanner('high · /effort\n正文 保留\n' + BANNER), '正文 保留');
    assert.equal(trimBanner('正文里提到 Worked for 3s 不受影响'), '正文里提到 Worked for 3s 不受影响');
  });
  await t.test('isChrome：纯界面噪音识别', () => {
    assert.equal(isChrome('────────\n⠋ ⠙ ⠹\n> '), true);
    assert.equal(isChrome(''), true);
    assert.equal(isChrome('────\n这是一句真话\n────'), false);
    // v0.5.11：CLI 空闲屏整幕（状态条+建议占位+分隔线）不该进工作日志——2026-07-19 用户截图原文
    assert.equal(isChrome('high · /effort\n────────\n> Try "create a util logging.py that..."\n────────\nⅡ manual mode on · ? for shortcuts · ← for agents'), true);
    assert.equal(isChrome('我们试试 Try 这个词开头的正文？不能吞'), false);
  });
  await t.test('legacySpeech：【发言】标记后内容，无标记为 null', () => {
    assert.equal(legacySpeech('思考过程\n【发言】正式内容\n' + BANNER), '正式内容');
    assert.equal(legacySpeech('没有标记'), null);
  });
  await t.test('plainTranscript：唯一的兜底管线（legacy 优先，否则去噪+去横幅）', () => {
    assert.equal(plainTranscript('杂音\n【发言】老板收到\n' + BANNER), '老板收到');
    assert.equal(plainTranscript('? for shortcuts\n直接写的回复\n' + BANNER), '直接写的回复');
  });
});

test('dedupeParts：定稿收稿去重（防菜单中途一段+收工全量的重复致信封重发）', async t => {
  await t.test('后稿包含前稿 → 只留全量', () => {
    assert.deepEqual(dedupeParts(['A段', 'A段\n\nB段']), ['A段\n\nB段']);
  });
  await t.test('前稿包含后稿（顺序无关）同样只留最长', () => {
    assert.deepEqual(dedupeParts(['A段\n\nB段', 'A段']), ['A段\n\nB段']);
  });
  await t.test('完全相同的重复稿留一份', () => {
    assert.deepEqual(dedupeParts(['同一段', '同一段']), ['同一段']);
  });
  await t.test('互不包含的多段全保留且不改顺序', () => {
    assert.deepEqual(dedupeParts(['一', '二', '三']), ['一', '二', '三']);
  });
  await t.test('空稿剔除', () => {
    assert.deepEqual(dedupeParts(['', 'x', '']), ['x']);
  });
});

test('stripAskTail：补丁4已退役，只为老会话残留的场合尾注做剥离', async t => {
  await t.test('带旧尾注 → 剥净', () => {
    assert.equal(stripAskTail('问题正文\n\n（场合：同事咨询｜直接回答提问者，不使用信封。）'), '问题正文');
  });
  await t.test('无尾注原样返回（新注入一律无尾注）', () => {
    assert.equal(stripAskTail('正文没有尾注'), '正文没有尾注');
  });
});
