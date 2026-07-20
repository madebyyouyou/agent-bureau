// 补丁6（一轮多段回复收齐）行为验证：把变换套在 vendor 参考副本上，真跑收集函数。
// 场景复刻 2026-07-19 03:13 事故：成员一轮里"发言→工具→信封汇报→工具→收尾"，
// 旧逻辑只留收尾（信封整段丢失），补丁后收工候选稿要包含全部正文段。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { patch6Candidate, patch6Handlers } = require('../app/scripts/patch-clideck.js');
const { parseEnvelopes } = require('../app/plugin/index.js')._test;

const VENDOR = path.join(__dirname, '..', 'vendor', 'clideck');

function loadPatchedCandidate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfq-p6-'));
  for (const f of ['transcript-normalizer.js', 'transcript-parser.js']) {
    fs.copyFileSync(path.join(VENDOR, f), path.join(dir, f));
  }
  const patched = patch6Candidate(fs.readFileSync(path.join(VENDOR, 'transcript-candidate.js'), 'utf8'));
  assert.equal(typeof patched, 'string', '变换应命中 vendor 副本（undefined=锚点失配）');
  const file = path.join(dir, 'transcript-candidate.js');
  fs.writeFileSync(file, patched);
  return require(file);
}

// 事故复刻的终端缓冲（注入提示 → 正文块 → 工具块 → 信封汇报块 → 工具块 → 收尾块 → 空闲屏）
const LINES = [
  '> 【私聊｜老板】一口气把整个进程推进下去',
  '',
  '⏺ 收到，我来当总包。先摸清现状再推。',
  '',
  '⏺ Read(src/app/store.ts)',
  '  ⎿ Read 120 lines',
  '',
  '⏺ 向老板汇报（私聊）：',
  '',
  '  <private_message>',
  '  店铺总览页这一版整条链路我打通了，全绿，来给你过目。',
  '  </private_message>',
  '',
  '⏺ Write(memory.md)',
  '  ⎿ Wrote 40 lines',
  '',
  '⏺ 已把这一版的进度沉淀进记忆，本轮小结：全绿收工。',
  '',
  '──────────────────────────',
  '> Try "edit the file to..."',
  '──────────────────────────',
  '  ? for shortcuts',
];

test('补丁6：收工候选稿收齐一轮全部正文块', async t => {
  const mod = loadPatchedCandidate();

  await t.test('基线（未扩前）：update 只留最后一段——信封段确实会丢，这正是要修的', () => {
    mod.update('s1', 'claude-code', LINES, []);
    assert.equal(mod.get('s1'), '已把这一版的进度沉淀进记忆，本轮小结：全绿收工。');
    assert.ok(!mod.get('s1').includes('打通'));
  });

  await t.test('kfqExpand：三段正文全收齐，工具块与空闲屏噪音剔除', () => {
    mod.kfqExpand('s1', 'claude-code', LINES);
    const c = mod.get('s1');
    assert.ok(c.startsWith('收到，我来当总包'));
    assert.ok(c.includes('<private_message>'));
    assert.ok(c.includes('店铺总览页这一版整条链路我打通了'));
    assert.ok(c.endsWith('全绿收工。'));
    assert.ok(!c.includes('Read('));
    assert.ok(!c.includes('⎿'));
    assert.ok(!c.includes('Try "edit'));
    // 端到端：插件的信封解析要能从扩齐后的稿子里提出这条私聊
    assert.equal(parseEnvelopes(c).dm[0].text, '店铺总览页这一版整条链路我打通了，全绿，来给你过目。');
  });

  await t.test('折叠粘贴提示也算锚点（> [Pasted text #N +X lines]）', () => {
    const lines = ['> [Pasted text #1 +12 lines]', ...LINES.slice(1)];
    mod.update('s2', 'claude-code', lines, []);
    mod.kfqExpand('s2', 'claude-code', lines);
    assert.ok(mod.get('s2').includes('打通'));
  });

  await t.test('认不出锚点（老板直打的字/无注入提示）→ 保持旧候选稿不动', () => {
    const lines = ['> 兄弟你怎么了', ...LINES.slice(1)];
    mod.update('s3', 'claude-code', lines, []);
    const before = mod.get('s3');
    mod.kfqExpand('s3', 'claude-code', lines);
    assert.equal(mod.get('s3'), before);
  });

  await t.test('只有一段正文 → 保持旧行为（无谓扩写不做）', () => {
    const lines = ['> 【群消息｜老板】看一下', '', '⏺ Read(x.ts)', '  ⎿ ok', '', '⏺ 只有收尾一段。'];
    mod.update('s4', 'claude-code', lines, []);
    mod.kfqExpand('s4', 'claude-code', lines);
    assert.equal(mod.get('s4'), '只有收尾一段。');
  });

  await t.test('无版式库的席位（gemini 等）不介入', () => {
    mod.update('s5', 'claude-code', LINES, []); // 先塞个已知值
    const before = mod.get('s5');
    mod.kfqExpand('s5', 'gemini-cli', LINES);
    assert.equal(mod.get('s5'), before);
  });
});

