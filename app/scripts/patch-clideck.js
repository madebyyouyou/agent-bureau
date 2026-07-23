// 给全局安装的 CliDeck 打的补丁集（幂等，启动器每次开机执行；clideck 升级后重跑自动再补）。
// 补丁1 版本探测 win shell / 补丁2 codex 钩子 & 前缀 / 补丁3 收工自提交 / 补丁4 ask 场合尾注（v0.6.0 退役，改为擦除）/
// 补丁5 钩子全路径识别 / 补丁6 一轮多段回复收齐（防中途信封丢失）/ 补丁7 席位章程拼进系统提示旗。
// 纯变换函数有导出，单测（test/patch6-transcript.test.js、test/patch7-spawn.test.js）对 vendor 副本套用后做行为验证。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---------- 补丁6：一轮多段回复收齐 ----------
// 根因（2026-07-19 03:13 事故）：上游候选稿机制只保留屏幕上最后一个回复块（collapseAgentTurns
// 丢弃连续 agent 块的前段），一轮"发言→工具→收尾"只有收尾能进转写——成员中途用
// <group_message>/<private_message> 信封发的正式消息整段蒸发。修法：收工提交前，从最后一条
// 注入提示（群消息/私聊/系统广播/发言权/ask/折叠粘贴）往后收齐全部正文块，剔除工具调用块，
// 拼成完整候选稿。菜单中途的提交保持旧行为；认不出锚点或只有一段时也保持旧行为。
// v2（2026-07-19）：补上 codex 版式——版式证据来自真机 TUI 抓屏（codex-cli 0.144.6）：
//   用户回显 "› 【群消息…"+两空格续行；正文块 "• "；工具块 "• Ran node -v"+"  └ v24.16.0"；
//   系统噪音也走 "• "（You have N usage limit…/Running N Stop hooks/Working (Ns…)）须按句式剔除；
//   "⚠ …" 告警行会插在正文块之间且可折行，折行尾巴要跟着跳过。
// 下面这个函数不在本文件运行，只作为源码模板 toString 注入 transcript-candidate.js
//（candidateText / builder 都是那边的模块内变量）。
function kfqExpandSrcFn(id, presetId, lines) {
  if (!Array.isArray(lines)) return;
  let promptRe, agentRe, toolish, noiseRe;
  if (presetId === 'claude-code') {
    promptRe = /^[>❯›]\s*(?:【(?:群消息|私聊|系统广播|发言权)|\[Pasted text|\[CliDeck ask)/;
    agentRe = /^(?:[│ ]\s*)?[⏺•●]\s(.*)$/;
    toolish = b => /^[A-Za-z][\w.-]{0,40}\(/.test(b[0]) || b.some(l => /^\s*[⎿└]/.test(l));
    noiseRe = null; // claude 版式无行级噪音，保持 v1 行为逐字节一致
  } else if (presetId === 'codex') {
    promptRe = /^(?:│\s*)?›\s*(?:【(?:群消息|私聊|系统广播|发言权)|\[Pasted text|\[CliDeck ask)/;
    agentRe = /^(?:│\s*)?•\s(.*)$/;
    toolish = b => /^(?:Ran|Read|Edited|Wrote|Added|Deleted|Searched|Explored|Listed|Viewed|Applied|Called|Updated Plan|Running \d+ Stop hooks?|You have \d+ usage limit|Working \()/.test(b[0])
      || b.some(l => /^\s*[└⎿]/.test(l));
    noiseRe = /^\s*(?:⚠|◦|─{5,}\s*$)|^[\s─—━═-]*Worked\s+for\s+[\dhms\s.]+[\s─—━═-]*$/i;
  } else return;
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (promptRe.test(lines[i])) { promptIdx = i; break; }
  }
  if (promptIdx < 0) return;
  const blocks = [];
  let cur = null;
  let muting = false; // 命中 ⚠ 后进入消音：它的折行尾巴一并跳过，遇空行/新块解除
  for (let i = promptIdx + 1; i < lines.length; i++) {
    const a = lines[i].match(agentRe);
    if (a) { muting = false; if (cur) blocks.push(cur); cur = [a[1]]; continue; }
    if (noiseRe && noiseRe.test(lines[i])) { muting = /^\s*⚠/.test(lines[i]); continue; }
    if (!lines[i].trim()) { muting = false; if (cur) cur.push(lines[i]); continue; }
    if (muting) continue;
    if (!cur) continue;
    let cont = lines[i];
    if (cont.startsWith('│ ')) cont = cont.slice(2);
    else if (cont.startsWith('  ')) cont = cont.slice(2);
    cur.push(cont);
  }
  if (cur) blocks.push(cur);
  const speech = blocks.filter(b => !toolish(b)).map(b => b.join('\n').replace(/\s+$/, '')).filter(t => t.trim());
  if (speech.length < 2) return;
  candidateText[id] = builder.cleanAgentText(presetId, speech.join('\n\n'));
}

// 版式库版本标：注入块换代时（v1→v2…）按通配正则找到旧块原地换新，幂等按当前版本标判断
const P6C_VER = '/*kfq-multi-block@v2*/';
const P6C_ANYRE = /\/\*kfq-multi-block(?:@v\d+)?\*\/[\s\S]*?module\.exports = \{ update, get, clear, kfqExpand \};/;
function patch6Candidate(src) {
  if (src.includes(P6C_VER)) return null;
  const fn = P6C_VER + '\n// 开发部群补丁6：收工前把本轮全部正文块收齐（详见 kaifabuqun/app/scripts/patch-clideck.js）\n'
    + kfqExpandSrcFn.toString().replace('kfqExpandSrcFn', 'kfqExpand') + '\n';
  const patched = fn + 'module.exports = { update, get, clear, kfqExpand };';
  if (P6C_ANYRE.test(src)) return src.replace(P6C_ANYRE, () => patched); // 旧版注入块 → 原地换新
  const anchor = 'module.exports = { update, get, clear };';
  if (!src.includes(anchor)) return undefined;
  return src.replace(anchor, () => patched);
}

const P6H_MARK = '/*kfq-multi-block-commit*/';
function patch6Handlers(src) {
  if (src.includes(P6H_MARK)) return null;
  const anchor = 'sess._finalizeOnIdle = false;\n            transcript.commitAgentCandidate(msg.id, sess.presetId);';
  if (!src.includes(anchor)) return undefined;
  return src.replace(anchor, () => 'sess._finalizeOnIdle = false;\n            '
    + P6H_MARK + ' try { require(\'./transcript-candidate\').kfqExpand(msg.id, sess.presetId, candidateLines); } catch {}\n'
    + '            transcript.commitAgentCandidate(msg.id, sess.presetId);');
}

// ---------- 补丁4退役（v0.6.0）：ask 注入不再带场合尾注 ----------
// 规则住进了系统提示层的章程（《同事协作》节），每次 ask 重复念一遍反而把模型拖进角色扮演。
// 这里只负责把已打过补丁的机器擦回上游原样；从没打过的机器是 no-op。
const P4_RE = /\/\*kfq-ask-tail\*\/const injected = `[^`]*`;/;
const P4_ORIG = 'const injected = `[CliDeck ask from ${caller.name || callerId.slice(0, 8)}]\\n\\n${message}`;';
function patch4Retire(src) {
  if (!P4_RE.test(src)) return null;
  return src.replace(P4_RE, () => P4_ORIG);
}

// ---------- 补丁7：席位章程包拼进系统提示旗 ----------
// spawnSession 是建群/接续/重启/换脑唯一的 spawn 汇合点，且此处 projectId 与会话名（=席位名）齐备。
// 变换做四件事：算出 kfq 改写结果（真正的逻辑在插件目录 kfq-spawn.js，随 robocopy 更新）、
// 用改写后的参数 spawn、并入席位环境、只在 pty.spawn 成功后提交回执。任何失败原样放行并撤销回执。
const P7_MARK = '/*kfq-seat-charter@v2*/';
const P7_OLD_MARK = '/*kfq-seat-charter*/';
function patch7Sessions(src) {
  if (src.includes(P7_MARK)) return null;
  const a1 = 'const extraEnv = commandEnv(cmd);';
  const a2 = 'term = pty.spawn(launchParts[0], launchParts.slice(1), {';
  const a3 = 'env: { ...process.env, ...extraEnv, ...telemetryEnv, ...colorEnv },';
  const oldA2 = 'term = pty.spawn(kfq.parts[0], kfq.parts.slice(1), {';
  const oldA3 = 'env: { ...process.env, ...extraEnv, ...telemetryEnv, ...colorEnv, ...kfq.env },';
  const a4 = '    });\n  } catch (e) {\n    return e;\n  }';
  const withReceipt = '    });\n    try { kfq.commit?.(); } catch {}\n  } catch (e) {\n    try { kfq.rollback?.(); } catch {}\n    return e;\n  }';
  if (src.includes(P7_OLD_MARK)) {
    if (!src.includes(oldA2) || !src.includes(oldA3) || !src.includes(a4)) return undefined;
    return src.replace(P7_OLD_MARK, P7_MARK).replace(a4, () => withReceipt);
  }
  if (!src.includes(a1) || !src.includes(a2) || !src.includes(a3) || !src.includes(a4)) return undefined;
  const inject = a1 + '\n  ' + P7_MARK + ' // 开发部群补丁7：席位章程包拼进系统提示旗（逻辑见插件目录 kfq-spawn.js）\n'
    + '  let kfq = { parts: launchParts, env: {}, commit() {}, rollback() {} };\n'
    + "  try { kfq = require(require('path').join(require('os').homedir(), '.clideck', 'plugins', 'kaifabuqun', 'kfq-spawn.js')).apply(launchParts, preset?.presetId, projectId, name); } catch {}";
  return src.replace(a1, () => inject)
    .replace(a2, () => 'term = pty.spawn(kfq.parts[0], kfq.parts.slice(1), {')
    .replace(a3, () => 'env: { ...process.env, ...extraEnv, ...telemetryEnv, ...colorEnv, ...kfq.env },')
    .replace(a4, () => withReceipt);
}

// ---------- 补丁1：Windows CLI 版本探测 ----------
// Node 24 弃用 shell:true + args（DEP0190）。Windows 改用 execSync 的完整、已校验命令串；
// 非 Windows 仍保留 execFileSync 的 argv 调用。旧版标记会被整段替换为 v2。
const P1_MARK = '/*kfq-win-probe@v2*/';
const P1_OPTS = "{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }";
const P1_OLD_OPTS = "/*kfq-win-probe*/{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }";
const P1_ORIG = `function getInstalledVersion(bin) {
  try { return parseVersion(execFileSync(bin, ['--version'], ${P1_OPTS})); } catch {}
  try { return parseVersion(execFileSync(bin, ['-v'], ${P1_OPTS})); } catch {}
  return '';
}`;
function patch1Probe(src) {
  if (src.includes(P1_MARK)) return null;
  const re = /function getInstalledVersion\(bin\) \{[\s\S]*?\n\}/;
  const block = src.match(re)?.[0];
  if (!block) return undefined;
  const oldNormalized = block.split(P1_OLD_OPTS).join(P1_OPTS);
  if (block !== P1_ORIG && oldNormalized !== P1_ORIG) return undefined;
  const fixed = `function getInstalledVersion(bin) {
  ${P1_MARK}
  const run = flag => {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    if (process.platform !== 'win32') return execFileSync(bin, [flag], opts);
    if (!/^[A-Za-z0-9_.-]+$/.test(bin)) return '';
    return require('child_process').execSync(\`\${bin} \${flag}\`, opts);
  };
  try { return parseVersion(run('--version')); } catch {}
  try { return parseVersion(run('-v')); } catch {}
  return '';
}`;
  return src.replace(re, () => fixed);
}

function main() {
  let root = '';
  try { root = execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch {}
  const file = path.join(root, 'clideck', 'handlers.js');
  if (!root || !fs.existsSync(file)) { console.error('[patch] 找不到已安装的 clideck：' + file); process.exit(2); }

  // 补丁1：CliDeck 在 Windows 上的版本探测——execFileSync 不带 shell 执行不了 npm 的 .cmd 命令，
  // 导致版本永远读不到；v2 同时避开 Node 24 的 shell:true + args 弃用与注入风险。
  let src = fs.readFileSync(file, 'utf8');
  const r1Probe = patch1Probe(src);
  if (r1Probe === null) {
    console.log('[patch] 版本探测补丁已在，跳过');
  } else if (r1Probe === undefined) {
    console.error('[patch] 版本探测补丁失败：目标代码变了（clideck 升级？）');
  } else {
    fs.writeFileSync(file, r1Probe);
    console.log('[patch] 已修补版本探测（Windows 安全 shell 模式）：' + file);
  }

  // 补丁2：codex 钩子命令在 Windows 上需要 PowerShell 调用符 & 前缀，否则 exit 1
  try {
    const hf = path.join(root, 'clideck', 'codex-hooks.js');
    let hsrc = fs.readFileSync(hf, 'utf8');
    const HMARK = '/*kfq-win-hookcmd*/';
    if (hsrc.includes(HMARK)) { console.log('[patch] 钩子命令补丁已在，跳过'); }
    else {
      const target = 'return `"${nodePath}" "${helperPath}" ${port} ${route}`;';
      if (!hsrc.includes(target)) { console.error('[patch] 钩子命令补丁失败：目标行变了（clideck 升级？）'); }
      else {
        hsrc = hsrc.replace(target, HMARK + "return (process.platform === 'win32' ? '& ' : '') + `\"${nodePath}\" \"${helperPath}\" ${port} ${route}`;");
        fs.writeFileSync(hf, hsrc);
        console.log('[patch] 已修补 codex 钩子命令（win32 加 & 前缀）：' + hf);
      }
    }
  } catch (e) { console.error('[patch] 钩子命令补丁异常：' + e.message); }

  // 补丁3：codex 0.144+ 遥测停发，收工提交不能再等遥测事件——钩子报收工后 4 秒无遥测就直接提交
  try {
    const rf = path.join(root, 'clideck', 'telemetry-receiver.js');
    let rsrc = fs.readFileSync(rf, 'utf8');
    const RMARK = '/*kfq-hook-idle*/';
    if (rsrc.includes(RMARK)) { console.log('[patch] 收工自提交补丁已在，跳过'); }
    else {
      const anchor = "function armCodexStop(id) {\n  codexPendingStop.set(id, Date.now());\n  codexOutputDone.delete(id);";
      if (!rsrc.includes(anchor)) { console.error('[patch] 收工自提交补丁失败：armCodexStop 结构变了（clideck 升级？）'); }
      else {
        rsrc = rsrc.replace(anchor, anchor + `
  ${RMARK} setTimeout(() => {
    if (codexPendingStop.has(id) && codexPendingStop.get(id) <= Date.now() - 3900) {
      codexPendingStop.delete(id);
      scheduleCodexIdle(id, 'hook');
      startCodexMenuPoll(id);
    }
  }, 4000);`);
        fs.writeFileSync(rf, rsrc);
        console.log('[patch] 已修补收工自提交（钩子独立成军）：' + rf);
      }
    }
  } catch (e) { console.error('[patch] 收工自提交补丁异常：' + e.message); }

  // 补丁4退役：擦掉旧机器上的 ask 场合尾注（见上方 patch4Retire 注释）
  try {
    const af = path.join(root, 'clideck', 'session-ask.js');
    const r4 = patch4Retire(fs.readFileSync(af, 'utf8'));
    if (r4 === null) console.log('[patch] ask 尾注：无补丁4残留，跳过');
    else { fs.writeFileSync(af, r4); console.log('[patch] 已摘除 ask 场合尾注（补丁4退役）：' + af); }
  } catch (e) { console.error('[patch] ask 尾注摘除异常：' + e.message); }

  // 补丁5：上游 isClideckHook 只按文件名 codex-hook.js 匹配，会把第三方同名钩子（如 Clawd on Desk 的
  // .../Clawd on Desk/.../hooks/codex-hook.js）当自家旧钩子 strip 掉。收紧为"路径里还得有 clideck"——
  // clideck 自家 helper 在 node_modules/clideck/bin/ 下，第三方不会撞上。
  try {
    const cf = path.join(root, 'clideck', 'codex-hooks.js');
    let csrc = fs.readFileSync(cf, 'utf8');
    const CMARK = '/*kfq-hook-fullpath*/';
    if (csrc.includes(CMARK)) { console.log('[patch] 钩子全路径补丁已在，跳过'); }
    else {
      const target = "return typeof hook?.command === 'string' && hook.command.includes('codex-hook.js');";
      if (!csrc.includes(target)) { console.error('[patch] 钩子全路径补丁失败：目标行变了（clideck 升级？）'); }
      else {
        csrc = csrc.replace(target, CMARK + "return typeof hook?.command === 'string' && hook.command.includes('codex-hook.js') && /clideck/i.test(hook.command);");
        fs.writeFileSync(cf, csrc);
        console.log('[patch] 已修补钩子识别（要求路径含 clideck，不再误杀第三方同名钩子）：' + cf);
      }
    }
  } catch (e) { console.error('[patch] 钩子全路径补丁异常：' + e.message); }

  // 补丁6：一轮多段回复收齐（transcript-candidate.js 加收集函数 + handlers.js 收工提交前调用）
  try {
    const tcf = path.join(root, 'clideck', 'transcript-candidate.js');
    const r1 = patch6Candidate(fs.readFileSync(tcf, 'utf8'));
    if (r1 === null) console.log('[patch] 多段收齐补丁(候选稿)已在，跳过');
    else if (r1 === undefined) console.error('[patch] 多段收齐补丁失败：transcript-candidate.js 结构变了（clideck 升级？）');
    else { fs.writeFileSync(tcf, r1); console.log('[patch] 已修补多段回复收齐(候选稿)：' + tcf); }

    const hff = path.join(root, 'clideck', 'handlers.js');
    const r2 = patch6Handlers(fs.readFileSync(hff, 'utf8'));
    if (r2 === null) console.log('[patch] 多段收齐补丁(收工调用)已在，跳过');
    else if (r2 === undefined) console.error('[patch] 多段收齐补丁失败：handlers.js 收工提交处变了（clideck 升级？）');
    else { fs.writeFileSync(hff, r2); console.log('[patch] 已修补多段回复收齐(收工调用)：' + hff); }
  } catch (e) { console.error('[patch] 多段收齐补丁异常：' + e.message); }

  // 补丁7：席位章程上系统提示层。成败写/删 spawn-patch.ok 标记——插件 index.js 以它决定
  // 压缩补发/接续补发/入职全文这些 in-band 注入是否可以省略（标记不在 = 全量兜底，成员绝不会没章程）。
  const okMark = path.join(os.homedir(), '.clideck', 'kaifabuqun', 'spawn-patch.ok');
  try {
    const sf = path.join(root, 'clideck', 'sessions.js');
    const r7 = patch7Sessions(fs.readFileSync(sf, 'utf8'));
    let ok = false;
    if (r7 === null) { console.log('[patch] 席位章程补丁已在，跳过'); ok = true; }
    else if (r7 === undefined) console.error('[patch] 席位章程补丁失败：sessions.js 结构变了（clideck 升级？）——席位退回 in-band 章程注入');
    else { fs.writeFileSync(sf, r7); console.log('[patch] 已修补席位章程注入（spawn 拼系统提示旗）：' + sf); ok = true; }
    fs.mkdirSync(path.dirname(okMark), { recursive: true });
    if (ok) fs.writeFileSync(okMark, 'kfq-seat-charter patched\n');
    else fs.rmSync(okMark, { force: true });
  } catch (e) {
    console.error('[patch] 席位章程补丁异常：' + e.message);
    try { fs.rmSync(okMark, { force: true }); } catch {}
  }
}

module.exports = { patch1Probe, patch4Retire, patch6Candidate, patch6Handlers, patch7Sessions };
if (require.main === module) main();
