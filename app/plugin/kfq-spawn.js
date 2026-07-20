// 席位章程上系统提示层（v0.6.0）——被两处 require 的共享模块，保持零依赖（仅 node 内置）：
//   1) 插件 index.js：packDir/packPath/seatFile/safeId 的唯一权威（章程包落盘与门控判断）。
//   2) 上游 sessions.js（补丁7 注入）：spawnSession 时调用 apply()，把该席位的章程包拼进
//      上游 withCliDeckGuide 已插好的启动旗——claude 系（含 GLM/DeepSeek 中转席）走
//      --append-system-prompt，codex 走 -c developer_instructions=。真系统提示层：上下文
//      压缩不丢、接续/重启时自动换最新版；普通会话不带席位身份，永远不会被注入。
// 身份判定按（projectId, 会话名）查群档案成员表——显式标识，不猜工作目录（同目录可住多群）。
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = process.env.KFQ_DATA_DIR || path.join(os.homedir(), '.clideck', 'kaifabuqun');

// 与账本/群档案同一套 id 消毒（index.js 从这里取用，两边必须同键）
const safeId = pid => String(pid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
// 席位名转文件名：保留中文，只挡路径危险字符与空白
const seatFile = name => String(name).replace(/[\\/:*?"<>|\x00-\x1f\s]/g, '_').slice(0, 60) + '.md';
const packDir = pid => path.join(DATA, 'packs', safeId(pid));
const packPath = (pid, name) => path.join(packDir(pid), seatFile(name));

// 上游 agent-session-guide.js 的同款判定：win 下 cmd /c 包裹时真命令从下标 2 开始
function commandStart(parts) {
  if (process.platform === 'win32' && parts.length > 2 && /^cmd(?:\.exe)?$/i.test(path.basename(String(parts[0])).toLowerCase()) && String(parts[1]).toLowerCase() === '/c') return 2;
  return 0;
}

// spawn 参数改写：找不到席位/读不到章程包/引擎不支持 → 原样返回（in-band 注入兜底，绝不让开工位失败）
function apply(parts, presetId, projectId, seatName) {
  const out = { parts, env: {} };
  try {
    if (!Array.isArray(parts) || !projectId || !seatName) return out;
    if (presetId !== 'claude-code' && presetId !== 'codex') return out;
    const g = JSON.parse(fs.readFileSync(path.join(DATA, 'groups', safeId(projectId) + '.json'), 'utf8'));
    if (!g || g.legacy || !(g.members || []).some(m => m.seatName === seatName)) return out;
    const pp = packPath(projectId, seatName);
    const pack = fs.readFileSync(pp, 'utf8');
    if (!pack.trim()) return out;
    const next = [...parts];
    if (presetId === 'claude-code') {
      if (next.includes('--system-prompt')) return out; // 用户自定义整套系统提示 → 不掺和
      const i = next.indexOf('--append-system-prompt');
      if (i >= 0 && typeof next[i + 1] === 'string') next[i + 1] = next[i + 1] + '\n\n' + pack; // 上游 GUIDE 之后拼章程
      else next.splice(commandStart(next) + 1, 0, '--append-system-prompt', pack);
    } else {
      const i = next.findIndex((p, ix) => (p === '-c' || p === '--config') && String(next[ix + 1] || '').startsWith('developer_instructions='));
      if (i >= 0) {
        let cur = null;
        try { cur = JSON.parse(String(next[i + 1]).slice('developer_instructions='.length)); } catch {}
        next[i + 1] = 'developer_instructions=' + JSON.stringify((typeof cur === 'string' && cur ? cur + '\n\n' : '') + pack);
      } else if (next.some(p => String(p).startsWith('-cdeveloper_instructions=') || String(p).startsWith('--config=developer_instructions='))) {
        return out; // 紧凑写法只有用户手配才会出现 → 不掺和
      } else next.splice(commandStart(next) + 1, 0, '-c', 'developer_instructions=' + JSON.stringify(pack));
    }
    out.parts = next;
    out.env = { KFQ_GROUP: String(projectId), KFQ_SEAT: String(seatName), KFQ_CHARTER: pp };
    return out;
  } catch { return out; }
}

module.exports = { DATA, safeId, seatFile, packDir, packPath, apply };
