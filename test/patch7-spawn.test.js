// 补丁7（席位章程上系统提示层）单测：
//   1) kfq-spawn.apply() 的参数改写矩阵——claude/codex 拼接、身份不符/legacy/缺包一律原样放行；
//   2) patch7Sessions 对 vendor 副本的变换与幂等（锚点漂移预警）；
//   3) patch4Retire 擦除已打机器上的 ask 尾注（vendor 原文 = no-op）。
// KFQ_DATA_DIR 必须在 require 之前设好：kfq-spawn 在模块加载时定 DATA。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfq-spawn-test-'));
process.env.KFQ_DATA_DIR = TMP;
const kfq = require('../app/plugin/kfq-spawn.js');
const { patch4Retire, patch7Sessions } = require('../app/scripts/patch-clideck.js');

const PID = 'proj-1';
const SEAT = '前端主程';
const PACK = '【团队章程】\n……章程正文……\n\n【你的角色卡】\n……角色卡……';
const GUIDE = 'CliDeck session guide:\n…上游指南…';

function seed(group) {
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'groups', kfq.safeId(PID) + '.json'), JSON.stringify(group));
  fs.mkdirSync(kfq.packDir(PID), { recursive: true });
  fs.writeFileSync(kfq.packPath(PID, SEAT), PACK);
}

