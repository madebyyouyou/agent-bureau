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
// 挂旗回执：apply() 真挂上才写、放弃就删。index.js 的 flagInjected 读它决定是否省掉 in-band
// 兜底——门控必须看「这次 spawn 到底挂没挂」，不能只看补丁装没装（v0.6.1 假阳性事故）。
const flagDir = pid => path.join(DATA, 'flags', safeId(pid));
const flagPath = (pid, name) => path.join(flagDir(pid), seatFile(name));
function markFlag(pid, name, mode) {
  try {
    fs.mkdirSync(flagDir(pid), { recursive: true });
    fs.writeFileSync(flagPath(pid, name), JSON.stringify({ at: new Date().toISOString(), mode }));
  } catch {}
}
function clearFlag(pid, name) { try { fs.rmSync(flagPath(pid, name), { force: true }); } catch {} }

// 上游 agent-session-guide.js 的同款判定：win 下 cmd /c 包裹时真命令从下标 2 开始
function commandStart(parts) {
  if (process.platform === 'win32' && parts.length > 2 && /^cmd(?:\.exe)?$/i.test(path.basename(String(parts[0])).toLowerCase()) && String(parts[1]).toLowerCase() === '/c') return 2;
  return 0;
}

// ——— 绕开 cmd.exe（v0.6.2）———
// 上游 utils.js 把 codex/claude 这类无后缀命令套成 `cmd.exe /c <命令>`，只为借 PATHEXT 解析。
// 但 cmd.exe 只认双引号、把 < > | & 当元字符、遇真换行即截断命令行，而章程恰好三样全占
// （<group_message>、22 个引号、134 个换行）：codex 被当输入重定向 1 秒退码 1、claude 静默
// 只剩第一行（47 字→8 字）。修法＝读 npm 生成的 .cmd 壳子问出真身，直接 spawn，让 node-pty
// 走正规 argv 传参，cmd 那套解析彻底不参与。认不出真身就不挂旗，交给 in-band 兜底。
const shimCache = new Map();
function whichFile(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.cmd', '.exe', '.bat']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
// 返回替换 ['cmd.exe','/c','<命令>'] 的真身前缀：[claude.exe] 或 [node.exe, codex.js]；认不出→null
function realTarget(cmdName) {
  const key = cmdName + '\0' + (process.env.PATH || ''); // PATH 变了就重新认路（也让单测能换假壳子）
  if (shimCache.has(key)) return shimCache.get(key);
  let target = null;
  try {
    const shim = whichFile(cmdName);
    if (shim && /\.exe$/i.test(shim)) target = [shim];           // 本来就是 exe，直说
    else if (shim && /\.cmd$/i.test(shim)) {
      const dp0 = path.dirname(shim);
      // npm 壳子真正的调用行永远带 %*（前面那些是 SETLOCAL/IF EXIST 的样板）
      const line = fs.readFileSync(shim, 'utf8').split(/\r?\n/).filter(l => l.includes('%*')).pop();
      const toks = (line || '').match(/"[^"]*"/g) || [];
      const paths = toks
        .map(t => path.normalize(t.slice(1, -1).replace(/%~?dp0%/gi, dp0 + path.sep)))
        .filter(t => /\.(exe|js)$/i.test(t) && fs.existsSync(t));
      const js = paths.find(p => /\.js$/i.test(p));
      const exe = paths.find(p => /\.exe$/i.test(p));
      // "%_prog%" 展开成壳子同目录的 node.exe，没有就用跑着 clideck 的这个 node（比 PATH 稳）
      if (js) target = [exe || (fs.existsSync(path.join(dp0, 'node.exe')) ? path.join(dp0, 'node.exe') : process.execPath), js];
      else if (exe) target = [exe];
    }
  } catch { target = null; }
  shimCache.set(key, target);
  return target;
}

// spawn 参数改写：找不到席位/读不到章程包/引擎不支持 → 原样返回（in-band 注入兜底，绝不让开工位失败）
// 凡是「决定不挂旗」的出口都要 clearFlag，凡是挂上的都要 markFlag——回执是 index.js 省不省
// in-band 兜底的唯一依据，宁可多发一遍章程，也不能让席位以为有、其实没有。
function apply(parts, presetId, projectId, seatName) {
  const out = { parts, env: {} };
  const give = () => { clearFlag(projectId, seatName); return out; }; // 放弃挂旗（席位已认定）
  try {
    if (!Array.isArray(parts) || !projectId || !seatName) return out;
    if (presetId !== 'claude-code' && presetId !== 'codex') return out;
    const g = JSON.parse(fs.readFileSync(path.join(DATA, 'groups', safeId(projectId) + '.json'), 'utf8'));
    if (!g || g.legacy || !(g.members || []).some(m => m.seatName === seatName)) return out;
    const pp = packPath(projectId, seatName);
    const pack = fs.readFileSync(pp, 'utf8');
    if (!pack.trim()) return give();
    const next = [...parts];
    if (presetId === 'claude-code') {
      if (next.includes('--system-prompt')) return give(); // 用户自定义整套系统提示 → 不掺和
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
        return give(); // 紧凑写法只有用户手配才会出现 → 不掺和
      } else next.splice(commandStart(next) + 1, 0, '-c', 'developer_instructions=' + JSON.stringify(pack));
    }
    // 旗已按「命令后第一位」拼好，最后把 cmd.exe /c <命令> 三件套换成真身——相对顺序不变。
    // 换不掉就等于章程注定被 cmd 绞碎，宁可不挂旗、走 in-band，也不能挂个残缺的。
    let mode = 'direct';
    if (commandStart(parts) === 2) {
      const target = realTarget(String(parts[2]));
      if (!target) return give();
      next.splice(0, 3, ...target);
      mode = 'unwrapped';
    }
    out.parts = next;
    out.env = { KFQ_GROUP: String(projectId), KFQ_SEAT: String(seatName), KFQ_CHARTER: pp };
    markFlag(projectId, seatName, mode);
    return out;
  } catch { return give(); }
}

module.exports = { DATA, safeId, seatFile, packDir, packPath, flagPath, apply };
