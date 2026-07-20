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
  await t.test('win cmd /c 包裹：插旗越过包裹层', function () {
    if (process.platform !== 'win32') return; // commandStart 的 win 分支
    const r = kfq.apply(['cmd.exe', '/c', 'claude'], 'claude-code', PID, SEAT);
    assert.deepEqual(r.parts, ['cmd.exe', '/c', 'claude', '--append-system-prompt', PACK]);
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