// 假的 npm 壳子（照抄真机格式）：让「绕开 cmd.exe」的认路逻辑可确定性验证，
// 不依赖跑测机器上究竟装没装 claude/codex、装在哪。PATH 一换 realTarget 就重新认路。
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'kfq-bin-'));
const FAKE = {
  claudeExe: path.join(BIN, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  codexJs: path.join(BIN, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  nodeExe: path.join(BIN, 'node.exe'),
};
(function buildFakeShims() {
  for (const f of Object.values(FAKE)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  fs.writeFileSync(path.join(BIN, 'claude.cmd'),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  fs.writeFileSync(path.join(BIN, 'codex.cmd'),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n'
    + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
})();
function withFakeShims(fn) {
  const saved = process.env.PATH;
  process.env.PATH = BIN;                 // 只留假壳子，真机装没装都不影响
  try { return fn(); } finally { process.env.PATH = saved; }
}

test('kfq-spawn.apply：参数改写矩阵', async t => {
  seed({ name: 'g', members: [{ seatName: SEAT }] });

  await t.test('claude：拼在上游 GUIDE 旗之后（同一面旗，不加第二面）', () => {
    const r = kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, ['claude', '--append-system-prompt', GUIDE + '\n\n' + PACK]);
    assert.equal(r.env.KFQ_SEAT, SEAT);
    assert.equal(r.env.KFQ_GROUP, PID);
    assert.equal(r.env.KFQ_CHARTER, kfq.packPath(PID, SEAT));
  });
  await t.test('claude 接续（--resume 在后）：旗值照拼，其余参数不动', () => {
    const r = kfq.apply(['claude', '--append-system-prompt', GUIDE, '--resume', 'tok-1'], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts.slice(3), ['--resume', 'tok-1']);
    assert.ok(r.parts[2].endsWith(PACK));
  });
  await t.test('claude 无 GUIDE 旗（自定义命令）：命令后插一面新旗', () => {
    const r = kfq.apply(['claude', '--model', 'glm-5.2'], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, ['claude', '--append-system-prompt', PACK, '--model', 'glm-5.2']);
  });
  await t.test('claude 用户整套 --system-prompt：不掺和', () => {
    const parts = ['claude', '--system-prompt', '自定义'];
    const r = kfq.apply(parts, 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, parts);
    assert.deepEqual(r.env, {});
  });
  await t.test('codex：解开上游 JSON 串拼接后重新编码', () => {
    const r = kfq.apply(['codex', '-c', 'developer_instructions=' + JSON.stringify(GUIDE)], 'codex', PID, SEAT);
    assert.equal(r.parts[2], 'developer_instructions=' + JSON.stringify(GUIDE + '\n\n' + PACK));
  });
  await t.test('codex resume 子命令：旗值照拼、resume 参数原位', () => {
    const r = kfq.apply(['codex', '-c', 'developer_instructions=' + JSON.stringify(GUIDE), 'resume', 'tok-2'], 'codex', PID, SEAT);
    assert.deepEqual(r.parts.slice(3), ['resume', 'tok-2']);
    assert.equal(JSON.parse(r.parts[2].slice('developer_instructions='.length)), GUIDE + '\n\n' + PACK);
  });
  await t.test('codex 无旗：命令后插新 -c developer_instructions', () => {
    const r = kfq.apply(['codex', 'resume', 'tok-3'], 'codex', PID, SEAT);
    assert.equal(r.parts[1], '-c');
    assert.equal(JSON.parse(r.parts[2].slice('developer_instructions='.length)), PACK);
    assert.deepEqual(r.parts.slice(3), ['resume', 'tok-3']);
  });
  await t.test('win cmd /c 包裹：插旗越过包裹层，并把包裹层换成真身', function () {
    if (process.platform !== 'win32') return; // commandStart 的 win 分支
    withFakeShims(() => {
      const r = kfq.apply(['cmd.exe', '/c', 'claude'], 'claude-code', PID, SEAT);
      assert.deepEqual(r.parts, [FAKE.claudeExe, '--append-system-prompt', PACK]);
    });
  });
  await t.test('非 claude/codex 引擎：原样放行（走 in-band 兜底）', () => {
    const parts = ['gemini'];
    const r = kfq.apply(parts, 'gemini-cli', PID, SEAT);
    assert.deepEqual(r.parts, parts);
    assert.deepEqual(r.env, {});
  });
  await t.test('会话名不在成员表（普通会话/无档案工位）：原样放行', () => {
    const r = kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, '路人会话');
    assert.deepEqual(r.parts, ['claude', '--append-system-prompt', GUIDE]);
    assert.deepEqual(r.env, {});
  });
  await t.test('缺章程包文件：原样放行', () => {
    fs.rmSync(kfq.packPath(PID, SEAT), { force: true });
    const r = kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, ['claude', '--append-system-prompt', GUIDE]);
    fs.writeFileSync(kfq.packPath(PID, SEAT), PACK); // 还原给后续用例
  });
  await t.test('legacy 群：原样放行（老格式群走文件世界）', () => {
    seed({ name: 'g', legacy: true, members: [{ seatName: SEAT }] });
    const r = kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, ['claude', '--append-system-prompt', GUIDE]);
    seed({ name: 'g', members: [{ seatName: SEAT }] }); // 还原
  });
});

// v0.6.2 事故修复：章程含 <group_message>、22 个引号、134 个换行，过不了 cmd.exe 命令行
// （只认双引号、< > 当重定向、遇真换行即截断）——codex 退码 1 暴毙、claude 只剩第一行。
test('绕开 cmd.exe：把 cmd /c 包裹层换成真身', async t => {
  if (process.platform !== 'win32') return; // commandStart 只在 win 认包裹
  seed({ name: 'g', members: [{ seatName: SEAT }] });

  await t.test('codex 壳子 → [node.exe, codex.js]，旗与 resume 参数相对顺序不变', () => {
    withFakeShims(() => {
      const r = kfq.apply(['cmd.exe', '/c', 'codex', '-c', 'developer_instructions=' + JSON.stringify(GUIDE), 'resume', 'tok-9'], 'codex', PID, SEAT);
      assert.deepEqual(r.parts.slice(0, 2), [FAKE.nodeExe, FAKE.codexJs]);
      assert.equal(r.parts[2], '-c');
      assert.equal(JSON.parse(r.parts[3].slice('developer_instructions='.length)), GUIDE + '\n\n' + PACK);
      assert.deepEqual(r.parts.slice(4), ['resume', 'tok-9']);
      assert.ok(!r.parts.some(p => /cmd(\.exe)?$/i.test(String(p))), 'cmd.exe 必须彻底出局');
    });
  });
  await t.test('claude 壳子 → [claude.exe]（壳子直指 exe，不经 node）', () => {
    withFakeShims(() => {
      const r = kfq.apply(['cmd.exe', '/c', 'claude', '--append-system-prompt', GUIDE, '--resume', 'tok-8'], 'claude-code', PID, SEAT);
      assert.deepEqual(r.parts, [FAKE.claudeExe, '--append-system-prompt', GUIDE + '\n\n' + PACK, '--resume', 'tok-8']);
    });
  });
  await t.test('GLM/DeepSeek 中转席（claude + --settings）：同样绕开', () => {
    withFakeShims(() => {
      const r = kfq.apply(['cmd.exe', '/c', 'claude', '--settings', 'C:\\config\\relay.json'], 'claude-code', PID, SEAT);
      assert.deepEqual(r.parts, [FAKE.claudeExe, '--append-system-prompt', PACK, '--settings', 'C:\\config\\relay.json']);
    });
  });
  await t.test('认不出真身（PATH 里没这命令）：放弃挂旗，退回 in-band 兜底', () => {
    const saved = process.env.PATH;
    process.env.PATH = BIN;
    try {
      const parts = ['cmd.exe', '/c', 'mystery-cli', '-c', 'developer_instructions=' + JSON.stringify(GUIDE)];
      const r = kfq.apply(parts, 'codex', PID, SEAT);
      assert.deepEqual(r.parts, parts, '认不出就必须原样退回，绝不挂残旗');
      assert.deepEqual(r.env, {});
    } finally { process.env.PATH = saved; }
  });
});

// 回执＝index.js 省不省 in-band 兜底的唯一依据。v0.6.1 的门控只看「补丁装没装＋包在不在」，
// 旗被 cmd.exe 绞碎时仍报 true，三处兜底全省 → 四个席位裸奔。回执必须每次 spawn 现写现删。
test('挂旗回执：挂上才写，放弃就删', async t => {
  seed({ name: 'g', members: [{ seatName: SEAT }] });
  const receipt = () => fs.existsSync(kfq.flagPath(PID, SEAT));

  await t.test('挂上 → 写回执', () => {
    fs.rmSync(kfq.flagPath(PID, SEAT), { force: true });
    kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT);
    assert.ok(receipt(), '挂上了却没写回执 → index.js 会白发一遍章程（可容忍）');
  });
  await t.test('用户整套 --system-prompt 不掺和 → 删回执', () => {
    kfq.apply(['claude', '--system-prompt', '自定义'], 'claude-code', PID, SEAT);
    assert.ok(!receipt(), '没挂旗却留着回执 → 席位裸奔（不可容忍）');
  });
  await t.test('绕不开 cmd.exe → 删回执', function () {
    if (process.platform !== 'win32') return;
    kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT); // 先写上
    assert.ok(receipt());
    const saved = process.env.PATH;
    process.env.PATH = BIN;
    try {
      kfq.apply(['cmd.exe', '/c', 'mystery-cli'], 'claude-code', PID, SEAT);
      assert.ok(!receipt(), '认不出真身＝章程注定被绞碎，必须删回执让 in-band 接手');
    } finally { process.env.PATH = saved; }
  });
  await t.test('章程包空 → 删回执', () => {
    kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT); // 先写上
    fs.writeFileSync(kfq.packPath(PID, SEAT), '   ');
    try {
      kfq.apply(['claude', '--append-system-prompt', GUIDE], 'claude-code', PID, SEAT);
      assert.ok(!receipt());
    } finally { fs.writeFileSync(kfq.packPath(PID, SEAT), PACK); }
  });
});

