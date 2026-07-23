// 开发部群 orchestrator — CliDeck plugin (server side).
// v0.4.0 核心机制：
//   1) 双通道：Agent 常规输出=终端工作日志（只进折叠条）；只有包络 <group_message>/<private_message>/<pass/> 会被程序路由。
//   2) 串行发言权：群消息并行广播给全员消化；发言权由程序按成员顺序（@点名优先）逐个授予，同一时刻只有一人能公开发言。
//   3) 自动回执：程序检测到成员本轮处理收工（CLI 收工信号 + 落稿静默期）即打 ✓，不要求成员回"收到"。
//   4) 快照单次记账：文件改动按"收工提交自身的变更"计一次，不再按窗口差异重复归属。
// v0.5.0 工作目录零足迹：不再往工作目录印任何文件（门牌/章程/角色卡全部取消）。
//   章程与角色卡由程序在入职/更新/压缩后直发注入；源头只存数据目录，并自动备份给老板（成员永远不知道备份在哪）。
// v0.6.0 章程上系统提示层：每席章程包（章程+角色卡）落盘 DATA/packs，补丁7 让上游 spawn 时把它
//   拼进 claude --append-system-prompt / codex -c developer_instructions=（上游 GUIDE 同款机制）——
//   压缩不丢、接续自动换新；每轮注入的场合尾注砍成纯状态标记，对话流里只剩活儿本身。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');
const kfq = require('./kfq-spawn.js'); // packs 路径/消毒的唯一权威（补丁7 在上游 require 同一份）

const DATA = kfq.DATA;
const VERSION = '0.6.3'; // 与前端 app.js 的 EXPECT 保持一致；服务端要重启才生效

const SETTLE = 7000;                 // 收工后等落稿的静默期（codex 的稿子晚到 2~6 秒）
const PROC_TIMEOUT = 15 * 60 * 1000; // 消化阶段单人超时：标 ⏱ 后放行整轮
const CHAIN_TIMEOUT = 10 * 60 * 1000;// 发言阶段单人超时：视为弃权，轮给下一位
const BOOT_QUIET = 8000;             // CLI 开机静默：接回补章程、入职通知、热身放行判定共用（必须锁步）
const RESUME_DEADLINE = 40000;       // 接续热身兜底：到点没等齐也放行排队消息
const READ_TAIL = '\n（阅后即可，系统自动记已读，不用回复）'; // 章程/角色卡直发的收尾契约（与自动回执机制配对）