// codex 版式的事故复刻（版式证据：真机 codex-cli 0.144.6 TUI 抓屏，2026-07-19）——
// 一轮"表态→工具→交接信封→Stop hooks→收尾"，旧逻辑只留收尾，交接信封整段蒸发。
const LINES_CODEX = [
  '› 【群消息｜老板】@评审 这一批功能做完了，请审核',
  '  （轮到你发言：<group_message>要说的话</group_message>；无补充 <pass />）',
  '',
  '• 收到，开始审核这一批。',
  '',
  '• Ran node -v',
  '  └ v24.16.0',
  '',
  '⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.',
  '⚠ MCP client for `netease-music` failed to start: MCP startup failed: connection',
  '  closed: initialize response',
  '',
  '• 审核结论如下：<group_message>@前端主程',
  '  【交接】',
  '  完成：本批功能审核完毕，两处缺陷',
  '  交付物：docs/review.md',
  '  请你：修复后回传</group_message>',
  '',
  '• You have 2 usage limit resets available. Run /usage to use one.',
  '',
  '• Running 2 Stop hooks',
  '',
  '• 本轮审核收工。',
  '',
  '────────────────────────────────────────',
  '› Write tests for @filename',
  '  gpt-5.6-sol high · ~\\AppData\\Local\\Temp\\probe',
];