test('patch7Sessions：vendor 副本变换与幂等', async t => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'clideck', 'sessions.js'), 'utf8');
  await t.test('三处锚点仍在 vendor（上游升级漂移预警）', () => {
    const out = patch7Sessions(src);
    assert.notEqual(out, undefined, '锚点丢失：sessions.js 结构变了');
    assert.notEqual(out, null);
    assert.match(out, /kfq-seat-charter/);
    assert.match(out, /pty\.spawn\(kfq\.parts\[0\], kfq\.parts\.slice\(1\)/);
    assert.match(out, /\.\.\.colorEnv, \.\.\.kfq\.env \}/);
    assert.match(out, /kfq-spawn\.js/);
  });
  await t.test('幂等：已打过 → null', () => {
    assert.equal(patch7Sessions(patch7Sessions(src)), null);
  });
  await t.test('结构不符 → undefined（触发 in-band 降级标记删除）', () => {
    assert.equal(patch7Sessions('function nothing() {}'), undefined);
  });
  await t.test('打完仍是可解析的 JS', () => {
    new Function(patch7Sessions(src).replace(/require\(/g, 'void(')); // 只验语法不执行
  });
});

test('patch4Retire：擦除 ask 尾注', async t => {
  const ORIG = 'const injected = `[CliDeck ask from ${caller.name || callerId.slice(0, 8)}]\\n\\n${message}`;';
  await t.test('vendor 原文含被还原的目标行（还原有处可落）', () => {
    const vsrc = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'clideck', 'session-ask.js'), 'utf8');
    assert.ok(vsrc.includes(ORIG), '上游 session-ask.js 注入行变了');
    assert.equal(patch4Retire(vsrc), null, '原文无补丁 → no-op');
  });
  await t.test('已打过补丁4的机器 → 擦回原样', () => {
    const baked = 'before\n/*kfq-ask-tail*/const injected = `[CliDeck ask from ${caller.name || callerId.slice(0, 8)}]\\n\\n${message}\\n\\n（场合：同事咨询｜直接回答提问者，不使用信封。）`;\nafter';
    assert.equal(patch4Retire(baked), 'before\n' + ORIG + '\nafter');
  });
});