// ---------- 纯函数（模块级，可单测） ----------
// 单行是否为终端界面噪音（框线/色块/转轮/快捷键提示/状态条/裸转义码）
// 注意：app.js clientChrome 的符号类正则要与这里的第一、二条保持逐字一致
function chromeLine(l) {
  return /^[─—━═_\-=~|│┌┐└┘├┤╭╮╰╯╌·.…\s><*▀▄█▌▐■□▓▒░⠀-⣿]+$/.test(l) ||
    /^[>›❯\s]*[\d;=]+[a-zA-Z](\s*[\d;=]+[a-zA-Z])*$/.test(l) ||
    /^(high|medium|low|max|xhigh)\s*·?\s*\/?effort/i.test(l) ||
    /^[>›❯\s]*Try ["'“”]/.test(l) || // CLI 空闲屏的输入建议占位（claude：> Try "create a util…"）
    /\?\s*for shortcuts|esc to |ctrl\+|shift\+tab|bypass permissions|auto-accept|manual mode on/i.test(l);
}
function isChrome(t) {
  const lines = String(t).split('\n').map(l => l.trim()).filter(Boolean);
  const core = lines.filter(l => !chromeLine(l)).join('').replace(/[^\p{L}\p{N}]/gu, '');
  return core.length < 2;
}
function scrubChrome(t) {
  return String(t).split('\n').filter(l => !chromeLine(l.trim())).join('\n').trim();
}
// CLI 收工横幅（codex："─ Worked for 4m 02s ───…"等）：不是纯符号行，chromeLine 抓不到
const BANNER_RE = /^[\s─—━═-]*worked\s+for\s+[\dhms\s.]+[\s─—━═-]*$/i;
// 首尾清洗：只用于不走信封、直接取终端转写的通道（ask 回答、老板私聊兜底、旧协议【发言】）。
// 信封正文是成员契约：按闭合标签截取、原样入账，绝不清洗（用户拍板）。横幅打印在成员输出结束之后，
// 天然落在闭合标签外面，信封路径本身就挡得住。
function trimBanner(t) {
  const lines = String(t || '').split('\n');
  const noise = l => { const s = l.trim(); return !s || chromeLine(s) || BANNER_RE.test(s); };
  let a = 0, b = lines.length;
  while (a < b && noise(lines[a])) a++;
  while (b > a && noise(lines[b - 1])) b--;
  return lines.slice(a, b).join('\n');
}
// 旧协议兜底（过渡期）：【发言】标记之后的内容
function legacySpeech(t) {
  const parts = String(t).split('【发言】');
  if (parts.length < 2) return null;
  return trimBanner(scrubChrome(parts.slice(1).join('\n'))) || null;
}
// 无信封通道的转写兜底管线（用户拍板的清洗边界）：ask 回答、老板私聊兜底必须走同一条，改边界只改这里
const plainTranscript = t => legacySpeech(t) || trimBanner(scrubChrome(t));
const normTarget = s => String(s || '').replace(/^[@「『"'“]+/, '').replace(/[」』"'”]+$/, '').trim();
// 补丁4（v0.6.0 退役）时代的 ask 场合尾注剥离：新注入不再带尾注，这里只为老会话/老账本兜底
const stripAskTail = t => String(t).replace(/\s*（场合：同事咨询[^）]*）\s*$/, '');
// 协议示例原文不算真发言（防止成员复述章程示例被误提取）
const EXAMPLE_BODIES = new Set(['要说的话', '内容', '正文', '…', '...', '需要其他成员知道的群聊内容', '只发送给指定成员的内容']);
// 包络解析：宽容大小写/空白/代码围栏/中英引号；未闭合不算；正文按闭合标签截取原样入账，绝不清洗
function parseEnvelopes(text) {
  const t = String(text || '').replace(/```[a-zA-Z]*/g, '');
  const out = { group: [], dm: [], pass: false };
  let m;
  const g = /<\s*group_message\s*>([\s\S]*?)<\s*\/\s*group_message\s*>/gi;
  while ((m = g.exec(t))) { const b = m[1].trim(); if (b && !EXAMPLE_BODIES.has(b)) out.group.push(b); }
  // target 可省（私聊信封只通向用户）；带 target 的旧写法与在场成员的旧习惯继续兼容，写了成员名仍会被 routeDm 拦下
  const d = /<\s*private_message(?:\s+target\s*=\s*["'“”「『]?([^"'“”「』」>\s]+)["'“”』」]?)?\s*>([\s\S]*?)<\s*\/\s*private_message\s*>/gi;
  while ((m = d.exec(t))) { const b = m[2].trim(); if (b && !EXAMPLE_BODIES.has(b)) out.dm.push({ target: normTarget(m[1]), text: b }); }
  if (/<\s*pass\s*\/?\s*>|\[PASS\]/i.test(t)) out.pass = true;
  return out;
}
// 收稿去重：上游同一轮可能提交两次（权限菜单弹出时先交一段、收工再交全量，后者包含前者）——
// 重段只留最长的，防止信封被解析两次导致重发；完全相同的重复稿也只留一份
function dedupeParts(parts) {
  return parts.filter((p, i) => p && parts.indexOf(p) === i && !parts.some((q, j) => j !== i && q && q.length > p.length && q.includes(p)));
}
// 发言顺序：@点名（出现顺序）优先，其余按默认成员顺序；消息作者除外
function orderChain(names, text, author) {
  const sorted = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
  const ats = [];
  const t = String(text || '');
  let i = -1;
  while ((i = t.indexOf('@', i + 1)) !== -1) {
    const hit = sorted.find(n => t.startsWith(n, i + 1));
    if (hit && !ats.includes(hit)) ats.push(hit);
  }
  return [...ats, ...names.filter(n => !ats.includes(n))].filter(n => n !== author);
}

module.exports = { init, _test: { parseEnvelopes, orderChain, legacySpeech, isChrome, trimBanner, plainTranscript, dedupeParts, stripAskTail } };

function init(api) {
  fs.mkdirSync(DATA, { recursive: true });
  const rooms = new Map();      // projectId -> room state
  const menus = new Set();      // sessionIds with an open approval menu

  const room = pid => {
    if (!rooms.has(pid)) rooms.set(pid, {
      fuse: 0, paused: false,
      queues: new Map(),        // sessionId -> [{text, meta}]
      lastIn: new Map(),        // sessionId -> {kind:'group'|'dm'|'ask'|'raw', from, mid, round, grant}
      openTurn: new Map(),      // sessionId -> {turnId, baseline, member, ts}
      turns: [], seq: 0,
      round: null,              // 当前轮 {mid, from, text, chain:[{id,name}], slot, phase, receipts, captured, awaitId, deadline, start}
      roundQ: [],               // 排队等待广播的消息 [{mid, from, text}]
      resuming: null,           // 接续热身 {names: Map(name->liveAt), deadline, timer}：成员带记忆接回期间压住传阅
      notes: new Map(),         // sessionId -> 下次注入时捎带的提示（如"越权发言被拦"）
      acked: new Set(),         // "sessionId|mid" 回执去重
    });
    return rooms.get(pid);
  };
  const fuseLimit = () => Number(api.getSetting('fuseLimit') || 6);
  const bossName = () => String(api.getSetting('bossName') || '用户').trim().slice(0, 12) || '用户';
  const newMid = pid => 'm' + Date.now() + '-' + (room(pid).seq++); // 消息编号（跨端契约：回执靠它吸附气泡），只在这里铸造
  // 熔断状态只直播不入账：账本里没有它的读者（前端 visible 过滤、重连从 state 取），别烧 tail 窗口
  const pushFuse = pid => { const r = room(pid); api.sendToFrontend('chat', { ev: { kind: 'fuse', ts: Date.now(), projectId: pid, fuse: r.fuse, paused: r.paused, limit: fuseLimit() } }); };

  // ---------- 聊天日志（我们自己的群消息流，与上游 transcript 分开） ----------
  const safeId = kfq.safeId; // 账本/群档案/章程包共用的文件名消毒（权威在 kfq-spawn.js，补丁7 在上游按同键寻址）
  const jpath = pid => path.join(DATA, safeId(pid) + '.jsonl');
  const jsize = new Map(); // pid -> 账本字节数（近似）：raw-agent 会让它无界膨胀，超限重写为最近一段，防 hello/tail/备份按月变慢
  function emit(pid, ev) {
    ev.ts = Date.now(); ev.projectId = pid;
    try {
      const f = jpath(pid), line = JSON.stringify(ev) + '\n';
      if (!jsize.has(pid)) { try { jsize.set(pid, fs.statSync(f).size); } catch { jsize.set(pid, 0); } }
      fs.appendFileSync(f, line);
      jsize.set(pid, jsize.get(pid) + Buffer.byteLength(line));
      if (jsize.get(pid) > 8 * 1024 * 1024) { // 8MB ≈ 数周活跃量
        const keep = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-2000).join('\n') + '\n';
        fs.writeFileSync(f, keep);
        jsize.set(pid, Buffer.byteLength(keep));
      }
    } catch {}
    api.sendToFrontend('chat', { ev });
  }
  function tail(pid, n = 400) {
    try {
      return fs.readFileSync(jpath(pid), 'utf8').trim().split('\n').slice(-n)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // ---------- git 快照 ----------
  function git(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  // isRepo 挡在每次注入的 startTurn 热路径上，而它对同一路径是不变量——缓存住，别每次都 spawn git（Windows 下单次 40-120ms）
  // 只有 gitInit() 会改变它；外部手动 git init 的边缘情况重启服务器即可
  const repoOk = new Map(); // path -> bool
  function isRepo(p) {
    if (!repoOk.has(p)) { let v; try { git(p, ['rev-parse', '--is-inside-work-tree']); v = true; } catch { v = false; } repoOk.set(p, v); }
    return repoOk.get(p);
  }
  function gitInit(dir, label) { try { git(dir, ['init']); repoOk.set(dir, true); snap(dir, label); } catch {} }
  function head(p) { try { return git(p, ['rev-parse', 'HEAD']); } catch { return null; } }
  // 只在工作区真有变化时提交；返回当前 HEAD
  function snap(p, label) {
    try {
      if (git(p, ['status', '--porcelain'])) {
        git(p, ['add', '-A']);
        try { git(p, ['-c', 'user.name=kaifabuqun', '-c', 'user.email=snap@local', 'commit', '-m', 'snap: ' + label]); } catch {}
      }
      return head(p);
    } catch { return null; }
  }
  // 该提交自身携带的变更（相对链上前一个提交）——每次物理改动只被记一次
  // core.quotepath=false：不然中文文件名会显示成 \345\272\227 这类八进制转义
  function commitFiles(p, c) {
    try { const out = git(p, ['-c', 'core.quotepath=false', 'show', '--name-only', '--format=', c]); return out ? out.split('\n').filter(Boolean) : []; } catch { return []; }
  }

  const projPath = pid => { const pr = (api.getProjects() || []).find(x => x.id === pid); return pr && pr.path; };
  const members = pid => api.getSessions().filter(s => s.projectId === pid && s.presetId !== 'shell' && s.commandId);

  // ---------- 投递（bracketed paste + 回车；忙/有菜单/有在途轮次/稿子未落 → 排队） ----------
  function inject(id, text) {
    const CH = 60000;
    for (let i = 0; i < text.length; i += CH) api.inputToSession(id, '\x1b[200~' + text.slice(i, i + CH) + '\x1b[201~');
    // codex 贴大段文本时 TUI 消化慢，回车太早会被吞（用户实测要手动补回车）——
    // 照上游 clideck ask 的方案：回车按长度晚点打；1.5s 后还没动工且无菜单再补一发（空提示符多个回车无害）
    const d = Math.min(2500, Math.max(500, 300 + Math.ceil(text.length / 80) * 100));
    setTimeout(() => api.inputToSession(id, '\r'), d);
    setTimeout(() => {
      const s = api.getSession(id);
      if (s && !s.working && !menus.has(id)) api.inputToSession(id, '\r');
    }, d + 1500);
  }
  // 回声登记：上游会把注入文本按行拆成 user 条目（transcript.js recordInjectedInput），逐行登记吞掉
  const echo = new Map();     // sessionId -> {lines:Set, until:ts}
  const askGrace = new Map(); // sessionId -> ts（ask 注入多行余波的忽略窗口）
  function markInjected(id, text) {
    const e = echo.get(id) || { lines: new Set(), until: 0 };
    for (const raw of String(text).split(/\r?\n/)) { const l = raw.trim(); if (l) e.lines.add(l); }
    if (e.lines.size > 600) e.lines = new Set([...e.lines].slice(-300));
    e.until = Date.now() + 10 * 60 * 1000;
    echo.set(id, e);
  }
  function isEcho(id, line) {
    const e = echo.get(id);
    if (!e) return false;
    if (Date.now() > e.until) { echo.delete(id); return false; }
    const t = String(line).trim();
    if (e.lines.has(t)) return true;
    for (const l of e.lines) if (l.length > 10 && t.includes(l)) return true; // 按键粘连的回声
    return false;
  }
  // ---------- 唯一投递出口（v0.3.0 原则不变） ----------
  // 所有消息只能"入队"；全系统唯一有注入权的是 pump()。事件与看门狗只有"提醒权"。
  const pumpTimers = new Map(); // sessionId -> 静默确认期定时器（存在 = 已预约一次投递，天然防重入）
  function deliver(pid, sessionId, text, meta) { // 名字保留，语义 = 入队 + 提醒
    if (!api.getSession(sessionId)) return;
    const r = room(pid);
    if (!r.queues.has(sessionId)) r.queues.set(sessionId, []);
    r.queues.get(sessionId).push({ text, meta });
    pump(sessionId);
  }
  function eligible(id) {
    const s = api.getSession(id);
    if (!s || !s.projectId) return false;
    const r = room(s.projectId);
    if (s.working || menus.has(id) || r.openTurn.has(id) || bufs.has(id)) return false; // bufs：上一轮稿子还没定稿，先别注入新的
    return (r.queues.get(id) || []).length > 0;
  }
  function pump(id) {
    if (pumpTimers.has(id) || !eligible(id)) return;
    pumpTimers.set(id, setTimeout(() => {
      pumpTimers.delete(id);
      if (!eligible(id)) return;             // 静默期内情况有变 → 放弃；消息原封不动躺在队列里等下次提醒
      const s = api.getSession(id);
      const pid = s.projectId, r = room(pid);
      const item = r.queues.get(id).shift(); // 取件与注入同一瞬间，不存在"取了没发"的中间态
      const note = r.notes.get(id);
      if (note) { r.notes.delete(id); item.text = note + '\n' + item.text; } // 捎带提示，不单独烧一轮
      r.lastIn.set(id, item.meta || { kind: 'group', from: '' });
      markInjected(id, item.text);
      startTurn(pid, id);                    // 在途轮次立即挂起 → eligible 变 false → pump 天然互斥
      inject(id, item.text);
    }, 1200));                               // 静默确认期：预约与出手各核对一次，防菜单探测闪烁
  }
  function startTurn(pid, sessionId) {
    const r = room(pid);
    const s = api.getSession(sessionId);
    const p = projPath(pid);
    const g0 = loadGroup(pid);
    const snapOn = !g0 || g0.snapshot !== false;
    const baseline = (snapOn && p && isRepo(p)) ? head(p) : null; // 只记锚点，不再产生 before 提交
    r.openTurn.set(sessionId, { turnId: 't' + Date.now() + '-' + (r.seq++), baseline, member: s ? s.name : sessionId, ts: Date.now() });
  }

  // 菜单出现/消失：只更新状态 + 提醒 pump
  if (api.onMenuDetected) api.onMenuDetected((id, choices) => {
    const has = Array.isArray(choices) ? choices.length > 0 : !!choices;
    if (has) menus.add(id); else { menus.delete(id); pump(id); }
  });

  // ---------- 场合标记（v0.6.0 瘦身）：规则全部住在章程（系统提示层），每轮只带纯状态——
  // 唯一保留格式提示的时刻是"授权那一瞬间"（全流程里格式唯一要紧的时刻），其余场合零尾注，
  // 防止反复的教学语言把模型拖进"扮演公司职员"的元认知（对不太聪明的模型尤其致命）。
  const HOLDER_TAIL = '（轮到你发言：<group_message>要说的话</group_message>；无补充 <pass />）';
  // 群消息注入的统一框架：新发（startRound）与队列改写（resolveSlot 授权）必须逐字一致，WRAP 回声兜底也认这个前缀
  const groupMsgText = (from, text, holder) => '【群消息｜' + from + '】\n' + text + (holder ? '\n' + HOLDER_TAIL : '');
  const grantText = name => '【发言权】' + name + '，轮到你对刚才那条群消息发言：<group_message>要说的话</group_message>；无补充 <pass />。';

  // ---------- 轮次调度（发言权串行授予） ----------
  // 当前持权工位（唯一权威，别在别处重新推导）：消化阶段=链首（随广播自动授权），发言阶段=被授权等待的那位
  const holderOf = rd => rd.phase === 'processing' ? ((rd.chain[0] || {}).id || null) : rd.awaitId;
  function viewRound(pid) {
    const r = room(pid); const rd = r.round;
    if (!rd) {
      if (r.resuming) return { warmup: true, waiting: [...r.resuming.names].filter(([, at]) => !at).map(([n]) => n), queued: r.roundQ.length };
      return r.roundQ.length ? { queued: r.roundQ.length } : null;
    }
    const done = [], pending = [];
    for (const c of rd.chain) ((rd.receipts.get(c.id) === 'pending') ? pending : done).push(c.name);
    const holder = (rd.chain[rd.slot] || {}).name;
    return { mid: rd.mid, phase: rd.phase, holder, done, pending, total: rd.chain.length, queued: r.roundQ.length };
  }
  const pushRound = pid => api.sendToFrontend('round', { projectId: pid, round: viewRound(pid) });

  function chainFor(pid, text, author) {
    const g = loadGroup(pid);
    const live = members(pid);
    const byName = new Map(live.map(s => [s.name, s]));
    const names = ((g && g.members) || []).map(m => m.seatName).filter(n => byName.has(n));
    for (const s of live) if (!names.includes(s.name)) names.push(s.name); // 没档案的在岗成员排最后
    return orderChain(names, text, author).map(n => ({ id: byName.get(n).id, name: n }));
  }
  // 开一轮：并行广播给链上所有人；chain[0] 随消息直接拿到发言权（省一次注入）
  function startRound(pid, msg) {
    const r = room(pid);
    const chain = chainFor(pid, msg.text, msg.from);
    if (!chain.length) { pushRound(pid); return false; }
    r.round = { mid: msg.mid, from: msg.from, text: msg.text, chain, slot: 0, phase: 'processing', receipts: new Map(chain.map(c => [c.id, 'pending'])), captured: null, awaitId: null, deadline: 0, start: Date.now() };
    for (const c of chain) {
      deliver(pid, c.id, groupMsgText(msg.from, msg.text, c.id === chain[0].id),
        { kind: 'group', from: msg.from, mid: msg.mid, round: msg.mid });
    }
    pushRound(pid);
    return true;
  }
  function drainQ(pid) {
    const r = room(pid);
    while (!r.round && !r.resuming && r.roundQ.length) startRound(pid, r.roundQ.shift());
    pushRound(pid);
  }
  function advance(pid) {
    const r = room(pid); const rd = r.round;
    if (!rd) return;
    if (rd.phase === 'processing') {
      if ([...rd.receipts.values()].some(v => v === 'pending')) { pushRound(pid); return; }
      rd.phase = 'chaining';
      resolveSlot(pid);
    } else resolveSlot(pid);
  }
  function resolveSlot(pid) {
    const r = room(pid); const rd = r.round; if (!rd) return;
    const cap = rd.captured; rd.captured = null;
    const cur = rd.chain[rd.slot];
    if (cap && cur && cap.id === cur.id && cap.group) { publish(pid, cur, cap.group); return; }
    rd.slot++;
    // 死工位轮空；消化时已明确 <pass /> 的也轮空——TA 对这条没有补充，别再烧一轮授权
    while (rd.slot < rd.chain.length && (!api.getSession(rd.chain[rd.slot].id) || rd.receipts.get(rd.chain[rd.slot].id) === 'passed')) rd.slot++;
    if (rd.slot >= rd.chain.length) { finishRound(pid); return; }
    const nxt = rd.chain[rd.slot];
    rd.awaitId = nxt.id;
    rd.deadline = Date.now() + CHAIN_TIMEOUT;
    // 授权尽量不烧单独一轮：这条消息的广播还躺在 TA 队列里没注入 → 原地改写成"有发言权"版
    const held = (r.queues.get(nxt.id) || []).find(x => x.meta && x.meta.mid === rd.mid && x.meta.kind === 'group' && !x.meta.grant);
    if (held) {
      held.text = groupMsgText(rd.from, rd.text, true);
      held.meta.grant = true;
    } else deliver(pid, nxt.id, grantText(nxt.name), { kind: 'group', from: '系统', mid: rd.mid, round: rd.mid, grant: true });
    pushRound(pid);
  }
  // 成员正式发言：入账 → 熔断记数 → 作为新消息开下一轮
  function publish(pid, member, body) {
    const r = room(pid);
    r.round = null;
    const mid = newMid(pid);
    emit(pid, { kind: 'msg', scope: 'group', mid, from: member.name, sessionId: member.id, text: body });
    if (r.paused) { emit(pid, { kind: 'sys', text: '熔断中：这条发言已入账但未广播，放行后可复制重发。' }); drainQ(pid); return; }
    r.fuse++;
    pushFuse(pid);
    if (r.fuse >= fuseLimit()) {
      r.paused = true;
      pushFuse(pid);
      emit(pid, { kind: 'sys', text: '连续 ' + r.fuse + ' 条成员发言没有你插话，已熔断暂停广播。点熔断条放行。' });
      drainQ(pid); return;
    }
    startRound(pid, { mid, from: member.name, text: body }) || drainQ(pid);
  }
  function finishRound(pid) {
    const r = room(pid);
    r.round = null;
    emit(pid, { kind: 'sys', text: '这条消息全员已读完毕，无人再补充。' });
    drainQ(pid);
  }

  // ---------- 收稿缓冲：一轮的稿子攒齐再定稿（回执 + 包络提取一次完成） ----------
  const bufs = new Map(); // sessionId -> {pid, parts:[], meta, timer}
  function bufAdd(pid, id, tx, meta) {
    let b = bufs.get(id);
    if (b && (b.meta.mid !== meta.mid || b.meta.kind !== meta.kind)) { finalizeTurn(id); b = null; }
    if (!b) { b = { pid, parts: [], meta: Object.assign({}, meta), timer: null }; bufs.set(id, b); }
    b.parts.push(tx);
    if (!(api.getSession(id) || {}).working) armFinalize(id);
  }
  function armFinalize(id) {
    const b = bufs.get(id); if (!b) return;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => finalizeTurn(id), SETTLE);
  }
  function ensureBuf(pid, id, meta) { // 空轮（没落稿）也要能定稿打回执
    if (!bufs.has(id)) bufs.set(id, { pid, parts: [], meta: Object.assign({}, meta), timer: null });
    armFinalize(id);
  }
  function ackOnce(pid, id, name, mid, scope, timeout) {
    const r = room(pid);
    if (!mid || r.acked.has(id + '|' + mid)) return;
    if (r.acked.size > 4000) r.acked.clear();
    r.acked.add(id + '|' + mid);
    const ev = { kind: 'receipt', member: name, sessionId: id, auto: true, text: '', ackOf: mid };
    if (scope === 'dm') ev.scope = 'dm';
    if (timeout) ev.timeout = true;
    emit(pid, ev);
  }
  // 私聊信封只通向用户本人；写了成员名的一律拦下（同事之间的正路是 clideck ask），内容转用户留档、捎带提醒发件人
  function routeDm(pid, fromId, fromName, target, text) {
    const boss = bossName();
    if (!target || target === boss || /^(老板|boss)$/i.test(target)) {
      emit(pid, { kind: 'msg', scope: 'dm', from: fromName, sessionId: fromId, text });
      return;
    }
    emit(pid, { kind: 'msg', scope: 'dm', from: fromName, sessionId: fromId, text: '（这条本想私发「' + target + '」，已被拦下——同事之间请用 clideck ask。内容转你留档：）\n' + text });
    room(pid).notes.set(fromId, '（提醒：<private_message> 只通向' + boss + '，不用写 target。找同事请在终端直接执行 clideck ask <成员名> "问题"。你发给「' + target + '」的那条没有送出，需要的话请改用 ask 重新联系TA。）');
  }
  function finalizeTurn(id) {
    const b = bufs.get(id); if (!b) return;
    clearTimeout(b.timer);
    bufs.delete(id);
    const pid = b.pid, r = room(pid);
    const s = api.getSession(id);
    const name = s ? s.name : (b.meta.from || '?');
    const meta = b.meta || { kind: 'raw' };
    const text = dedupeParts(b.parts).join('\n');
    const env = parseEnvelopes(text);
    if (!s) { pump(id); return; }

    if (meta.kind === 'dm') {
      ackOnce(pid, id, name, meta.mid, 'dm');
      let replied = false;
      for (const d of env.dm) { routeDm(pid, id, name, d.target, d.text); replied = true; }
      if (env.group.length) r.notes.set(id, '（提醒：私聊场合发的 <group_message> 不会进群。想公开说，等群聊轮到你发言时再发。）');
      if (!replied && !env.pass && meta.from === bossName()) {
        // 老板私聊保持宽松兜底：没打包络也把去噪正文当回复，防"已读不回"
        const plain = trimBanner(legacySpeech(text) || scrubChrome(text));
        if (plain && !isChrome(plain)) emit(pid, { kind: 'msg', scope: 'dm', from: name, sessionId: id, text: plain });
      }
      pump(id);
      return;
    }
    if (meta.kind !== 'group') { pump(id); return; }

    ackOnce(pid, id, name, meta.mid, 'group');
    for (const d of env.dm) routeDm(pid, id, name, d.target, d.text); // 对用户的私聊包络任何阶段都放行（不吵群）
    const rd = r.round;
    const inRound = rd && meta.round === rd.mid;
    const isHolder = inRound && holderOf(rd) === id;
    const groupBody = env.group.length ? env.group.join('\n\n') : (meta.grant || isHolder ? legacySpeech(text) : null); // 旧协议只对持权人兜底
    if (env.group.length && !isHolder) r.notes.set(id, '（提醒：你上一轮的 <group_message> 当时没有发言权，已被拦下没有送出。轮到你发言时请重新组织发出。）');
    if (inRound) {
      if (rd.phase === 'processing') {
        if (rd.receipts.get(id) === 'pending') rd.receipts.set(id, env.pass ? 'passed' : 'done'); // 明确 <pass /> 的成员这条消息上轮空，不再单独授权
        // 交稿立刻上屏（用户拍板）：不等其他人读完；读这条新发言的轮次由 publish→startRound 自然开出
        if (isHolder && groupBody) { publish(pid, { id, name }, groupBody); pump(id); return; }
        advance(pid);
      } else if (rd.awaitId === id) {
        rd.awaitId = null;
        rd.captured = { id, group: groupBody };
        advance(pid);
      }
    }
    pump(id);
  }

  // ---------- 看门狗：提醒 pump、释放卡死轮次、清理死工位、执行轮次超时 ----------
  setInterval(() => {
    try {
      for (const [pid, r] of rooms) {
        for (const [id, t] of r.openTurn) {
          if (Date.now() - (t.ts || 0) > 600000 && !(api.getSession(id) || {}).working) r.openTurn.delete(id);
        }
        const rd = r.round;
        if (rd && rd.phase === 'processing') {
          let changed = false;
          for (const c of rd.chain) {
            if (rd.receipts.get(c.id) !== 'pending') continue;
            const dead = !api.getSession(c.id);
            if (dead || Date.now() - rd.start > PROC_TIMEOUT) {
              rd.receipts.set(c.id, 'timeout');
              if (!dead) ackOnce(pid, c.id, c.name, rd.mid, 'group', true);
              changed = true;
            }
          }
          if (changed) advance(pid);
        } else if (rd && rd.phase === 'chaining' && rd.awaitId && (Date.now() > rd.deadline || !api.getSession(rd.awaitId))) {
          rd.awaitId = null; rd.captured = null;
          resolveSlot(pid); // 视为弃权，轮给下一位
        }
        for (const id of [...r.queues.keys()]) pump(id);
      }
      for (const id of [...bufs.keys()]) if (!api.getSession(id)) bufs.delete(id);
      // 死工位（换脑/移除后旧 id 不复活）的注入痕迹一并回收，长驻进程不留渣
      for (const m of [echo, askGrace, compactAt]) for (const id of [...m.keys()]) if (!api.getSession(id)) m.delete(id);
      for (const [, r] of rooms) for (const m of [r.lastIn, r.queues, r.notes]) for (const id of [...m.keys()]) if (!api.getSession(id)) m.delete(id);
    } catch {}
  }, 15000);

  // ---------- 状态变化：收轮（快照单次记账）、定稿计时 ----------
  api.onStatusChange((id, working, source) => {
    if (working) {
      menus.delete(id);
      const b = bufs.get(id); // 又忙起来了（状态抖动/连续动作）→ 撤掉定稿倒计时，等真正收工再定稿
      if (b && b.timer) { clearTimeout(b.timer); b.timer = null; }
      return;
    }
    if (source === 'menu') { menus.add(id); return; }   // 菜单挂起 ≠ 本轮结束
    const s = api.getSession(id);
    const pid = s && s.projectId;
    if (!pid) return;
    const r = room(pid);
    const t = r.openTurn.get(id);
    if (t) {
      r.openTurn.delete(id);
      const p = projPath(pid);
      if (t.baseline !== null && p) {
        const h0 = head(p);
        const after = snap(p, 'after ' + t.member);
        const files = (after && after !== h0) ? commitFiles(p, after) : []; // 只算这次提交自带的变更 → 一次改动只记一次
        if (files.length) {
          const others = [...r.openTurn.keys()].map(x => (api.getSession(x) || {}).name).filter(Boolean); // 同窗口还在干活的人
          const turn = { turnId: t.turnId, member: t.member, sessionId: id, baseline: t.baseline, after, files, others };
          r.turns.push(turn); if (r.turns.length > 200) r.turns.shift();
          emit(pid, { kind: 'turn', turnId: turn.turnId, member: turn.member, files, others });
          for (const px of r.turns.slice(-8, -1)) {
            if (px.sessionId === id) continue;
            const overlap = px.files.filter(f => files.includes(f));
            if (overlap.length) { emit(pid, { kind: 'conflict', a: px.member, b: t.member, files: overlap }); break; }
          }
        }
      }
    }
    // 收工 ≠ 定稿：稿子（transcript）可能晚到几秒，静默期攒齐后统一定稿（打回执/提包络）
    const last = r.lastIn.get(id) || {};
    if (bufs.has(id)) armFinalize(id);
    else if (last.kind === 'group' || last.kind === 'dm') ensureBuf(pid, id, last);
    pump(id); // 状态变闲只是"提醒"——投递与否由唯一出口 pump 自己判断
  });

  // ---------- 对话轮次 → 双通道分流 ----------
  const WRAP = /^【(群消息|私聊|系统广播|发言权)(｜([^】]+))?】/;
  api.onTranscriptEntry((id, role, text) => {
    const s = api.getSession(id);
    if (!s || !s.projectId) return;
    const pid = s.projectId;
    const r = room(pid);
    const tx = String(text || '');

    if (role === 'user') {
      if (isEcho(id, tx)) return; // 我们注入内容的按行回声，吞掉（lastIn 注入时已定）
      const ask = tx.match(/^\[CliDeck ask from ([^\]]+)\]\s*/);
      if (ask) {
        r.lastIn.set(id, { kind: 'ask', from: ask[1] });
        askGrace.set(id, Date.now() + 2000);
        const asker = members(pid).find(x => x.name === ask[1]); // 补上双方 id：成员私聊窗按 id 过滤旁听内容
        emit(pid, { kind: 'listen', from: ask[1], fromId: asker && asker.id, to: s.name, toId: id, text: stripAskTail(tx.replace(ask[0], '')) }); // 旁听只看正文；老会话残留的补丁4尾注顺手剥掉
        return;
      }
      if (askGrace.get(id) > Date.now()) return; // ask 注入多行的余波
      const w = tx.match(WRAP);
      if (w) { r.lastIn.set(id, { kind: w[1] === '私聊' ? 'dm' : 'group', from: w[3] || '' }); return; } // 兜底：服务端重启前旧注入的回声
      r.lastIn.set(id, { kind: 'raw' });
      emit(pid, { kind: 'raw-user', member: s.name, sessionId: id, text: tx });
      return;
    }

    // agent 输出：一律先当终端工作日志落折叠条；正式消息等定稿时按包络提取
    if (isChrome(tx)) return; // TUI 界面噪音（分割线/状态条/快捷键提示），哪儿都不进
    // 上下文压缩迹象（各家 CLI 提示语，尽力识别）→ 自动补发章程，防断片后忘身份忘协议；限频防误判连发
    if (COMPACT_RE.test(tx) && !flagInjected(id) && r.lastIn.has(id) && Date.now() - (compactAt.get(id) || 0) > 10 * 60 * 1000) {
      compactAt.set(id, Date.now()); // 系统提示层席位免疫压缩（system prompt 不参与压缩），只有 in-band 席位才需要补发
      recharter(pid, id, '检测到你的上下文刚被压缩，给你重新同步一份团队章程与你的角色卡，以此为准。');
    }
    const last = r.lastIn.get(id) || { kind: 'raw' }; // 没跟它说过话 → 屏幕内容不算发言
    if (menus.has(id) || last.kind === 'raw') {
      emit(pid, { kind: 'raw-agent', member: s.name, sessionId: id, text: tx.slice(0, 4000) });
      return;
    }
    if (last.kind === 'ask') {
      const env = parseEnvelopes(tx);
      const asker = members(pid).find(x => x.name === last.from);
      emit(pid, { kind: 'listen-reply', from: s.name, fromId: id, to: last.from, toId: asker && asker.id, text: env.dm.length ? env.dm.map(d => d.text).join('\n') : trimBanner(legacySpeech(tx) || scrubChrome(tx)) });
      return;
    }
    // group / dm：进折叠工作日志 + 入定稿缓冲
    emit(pid, { kind: 'raw-agent', member: s.name, sessionId: id, text: tx.slice(0, 4000) });
    bufAdd(pid, id, tx, last);
  });

  // ---------- 前端指令 ----------
  function sendState(pid) {
    const r = room(pid);
    const gm = ((loadGroup(pid) || {}).members || []).map(x => ({ seatName: x.seatName, identity: x.identity || '', avatar: x.avatar || '' }));
    api.sendToFrontend('state', { projectId: pid, version: VERSION, bossName: bossName(), backupDir: backupDir(), members: gm, journal: tail(pid), fuse: r.fuse, paused: r.paused, limit: fuseLimit(), round: viewRound(pid) });
  }
  api.onFrontendMessage('hello', msg => { if (msg.projectId) sendState(msg.projectId); });

  // 手动清理聊天记录：mode 'sys' 只清系统动态（上岗/广播线、工作日志折叠条）及其回执；'all' 全部清空。
  api.onFrontendMessage('journalClear', msg => {
    const { projectId: pid, mode } = msg;
    if (!pid) return;
    try {
      if (mode === 'all') {
        backupNow(); // 不可恢复操作，先把清空前的账本盖进备份
        fs.writeFileSync(jpath(pid), '');
      } else {
        const NOISE = new Set(['sys', 'raw-user', 'raw-agent', 'fuse']); // fuse：v0.5.9 起不再落账本，这里顺手清历史死行
        const sysMids = new Set();
        const kept = [];
        for (const e of tail(pid, 100000)) {
          if (NOISE.has(e.kind)) { if (e.mid) sysMids.add(e.mid); continue; }
          kept.push(e);
        }
        const final = kept.filter(e => !(e.kind === 'receipt' && e.ackOf && sysMids.has(e.ackOf)));
        fs.writeFileSync(jpath(pid), final.map(e => JSON.stringify(e)).join('\n') + (final.length ? '\n' : ''));
      }
      jsize.delete(pid); // 文件被重写，字节计数下次 emit 时重新 stat
      sendState(pid);
      okOp('journalClear', { mode });
    } catch (e) { noOp('journalClear', String(e.message || e).slice(0, 200)); }
  });

  api.onFrontendMessage('send', msg => {
    const { projectId: pid, scope, targetId, text } = msg;
    if (!pid || !text) return;
    const r = room(pid);
    const mid = newMid(pid);
    if (scope === 'dm' && targetId) {
      const t = api.getSession(targetId);
      emit(pid, { kind: 'boss', scope: 'dm', mid, dmWith: targetId, dmName: t && t.name, text });
      deliver(pid, targetId, '【私聊｜' + bossName() + '】\n' + text, { kind: 'dm', from: bossName(), mid }); // 头标即场合，回复格式在章程里（老板私聊另有无信封宽松兜底）
      return;
    }
    r.fuse = 0; r.paused = false;
    emit(pid, { kind: 'boss', scope: 'group', mid, text });
    pushFuse(pid);
    const m0 = { mid, from: bossName(), text };
    if (r.round || r.resuming) { r.roundQ.push(m0); pushRound(pid); } // 热身期消息排队，成员接回就位后开始传阅
    else startRound(pid, m0);
  });

  api.onFrontendMessage('resumeFanout', msg => {
    const r = room(msg.projectId);
    r.paused = false; r.fuse = 0;
    pushFuse(msg.projectId);
    drainQ(msg.projectId);
  });

  api.onFrontendMessage('revertTurn', msg => {
    const { projectId: pid, turnId } = msg;
    const r = room(pid); const t = r.turns.find(x => x.turnId === turnId); const p = projPath(pid);
    if (!t || !p) return api.sendToFrontend('oper', { ok: false, op: 'revert', turnId, error: '找不到该轮或项目目录不是 git 仓库' });
    try {
      git(p, ['-c', 'user.name=kaifabuqun', '-c', 'user.email=snap@local', 'revert', '--no-edit', t.after]);
      emit(pid, { kind: 'reverted', turnId, member: t.member, files: t.files });
      bcast(pid, '更正声明：' + bossName() + '已撤销「' + t.member + '」那一轮的文件改动（' + t.files.join('、') + '），其余改动不受影响，请以当前工作区为准。');
      api.sendToFrontend('oper', { ok: true, op: 'revert', turnId });
    } catch (e) {
      try { git(p, ['revert', '--abort']); } catch {}
      api.sendToFrontend('oper', { ok: false, op: 'revert', turnId, error: '该轮文件与后续改动重叠，无法单独撤销。可改用「回到此刻」或喊 Claude 手工处理。' });
    }
  });

  api.onFrontendMessage('resetTo', msg => {
    const { projectId: pid, turnId } = msg;
    const r = room(pid); const t = r.turns.find(x => x.turnId === turnId); const p = projPath(pid);
    if (!t || !p || !t.baseline) return api.sendToFrontend('oper', { ok: false, op: 'reset', turnId, error: '找不到目标快照' });
    try {
      git(p, ['reset', '--hard', t.baseline]);
      emit(pid, { kind: 'resetTo', turnId, member: t.member });
      bcast(pid, '更正声明：工作区已整体回退到「' + t.member + '」那一轮开始之前，此后所有文件改动作废，请以当前工作区为准。');
      api.sendToFrontend('oper', { ok: true, op: 'reset', turnId });
    } catch (e) {
      api.sendToFrontend('oper', { ok: false, op: 'reset', turnId, error: String(e.message || e).slice(0, 300) });
    }
  });

  api.onFrontendMessage('autoApprove', msg => { if (msg.sessionId) api.setAutoApproveMenu(msg.sessionId, !!msg.enabled); });

  // ---------- 本机文件夹选择（建群/克隆用）：资源管理器里选真实存在的目录，从源头杜绝路径错字开出平行宇宙 ----------
  let picking = false;
  api.onFrontendMessage('pickFolder', () => {
    if (picking) return; // 对话框一次只开一个
    picking = true;
    const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; " +
      "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }; " + // 隐形置顶宿主：防对话框开在浏览器后面
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '选择群的工作文件夹（也可在里面新建文件夹）'; $f.ShowNewFolderButton = $true; " +
      "if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }";
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 300000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      picking = false;
      const p = String(stdout || '').trim();
      api.sendToFrontend('oper', { ok: !!p, op: 'pickFolder', path: p }); // 取消/超时 → ok:false，前端静默
    });
  });

  // ---------- 源头（群字段 JSON + 模板）与章程直发（v0.5.0 零足迹） ----------
  // 源头只能通过界面改，存数据目录；章程/角色卡不再落盘到工作目录，由程序渲染后直发注入。
  // 老格式群（legacy）例外：它们的章程/角色卡本来就是工作目录里的手写文件，保持旧世界不动。
  const TPL = path.join(__dirname, 'templates');           // 出厂模板
  const UTPL = path.join(DATA, 'templates');               // 用户自定义模板（界面导入/编辑）
  const GDIR = path.join(DATA, 'groups');                  // 每群字段，一群一个 JSON
  fs.mkdirSync(UTPL, { recursive: true }); fs.mkdirSync(GDIR, { recursive: true });
  const BOM = '\ufeff'; // 给老板看的导出/备份文件带 BOM，防 Windows 默认编码读出乱码
  const gpath = pid => path.join(GDIR, safeId(pid) + '.json');
  function loadGroup(pid) { try { return JSON.parse(fs.readFileSync(gpath(pid), 'utf8')); } catch { return null; } }
  const saveGroup = (pid, g) => { fs.writeFileSync(gpath(pid), JSON.stringify(g, null, 2)); renderPacks(pid); backupSoon(); };
  function tplRead(name) {
    const u = path.join(UTPL, name);
    if (fs.existsSync(u)) return { text: fs.readFileSync(u, 'utf8'), source: 'custom' };
    return { text: fs.readFileSync(path.join(TPL, name), 'utf8'), source: 'default' };
  }
  const rosterOf = g => (g.members || []).map(m => '- **' + m.seatName + '**：' + (m.identity || '见角色卡')).join('\n') || '- （暂无其他成员，正在招人）';
  const renderTeam = (g, dir) => tplRead('TEAM.template.md').text
    .replace(/\{\{群名\}\}/g, g.name || '').replace(/\{\{路径\}\}/g, dir || '')
    .replace(/\{\{核心任务\}\}/g, g.task || '（未单独设置，以群聊里的指示为准）')
    .replace(/\{\{附加指令\}\}/g, g.instructions || '（无）')
    .replace(/\{\{成员表\}\}/g, rosterOf(g))
    .replace(/\{\{用户称呼\}\}/g, bossName());
  const renderRole = m => tplRead('role.template.md').text
    .replace(/\{\{名字\}\}/g, m.seatName || '').replace(/\{\{一句话身份\}\}/g, m.identity || '')
    .replace(/\{\{职责\}\}/g, m.duty || '（未填写）').replace(/\{\{规范\}\}/g, m.rules || '（未填写）')
    .replace(/\{\{用户称呼\}\}/g, bossName());
  // 章程包：注入用的全文（章程 + 本人角色卡 + 守卫词）。路由完全由程序决定，不放权成员自己找文件。
  const charterText = pid => { const g = loadGroup(pid); return g ? renderTeam(g, projPath(pid)) : ''; };
  function charterPack(pid, seatName) {
    const g = loadGroup(pid);
    const m = g && (g.members || []).find(x => x.seatName === seatName);
    return '【团队章程】\n' + charterText(pid)
      + (m ? '\n\n【你的角色卡】\n' + renderRole(m) : '')
      + '\n（说明：章程与角色卡由系统直接发给你，工作目录里没有、也不需要有它们的文件；目录里若出现旧版残留或项目自带的说明文件，群身份与协议一律以系统最新发给你的为准。）';
  }
  // ---------- 章程包落盘（v0.6.0）：每席一份"章程+角色卡"，补丁7 在 spawn 时拼进系统提示旗 ----------
  // 时机：群档案每次保存、模板改动、开机、整点备份（兜底老板改称呼等旁路漂移）。成员增删改名后自动收敛。
  function renderPacks(pid) {
    try {
      const g = loadGroup(pid);
      const dir = kfq.packDir(pid);
      if (!g || g.legacy) { fs.rmSync(dir, { recursive: true, force: true }); return; } // 老格式群走文件世界，不落包
      fs.mkdirSync(dir, { recursive: true });
      const want = new Set();
      for (const m of g.members || []) {
        const f = kfq.seatFile(m.seatName);
        want.add(f);
        fs.writeFileSync(path.join(dir, f), charterPack(pid, m.seatName)); // 不带 BOM：给模型看的，不是给人看的
      }
      for (const f of fs.readdirSync(dir)) if (!want.has(f)) fs.rmSync(path.join(dir, f), { force: true }); // 离职/改名的旧包回收
    } catch {}
  }
  // 补丁7 落位标记（启动器打补丁成功时写、失败时删；服务器启动前已定案，读一次即可）。
  // 标记在 + claude/codex 席 + 本次 spawn 回执在 = node-pty 已创建接受章程旗 argv 的进程
  // → 压缩补发/接续补发/入职全文都可省。apply() 先清旧回执，pty.spawn 成功后才提交：v0.6.1 只看
  // 「补丁装没装 + 包在不在」，旗被 cmd.exe 绞碎时门控仍报 true，三处兜底全省 → 席位裸奔。
  const SPAWN_OK = fs.existsSync(path.join(DATA, 'spawn-patch.ok'));
  function flagInjected(id) {
    if (!SPAWN_OK) return false;
    const s = api.getSession(id);
    if (!s || !s.projectId || (s.presetId !== 'claude-code' && s.presetId !== 'codex')) return false;
    const g = loadGroup(s.projectId);
    if (!g || g.legacy || !(g.members || []).some(m => m.seatName === s.name)) return false;
    return fs.existsSync(kfq.flagPath(s.projectId, s.name));
  }

  // 补发章程：上下文压缩后 / 重开会话后 / 老板手动触发 / 章程更新群发（带 mid 时回执吸附到对应系统线）。
  // 走投递队列，成员忙完自然送达。所有"【系统广播】+章程包+阅后即可"的装配只有这一处。
  function recharter(pid, sessionId, reason, mid) {
    const s = api.getSession(sessionId); if (!s) return;
    deliver(pid, sessionId, '【系统广播】\n' + (reason || '给你重新同步团队章程与你的角色卡，以下最新版为准。') + '\n\n' + charterPack(pid, s.name) + READ_TAIL,
      { kind: 'group', from: '系统', mid });
  }
  const compactAt = new Map(); // sessionId -> 上次补发章程时刻（压缩检测限频用）
  // 各家 CLI 压缩上下文时的提示语（claude: Compacting/auto-compact；codex: compacted the conversation；gemini: chat history compressed）
  const COMPACT_RE = /auto-?compact|compact(ed|ing)?\s+(the\s+)?(conversation|context|chat)|(conversation|context|chat|history)\s+(was\s+)?(compacted|compressed)|chat history compressed/i;

  // v0.5.0 一次性迁移：撤走旧版印刷品（只删带我们生成头标的），恢复建群前备份的原文件。
  const OUR_MARK = '本文件由系统'; // 旧版印刷品统一头标；手写文件没有它，绝不误删
  function printedByUs(p) { try { return fs.readFileSync(p, 'utf8').slice(0, 200).includes(OUR_MARK); } catch { return false; } }
  function sweepDir(pid) {
    const g = loadGroup(pid); const dir = projPath(pid);
    if (!g || g.legacy || !dir) return false;
    let cleaned = false;
    try {
      for (const f of ['TEAM.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
        const p0 = path.join(dir, f);
        if (printedByUs(p0)) { fs.rmSync(p0, { force: true }); cleaned = true; }
        const bak = path.join(dir, f.replace(/\.md$/, '') + '.建群前备份.md');
        if (fs.existsSync(bak) && !fs.existsSync(p0)) { try { fs.renameSync(bak, p0); } catch {} }
      }
      const rd = path.join(dir, 'roles');
      if (fs.existsSync(rd)) {
        for (const f of fs.readdirSync(rd)) { const p0 = path.join(rd, f); if (printedByUs(p0)) { fs.rmSync(p0, { force: true }); cleaned = true; } }
        if (!fs.readdirSync(rd).length) fs.rmdirSync(rd);
      }
    } catch {}
    return cleaned;
  }

  // 系统自己动了工作目录 → 立刻以系统身份记账提交，防止这些变动算到下一个收工成员的头上
  function sysSnap(pid, label) {
    try {
      const g = loadGroup(pid); const dir = projPath(pid);
      if (dir && (!g || g.snapshot !== false) && isRepo(dir)) snap(dir, label);
    } catch {}
  }

  // ---------- 备份（给老板自己；路径永不出现在任何成员的上下文里） ----------
  const backupDir = () => { const v = api.getSetting('backupDir'); return (v === undefined || v === null) ? '' : String(v).trim(); };
  let bakTimer = null;
  function backupNow() {
    try { for (const pr of api.getProjects() || []) renderPacks(pr.id); } catch {} // 整点顺手刷新章程包（兜底老板改称呼等旁路漂移）
    const dst = backupDir(); if (!dst) return;                          // 设置里清空 = 关闭备份
    if (!/^[A-Za-z]:[\\/]/.test(dst)) return;
    try {
      const d0 = path.resolve(dst).toLowerCase();
      for (const pr of api.getProjects() || []) {                      // 不许把备份放进任何群的工作目录（成员会翻到）
        const p = pr.path && path.resolve(pr.path).toLowerCase();
        if (p && (d0 === p || d0.startsWith(p + path.sep))) return api.log('备份目录在群工作目录里，已拒绝备份：' + dst);
      }
      const d = new Date();
      const tag = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      for (const sub of ['当前镜像', '快照-' + tag]) {
        const root = path.join(dst, sub);
        if (sub !== '当前镜像' && fs.existsSync(root)) continue;       // 日快照每天只留第一份
        fs.rmSync(root, { recursive: true, force: true });
        fs.mkdirSync(root, { recursive: true });
        fs.cpSync(DATA, path.join(root, '原始数据'), { recursive: true, force: true });
        for (const pr of api.getProjects() || []) {                    // 人类可读版：各群章程与角色卡
          const g = loadGroup(pr.id); if (!g || g.legacy) continue;
          const gd = path.join(root, '可读版', String(g.name || pr.id).replace(/[\\/:*?"<>|]/g, '_') || pr.id);
          fs.mkdirSync(path.join(gd, 'roles'), { recursive: true });
          fs.writeFileSync(path.join(gd, 'TEAM.md'), BOM + renderTeam(g, pr.path));
          for (const m of g.members || []) fs.writeFileSync(path.join(gd, 'roles', m.seatName + '.md'), BOM + renderRole(m));
        }
      }
      const snaps = fs.readdirSync(dst).filter(x => x.startsWith('快照-')).sort();
      for (const s of snaps.slice(0, Math.max(0, snaps.length - 14))) fs.rmSync(path.join(dst, s), { recursive: true, force: true }); // 日快照保留 14 份
    } catch (e) { api.log('备份失败：' + String(e.message || e)); }
  }
  function backupSoon() { clearTimeout(bakTimer); bakTimer = setTimeout(backupNow, 20000); }
  // 系统广播：聊天流留一条系统线（带消息编号，回执可吸附），并投递给全体在岗成员
  const bcast = (pid, text, exceptId) => {
    const mid = newMid(pid);
    emit(pid, { kind: 'sys', mid, text });
    for (const m of members(pid)) if (m.id !== exceptId) deliver(pid, m.id, '【系统广播】\n' + text + '\n（阅后即可，系统自动记已读；除非需要行动，不用回复）', { kind: 'group', from: '系统', mid });
  };
  const okOp = (op, extra) => api.sendToFrontend('oper', Object.assign({ ok: true, op }, extra || {}));
  const noOp = (op, error) => api.sendToFrontend('oper', { ok: false, op, error });

  api.onFrontendMessage('tplGet', () => {
    api.sendToFrontend('tpl', { team: tplRead('TEAM.template.md'), role: tplRead('role.template.md') });
  });
  api.onFrontendMessage('tplSave', msg => {
    const name = msg.which === 'role' ? 'role.template.md' : 'TEAM.template.md';
    if (!msg.text || !String(msg.text).trim()) return noOp('tplSave', '内容是空的');
    try { fs.writeFileSync(path.join(UTPL, name), String(msg.text)); for (const pr of api.getProjects() || []) renderPacks(pr.id); okOp('tplSave'); }
    catch (e) { noOp('tplSave', String(e.message || e).slice(0, 200)); }
  });
  api.onFrontendMessage('tplReset', msg => {
    const name = msg.which === 'role' ? 'role.template.md' : 'TEAM.template.md';
    try { fs.rmSync(path.join(UTPL, name), { force: true }); for (const pr of api.getProjects() || []) renderPacks(pr.id); okOp('tplReset'); }
    catch (e) { noOp('tplReset', String(e.message || e).slice(0, 200)); }
  });

  api.onFrontendMessage('groupGet', msg => {
    const pid = msg.projectId; if (!pid) return;
    const dir = projPath(pid);
    const g = loadGroup(pid);
    const mode = g ? (g.legacy ? 'legacy' : 'managed') : ((dir && fs.existsSync(path.join(dir, 'TEAM.md'))) ? 'legacy' : 'fresh');
    let teamPreview = '';
    if (g && !g.legacy) teamPreview = charterText(pid); // \u65b0\u4f53\u7cfb\uff1a\u9884\u89c8 = \u76f4\u53d1\u7ed9\u5de5\u4f4d\u7684\u5b9e\u65f6\u6e32\u67d3\u7ed3\u679c
    else { try { if (dir) teamPreview = fs.readFileSync(path.join(dir, 'TEAM.md'), 'utf8').replace(/^\ufeff/, ''); } catch {} }
    api.sendToFrontend('group', { projectId: pid, mode, path: dir || '', teamPreview, group: g || { name: '', task: '', instructions: '', snapshot: true, members: [] } });
  });

  api.onFrontendMessage('groupCreate', msg => {
    const { projectId: pid, name, path: dir, task, instructions, snapshot } = msg;
    if (!pid || !name || !dir) return noOp('groupCreate', '参数不全');
    if (!/^[A-Za-z]:[\\/]/.test(dir)) return noOp('groupCreate', '文件夹要填完整路径，例如 C:\\projects\\portfolio');
    try {
      // 零足迹：不再往工作目录写门牌/章程（章程随入职通知直发），已有别的群/项目文件也互不相扰
      fs.mkdirSync(dir, { recursive: true });
      for (const d of ['docs', 'sandbox', 'assets']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      saveGroup(pid, { name, task: task || '', instructions: instructions || '', snapshot: snapshot !== false, members: [] });
      if (snapshot !== false && !isRepo(dir)) gitInit(dir, '建群初始化');
      okOp('groupCreate', { projectId: pid });
    } catch (e) { noOp('groupCreate', String(e.message || e).slice(0, 300)); }
  });

  api.onFrontendMessage('groupUpdate', msg => {
    const { projectId: pid, name, task, instructions, snapshot } = msg;
    const g = loadGroup(pid); const dir = projPath(pid);
    if (!g || g.legacy) return noOp('groupUpdate', '老格式群不支持字段编辑（想迁移到新体系喊 Claude）');
    const changed = [];
    if (typeof name === 'string' && name.trim() && name.trim() !== g.name) { g.name = name.trim(); changed.push('群名'); }
    if (typeof task === 'string' && task !== (g.task || '')) { g.task = task; changed.push('核心任务'); }
    if (typeof instructions === 'string' && instructions !== (g.instructions || '')) { g.instructions = instructions; changed.push('附加指令'); }
    if (typeof snapshot === 'boolean' && snapshot !== (g.snapshot !== false)) {
      g.snapshot = snapshot; changed.push('文件快照');
      if (snapshot && dir && !isRepo(dir)) gitInit(dir, '开启快照');
    }
    if (!changed.length) return okOp('groupUpdate', { changed });
    saveGroup(pid, g);
    if (changed.some(c => c !== '文件快照')) {
      const mid = newMid(pid);
      emit(pid, { kind: 'sys', mid, text: '章程已更新（' + changed.join('、') + '），新版已直发给在岗成员。' });
      for (const m of members(pid)) recharter(pid, m.id, '章程已更新（' + changed.join('、') + '），以下最新版为准。', mid);
    }
    okOp('groupUpdate', { changed });
  });

  api.onFrontendMessage('memberAdd', msg => {
    const { projectId: pid, seatName, identity, duty, rules } = msg;
    if (!pid || !seatName) return noOp('memberAdd', '参数不全');
    const dir = projPath(pid); if (!dir) return noOp('memberAdd', '找不到群文件夹');
    let g = loadGroup(pid);
    if (!g) {
      const pr = (api.getProjects() || []).find(x => x.id === pid);
      g = { name: (pr && pr.name) || '', task: '', instructions: '', snapshot: true, members: [], legacy: fs.existsSync(path.join(dir, 'TEAM.md')) };
    }
    if ((g.members || []).some(m => m.seatName === seatName)) return noOp('memberAdd', '已有同名成员档案：' + seatName);
    const m = { seatName, identity: identity || '', duty: duty || '', rules: rules || '', avatar: (typeof msg.avatar === 'string' && msg.avatar.length < 300000) ? msg.avatar : '', commandId: typeof msg.commandId === 'string' ? msg.commandId : '' };
    g.members = g.members || []; g.members.push(m);
    try {
      saveGroup(pid, g);
      if (g.legacy) { // 老格式群保持文件世界：角色卡照旧写进工作目录（写完系统自己记账）
        fs.mkdirSync(path.join(dir, 'roles'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'roles', seatName + '.md'), BOM + renderRole(m));
        sysSnap(pid, '系统写入角色卡 roles/' + seatName + '.md（系统操作，与成员无关）');
      }
      bcast(pid, '新同事入职：「' + seatName + '」——' + (identity || '分工见其角色卡') + '。协作时可用 clideck ask 找TA。');
      okOp('memberAdd', { seatName });
    } catch (e) { noOp('memberAdd', String(e.message || e).slice(0, 300)); }
  });

  api.onFrontendMessage('memberUpdate', msg => {
    const { projectId: pid, seatName, identity, duty, rules } = msg;
    const g = loadGroup(pid); const dir = projPath(pid);
    if (!g || !dir) return noOp('memberUpdate', '没有这个群的档案记录（老成员可先在群设置里"补建档案"）');
    const m = (g.members || []).find(x => x.seatName === seatName);
    if (!m) return noOp('memberUpdate', '没有「' + seatName + '」的档案（可在群设置里"补建档案"）');
    const identityChanged = typeof identity === 'string' && identity !== (m.identity || '');
    if (typeof identity === 'string') m.identity = identity;
    if (typeof duty === 'string') m.duty = duty;
    if (typeof rules === 'string') m.rules = rules;
    if (typeof msg.avatar === 'string' && msg.avatar.length < 300000) m.avatar = msg.avatar;
    if (typeof msg.commandId === 'string' && msg.commandId) m.commandId = msg.commandId;
    // 只是补记引擎（换脑/克隆前的自愈）：静默保存，不重印不广播不打扰本人
    if (typeof msg.commandId === 'string' && typeof identity !== 'string' && typeof duty !== 'string' && typeof rules !== 'string' && typeof msg.avatar !== 'string') {
      try { saveGroup(pid, g); return okOp('memberUpdate', { seatName, silent: true }); }
      catch (e) { return noOp('memberUpdate', String(e.message || e).slice(0, 200)); }
    }
    try {
      saveGroup(pid, g);
      if (g.legacy) {
        fs.mkdirSync(path.join(dir, 'roles'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'roles', seatName + '.md'), BOM + renderRole(m));
        sysSnap(pid, '系统更新角色卡 roles/' + seatName + '.md（系统操作，与成员无关）');
      }
      const live = members(pid).find(s => s.name === seatName);
      if (live) {
        const mid = newMid(pid);
        emit(pid, { kind: 'sys', mid, text: '已把更新后的角色卡直发给「' + seatName + '」' });
        deliver(pid, live.id, '【系统广播】\n你的角色卡已更新，以下最新版为准。\n\n' + renderRole(m) + READ_TAIL, { kind: 'group', from: '系统', mid });
      }
      if (identityChanged) bcast(pid, '「' + seatName + '」的分工调整为：' + (identity || '见角色卡'), live && live.id);
      okOp('memberUpdate', { seatName });
    } catch (e) { noOp('memberUpdate', String(e.message || e).slice(0, 300)); }
  });

  // 成员排序：设置页拖动后整表保存；顺序 = 默认发言顺序
  api.onFrontendMessage('memberReorder', msg => {
    const { projectId: pid, order } = msg;
    const g = loadGroup(pid);
    if (!g || !Array.isArray(order) || !order.length) return noOp('memberReorder', '没有可排序的档案');
    const idx = new Map(order.map((n, i) => [n, i]));
    g.members = (g.members || []).slice().sort((a, b) => (idx.has(a.seatName) ? idx.get(a.seatName) : 999) - (idx.has(b.seatName) ? idx.get(b.seatName) : 999));
    try { saveGroup(pid, g); sendState(pid); okOp('memberReorder'); } // 发言顺序程序自己执行，无需通知成员
    catch (e) { noOp('memberReorder', String(e.message || e).slice(0, 200)); }
  });

  // 改名全链路同步：档案、角色卡文件、章程一起改，并广播更名
  api.onFrontendMessage('memberRename', msg => {
    const { projectId: pid, from, to } = msg;
    if (!pid || !from || !to || from === to) return;
    const g = loadGroup(pid); const dir = projPath(pid);
    if (!g || !dir) return;
    const m = (g.members || []).find(x => x.seatName === from);
    if (!m) return; // 没档案的工位改名，与源头无关
    if ((g.members || []).some(x => x.seatName === to)) return noOp('memberRename', '已有同名档案「' + to + '」，改名未同步——请在群设置里手动处理');
    m.seatName = to;
    try {
      saveGroup(pid, g);
      if (g.legacy) { // 老格式群：工作目录里的角色卡文件跟着改名重写（写完系统自己记账）
        const a = path.join(dir, 'roles', from + '.md'), b = path.join(dir, 'roles', to + '.md');
        if (fs.existsSync(a)) { try { if (!fs.existsSync(b)) fs.renameSync(a, b); else fs.rmSync(a); } catch {} }
        fs.mkdirSync(path.join(dir, 'roles'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'roles', to + '.md'), BOM + renderRole(m));
        sysSnap(pid, '系统改名角色卡 roles/' + from + '.md → roles/' + to + '.md（系统操作，与成员无关）');
      }
      const live = members(pid).find(s => s.name === to);
      if (live) deliver(pid, live.id, '【系统广播】\n你已更名为「' + to + '」，章程分工表已同步。以下是你的最新角色卡：\n\n' + renderRole(m) + READ_TAIL, { kind: 'group', from: '系统' });
      bcast(pid, '成员「' + from + '」更名为「' + to + '」，后续 ask 请用新名字。', live && live.id);
      okOp('memberRename', { from, to });
    } catch (e) { noOp('memberRename', String(e.message || e).slice(0, 200)); }
  });

  api.onFrontendMessage('memberRemove', msg => {
    const { projectId: pid, seatName } = msg;
    const g = loadGroup(pid);
    if (g) {
      g.members = (g.members || []).filter(x => x.seatName !== seatName);
      try { saveGroup(pid, g); } catch {}
      // 老格式群工作目录里的 roles/xx.md 留档不删，方便回聘
    }
    const live = members(pid).find(s => s.name === seatName);
    if (live) bcast(pid, '「' + seatName + '」已离开团队，后续不要再 ask TA。', live.id); // 只有活人离职才值得广播
    okOp('memberRemove', { seatName });
  });

  // 克隆群 = 纯复制：配置（字段+成员档案+头像+引擎）原样复制成一个新群，工位全新记忆（由前端逐个上岗）。
  // 原群保持原状、继续可用——不归档、不只读、旧工位不下岗。
  // 文件夹填原路径 = 与原群共用工作区（文件、代码、git 历史共享，ask 按群内寻址不串线）；填新路径 = 另起项目。
  // 零足迹后目录里没有任何群文件，几群同住一个文件夹互不相扰。
  api.onFrontendMessage('groupClone', msg => {
    const { sourceId, projectId: pid, name, path: dir, task, instructions, snapshot } = msg;
    const src = loadGroup(sourceId);
    if (!src) return noOp('groupClone', '源群没有档案（老格式群不能克隆，想迁移喊 Claude）');
    if (!pid || !name || !dir) return noOp('groupClone', '参数不全');
    if (!/^[A-Za-z]:[\\/]/.test(dir)) return noOp('groupClone', '文件夹要填完整路径，例如 C:\\projects\\project-copy');
    const srcDir = projPath(sourceId);
    const sameDir = !!(srcDir && path.resolve(srcDir).toLowerCase() === path.resolve(dir).toLowerCase());
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const d of ['docs', 'sandbox', 'assets']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      const g = {
        name, task: typeof task === 'string' ? task : (src.task || ''),
        instructions: typeof instructions === 'string' ? instructions : (src.instructions || ''),
        snapshot: snapshot !== false,
        members: JSON.parse(JSON.stringify(src.members || [])),
      };
      saveGroup(pid, g);
      if (g.snapshot && !isRepo(dir)) gitInit(dir, '建群初始化');
      emit(sourceId, { kind: 'sys', text: '本群已被克隆出新群「' + name + '」（' + (sameDir ? '共用本文件夹' : '在 ' + dir) + '，成员全新记忆）。本群不受影响，照常使用。' });
      okOp('groupClone', { projectId: pid, sameDir, members: g.members.map(m => ({ seatName: m.seatName, commandId: m.commandId || '' })) });
    } catch (e) { noOp('groupClone', String(e.message || e).slice(0, 300)); }
  });

  // 重发章程：把当前源头渲染的章程+各自角色卡直发给全体在岗成员（手动兜底：怀疑谁断片了就点它）
  api.onFrontendMessage('regen', msg => {
    const pid = msg.projectId;
    const g = loadGroup(pid);
    if (!g || g.legacy) return noOp('regen', '老格式群没有系统章程（想迁移喊 Claude）');
    try {
      const live = members(pid);
      const mid = newMid(pid);
      emit(pid, { kind: 'sys', mid, text: live.length ? '已把最新章程直发给 ' + live.length + ' 位在岗成员' : '当前没有在岗成员，成员上岗时会随入职通知拿到最新章程' });
      for (const m of live) recharter(pid, m.id, undefined, mid);
      okOp('regen', { sent: live.length });
    } catch (e) { noOp('regen', String(e.message || e).slice(0, 200)); }
  });

  // 补发章程（成员抽屉"压缩"后自动跟一发；重开会话后也来一发）
  api.onFrontendMessage('recharter', msg => {
    const { projectId: pid, sessionId } = msg;
    if (!pid || !sessionId) return;
    recharter(pid, sessionId);
    okOp('recharter');
  });

  // 接续热身：前端刚触发了"带记忆接回"（session.resume）。热身期间压住新一轮传阅（消息进 roundQ），
  // 每个工位就位后等 8 秒开机静默再补发最新章程；全员就位+静默期过或 40 秒兜底到点即放行。
  api.onFrontendMessage('seatsResuming', msg => {
    const { projectId: pid, names } = msg;
    if (!pid || !Array.isArray(names) || !names.length) return;
    const r = room(pid);
    if (r.resuming) { for (const n of names) if (!r.resuming.names.has(n)) r.resuming.names.set(n, 0); }
    else r.resuming = { names: new Map(names.map(n => [n, 0])), deadline: 0, timer: null };
    r.resuming.deadline = Date.now() + RESUME_DEADLINE;
    if (!r.resuming.timer) r.resuming.timer = setInterval(() => {
      const w = r.resuming;
      if (!w) return;
      let changed = false;
      const live = new Map(members(pid).map(s => [s.name, s.id]));
      for (const [n, at] of w.names) {
        if (at || !live.has(n)) continue;
        w.names.set(n, Date.now()); changed = true;
        const sid = live.get(n);
        // 系统提示层席位接续时 spawn 已重新拼入最新章程包，无需 in-band 再来一份
        setTimeout(() => { if (!flagInjected(sid)) recharter(pid, sid, '你的工位已带着上次的记忆接回。团队章程有更新（现在由系统直发，工作目录里不再有章程文件），以下最新版为准。'); }, BOOT_QUIET);
      }
      const ats = [...w.names.values()];
      if ((ats.every(a => a > 0) && Date.now() - Math.max(...ats) >= BOOT_QUIET) || Date.now() > w.deadline) {
        clearInterval(w.timer); r.resuming = null;
        drainQ(pid); // 放行：排队的消息现在开轮，接回的成员一起进传阅链
      } else if (changed) pushRound(pid);
    }, 1000);
    pushRound(pid);
  });

  api.onFrontendMessage('onboard', msg => {
    const { projectId: pid, sessionId, role, seatName } = msg;
    if (!pid || !sessionId) return;
    const nm = seatName || role;
    const mid = newMid(pid);
    emit(pid, { kind: 'sys', mid, text: '「' + nm + '」已上岗（全新记忆）——入职通知（含章程与角色卡全文）将在工位就绪后送达，读完系统会自动打 ✓' });
    const g0 = loadGroup(pid);
    // 延迟投递：等 CLI 出完开机画面/信任确认、状态探测就绪，防止通知被启动过程吃掉（note 也延迟装配，等 presetId 可查）
    setTimeout(() => {
      const note = (g0 && g0.legacy)
        ? '【系统广播】\n入职通知：你是「' + nm + '」。请先读 TEAM.md（重点是《频道与发言协议》），再读 roles/' + (role || seatName) + '.md 角色卡。读完正常收工即可，系统会自动记你已读，不用回复。'
        : flagInjected(sessionId)
          ? '【系统广播】\n入职通知：你是「' + nm + '」。团队章程与你的角色卡已内置在你的系统提示里（启动即生效、上下文压缩也不丢），请先通读（重点是《频道与发言协议》《交接与收尾》），再按角色开工。读完正常收工即可，系统会自动记你已读，不用回复。'
          : '【系统广播】\n入职通知：你是「' + nm + '」。以下是团队章程与你的角色卡，请通读并照此行事（重点是《频道与发言协议》）。读完正常收工即可，系统会自动记你已读，不用回复。\n\n' + charterPack(pid, nm);
      deliver(pid, sessionId, note, { kind: 'group', from: '系统', mid });
    }, BOOT_QUIET);
  });

  // 开机：清扫旧版印刷品（一次性迁移，之后每次开机都是空扫）+ 备份一轮；备份此后每小时兜底一次
  try { for (const pr of api.getProjects() || []) renderPacks(pr.id); } catch {} // 开机同步铺齐章程包——必须赶在任何接续/上岗 spawn 之前
  setTimeout(() => {
    try {
      for (const pr of api.getProjects() || []) {
        if (!sweepDir(pr.id)) continue;
        sysSnap(pr.id, '系统迁移：撤走旧版章程与门牌印刷品（系统操作，与成员无关）');
        emit(pr.id, { kind: 'sys', text: '章程体系已升级为系统直发：工作目录里的旧版章程/门牌文件已撤走（手写文件不动），在岗成员已重新同步章程。' });
        for (const m of members(pr.id)) recharter(pr.id, m.id, '章程体系升级：工作目录里不再存放章程文件，给你重新同步一份，以此为准。');
      }
      backupNow();
    } catch {}
  }, 3000);
  setInterval(backupNow, 60 * 60 * 1000); // 聊天记录等日常变化靠整点兜底盖进备份

  api.onShutdown(() => {});
  api.log('开发部群 orchestrator v' + VERSION + ' 已就绪（章程上系统提示层' + (SPAWN_OK ? '' : '[补丁7未落位，走in-band兜底]') + ' + 串行发言权 + 双通道包络）');
}