test('补丁6 v2：codex 席多段收齐', async t => {
  const mod = loadPatchedCandidate();

  await t.test('基线（未扩前）：codex 同样只剩收尾——交接信封确实会丢', () => {
    mod.update('c1', 'codex', LINES_CODEX, []);
    assert.ok(!mod.get('c1').includes('审核结论'), '基线只留最后一段，信封丢失是事实');
  });

  await t.test('kfqExpand：三段正文收齐，工具/告警/系统噪音全剔', () => {
    mod.kfqExpand('c1', 'codex', LINES_CODEX);
    const c = mod.get('c1');
    assert.ok(c.startsWith('收到，开始审核这一批。'));
    assert.ok(c.includes('审核结论如下'));
    assert.ok(c.includes('本轮审核收工。'));
    assert.ok(!c.includes('Ran node'), '工具块剔除');
    assert.ok(!c.includes('└'), '工具输出剔除');
    assert.ok(!c.includes('⚠'), '告警行剔除');
    assert.ok(!c.includes('closed: initialize response'), '告警折行尾巴跟着剔除');
    assert.ok(!c.includes('usage limit'), '用量通知（伪装成 • 块）剔除');
    assert.ok(!c.includes('Stop hooks'), '钩子通知剔除');
    assert.ok(!c.includes('Write tests'), '空闲屏 composer 剔除');
    // 端到端：交接信封三要素完整可解析——这正是交接体系依赖的那条命
    const env = parseEnvelopes(c);
    assert.equal(env.group.length, 1);
    assert.match(env.group[0], /^@前端主程\n【交接】/);
    assert.ok(env.group[0].includes('交付物：docs/review.md'));
  });

  await t.test('认不出锚点（无注入提示）→ 保持旧候选稿不动', () => {
    const lines = ['› 随手打的字', ...LINES_CODEX.slice(1)];
    mod.update('c2', 'codex', lines, []);
    const before = mod.get('c2');
    mod.kfqExpand('c2', 'codex', lines);
    assert.equal(mod.get('c2'), before);
  });

  await t.test('只有一段正文 → 保持旧行为', () => {
    const lines = ['› 【群消息｜老板】看一下', '', '• Ran node -v', '  └ ok', '', '• 只有收尾。'];
    mod.update('c3', 'codex', lines, []);
    mod.kfqExpand('c3', 'codex', lines);
    assert.equal(mod.get('c3'), '只有收尾。');
  });

  await t.test('claude 事故复刻在 v2 下结果不变（回归护栏）', () => {
    mod.update('c4', 'claude-code', LINES, []);
    mod.kfqExpand('c4', 'claude-code', LINES);
    const c = mod.get('c4');
    assert.ok(c.startsWith('收到，我来当总包') && c.endsWith('全绿收工。'));
    assert.equal(parseEnvelopes(c).dm[0].text, '店铺总览页这一版整条链路我打通了，全绿，来给你过目。');
  });
});

test('补丁6：变换本身（锚点命中/幂等/收工调用注入）', async t => {
  await t.test('candidate 变换幂等：打过再打返回 null', () => {
    const src = fs.readFileSync(path.join(VENDOR, 'transcript-candidate.js'), 'utf8');
    const once = patch6Candidate(src);
    assert.equal(typeof once, 'string');
    assert.equal(patch6Candidate(once), null);
  });
  await t.test('已打 v1 的机器 → 旧注入块原地换成 v2（重打不叠加）', () => {
    const src = fs.readFileSync(path.join(VENDOR, 'transcript-candidate.js'), 'utf8');
    const v1ish = src.replace('module.exports = { update, get, clear };',
      '/*kfq-multi-block*/\nfunction kfqExpand(id, presetId, lines) { /* 旧版：只认 claude */ }\nmodule.exports = { update, get, clear, kfqExpand };');
    const re = patch6Candidate(v1ish);
    assert.equal(typeof re, 'string', '旧版块应被识别并替换');
    assert.ok(re.includes('@v2'), '换上了 v2 版本标');
    assert.ok(!re.includes('旧版：只认 claude'), '旧函数体已移除');
    assert.equal(re.match(/function kfqExpand/g).length, 1, '只有一份注入函数');
    assert.equal(patch6Candidate(re), null, '换新后幂等');
  });
  await t.test('handlers 变换：kfqExpand 调用插在收工提交之前，且幂等', () => {
    const src = fs.readFileSync(path.join(VENDOR, 'handlers.js'), 'utf8');
    const once = patch6Handlers(src);
    assert.equal(typeof once, 'string');
    const at = once.indexOf("require('./transcript-candidate').kfqExpand(msg.id, sess.presetId, candidateLines)");
    const commit = once.indexOf('transcript.commitAgentCandidate(msg.id, sess.presetId);', once.indexOf('sess._finalizeOnIdle = false;'));
    assert.ok(at > 0 && commit > at, '调用要落在收工提交分支内、提交之前');
    assert.equal(patch6Handlers(once), null);
  });
  await t.test('锚点失配返回 undefined（clideck 升级预警）', () => {
    assert.equal(patch6Candidate('module.exports = {};'), undefined);
    assert.equal(patch6Handlers('nothing here'), undefined);
  });
});
