/* 开发部群 — live client. 依赖同源 CliDeck WS + plugin.kaifabuqun.* 频道。 */
(function () {
  const $ = s => document.querySelector(s);
  const P = 'plugin.kaifabuqun.';
  const EXPECT = '0.6.2'; // 服务端插件应有的版本；不一致说明黑窗口还在跑旧代码
  const COLORS = ['zhu', 'shu', 'mei'];

  const st = {
    ws: null,
    config: null, projects: [],
    sessions: new Map(),          // id -> {id,name,commandId,presetId,projectId,working,muted}
    resumable: [],                // 可带记忆接续的离线工位（上游重启前存档；发消息时默认自动接回）
    ctxEst: new Map(),            // id -> percent (估算)
    pid: localStorage.getItem('kfq.pid') || null,
    channel: 'group',             // 'group' | 'dm-<sessionId>' | 'listen'
    journal: new Map(),           // pid -> events[]
    fuse: { fuse: 0, paused: false, limit: 6 },
    round: null,                      // 当前发言轮次（服务端推送：谁在读/谁有发言权/排队几条）
    srv: null, stale: false,          // 服务端插件版本 / 是否为旧版
    bossName: '用户',                  // 你的称呼（设置里可改，服务端 state 带回）
    backupDir: '',                    // 备份文件夹（只给老板看，成员不知道；设置里可改）
    members: new Map(),               // seatName -> {identity, avatar}（当前群档案，头像用）
    pendingSeats: [], gcPending: null, gcClone: null, gsWait: false, tplWait: null, // 建群/克隆/加人/群设置/模板编辑 在途状态
    menus: new Map(),             // sessionId -> {choices, header}
    terms: new Map(),             // sessionId -> {term, div}
    rawOpen: null,
  };

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let toastTimer;
  function toast(x) { const t = $('#toast'); t.textContent = x; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
  const proj = () => st.projects.find(p => p.id === st.pid);
  const memberList = () => [...st.sessions.values()].filter(s => s.projectId === st.pid && s.presetId !== 'shell');
  const sess = id => st.sessions.get(id);
  const colorOf = id => { const i = memberList().findIndex(m => m.id === id); return COLORS[(i < 0 ? 0 : i) % COLORS.length]; };
  const engineOf = s => { const c = (st.config?.commands || []).find(c => c.id === s.commandId); return c ? c.label : (s.presetId || '?'); };
  function send(o) { if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify(o)); }
  const plug = (event, data) => send({ type: P + event, ...data });
  function jlist() { if (!st.journal.has(st.pid)) st.journal.set(st.pid, []); return st.journal.get(st.pid); }

  // ---------- 隐藏终端（capture 契约 + 看原始终端） ----------
  const COLS = 140, ROWS = 40;
  function ensureTerm(id) {
    if (st.terms.has(id)) return st.terms.get(id);
    const div = document.createElement('div');
    div.style.width = '1150px'; div.style.height = '740px';
    $('#terms').appendChild(div);
    const term = new window.Terminal({ cols: COLS, rows: ROWS, fontSize: 13, scrollback: 3000, convertEol: false, allowProposedApi: true });
    term.open(div);
    // 有选中文字时 Ctrl+C = 复制（不发中断信号，防误杀 CLI）；Ctrl+V = 粘贴
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.shiftKey || ev.altKey) return true;
      const k = ev.key.toLowerCase();
      if (k === 'c' && term.hasSelection()) {
        try { navigator.clipboard.writeText(term.getSelection()); toast('已复制'); } catch {}
        term.clearSelection();
        return false;
      }
      if (k === 'v') {
        try { navigator.clipboard.readText().then(t => { if (t) term.paste(t); }); } catch {}
        return false;
      }
      return true;
    });
    const o = { term, div };
    st.terms.set(id, o);
    send({ type: 'resize', id, cols: COLS, rows: ROWS });
    return o;
  }
  function termLines(id) {
    const o = st.terms.get(id); if (!o) return [];
    const buf = o.term.buffer.active, lines = [];
    const start = Math.max(0, buf.length - ROWS);
    for (let i = start; i < buf.length; i++) { const l = buf.getLine(i); lines.push(l ? l.translateToString(true) : ''); }
    return lines;
  }
  function menuHeader(id) {
    const lines = termLines(id).filter(l => l.trim());
    const tailL = lines.slice(-16);
    const body = tailL.filter(l => !/^\s*(❯|>|\d+[.)]\s)/.test(l) && !/esc/i.test(l));
    return body.slice(-4).join('\n').slice(0, 400);
  }

  // ---------- WS ----------
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    st.ws = ws;
    ws.onopen = () => { $('#connHint').textContent = '已连接工作台'; setTimeout(() => { if (!st.stale) $('#connHint').style.display = 'none'; }, 1500); };
    ws.onclose = () => { $('#connHint').style.display = ''; $('#connHint').textContent = '连接断开，3 秒后重连…（工作台服务没在跑？）'; setTimeout(connect, 3000); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  }

  function handle(m) {
    switch (m.type) {
      case 'config': {
        st.config = m.config; st.projects = m.config.projects || [];
        if (!st.pid || !st.projects.some(p => p.id === st.pid)) { const g = st.projects.find(p => /游戏开发部/.test(p.name || '')) || st.projects[0]; st.pid = g && g.id; }
        renderRail(); renderSide(); hello();
        break;
      }
      case 'sessions': for (const s of m.list || []) { st.sessions.set(s.id, s); if (s.presetId !== 'shell') ensureTerm(s.id); } renderSide(); renderStream(); break;
      case 'sessions.resumable': st.resumable = m.list || []; break;
      case 'created': {
        st.sessions.set(m.id, m); if (m.presetId !== 'shell') ensureTerm(m.id); renderSide();
        if (m.resumed) { st.resumable = st.resumable.filter(x => x.id !== m.id); toast('「' + m.name + '」已带记忆接回'); break; } // 接续工位不走入职（记忆还在）
        toast('工位「' + m.name + '」已开');
        const pi = st.pendingSeats.findIndex(x => x.seatName === m.name && x.pid === m.projectId);
        if (pi >= 0) { plug('onboard', { projectId: m.projectId, sessionId: m.id, role: m.name, seatName: m.name }); st.pendingSeats.splice(pi, 1); }
        break;
      }
      case 'closed': { const s0 = sess(m.id); st.sessions.delete(m.id); const t = st.terms.get(m.id); if (t) { t.term.dispose(); t.div.remove(); st.terms.delete(m.id); } renderSide(); if (s0 && s0.presetId !== 'shell') toast('工位「' + s0.name + '」已关闭（进程退出或被移除）'); break; }
      case 'renamed': { const s = sess(m.id); if (s) { const from = s.name; s.name = m.name; if (s.projectId && from && from !== m.name) plug('memberRename', { projectId: s.projectId, from, to: m.name }); } renderSide(); break; }
      case 'session.setProject': { const s = sess(m.id); if (s) s.projectId = m.projectId; renderSide(); break; }
      case 'session.status': { const s = sess(m.id); if (s) { s.working = m.working; renderMembers(); renderTyping(); } break; }
      case 'session.menu': {
        if ((m.choices || []).length) st.menus.set(m.id, { choices: m.choices, header: menuHeader(m.id) });
        else st.menus.delete(m.id);
        renderStream(); break;
      }
      case 'output': { const s = sess(m.id); if (s && s.presetId !== 'shell') ensureTerm(m.id).term.write(m.data); break; }
      case 'terminal.capture': { if (st.terms.has(m.id)) send({ type: 'terminal.buffer', id: m.id, lines: termLines(m.id), menuVersion: m.menuVersion }); break; }
      case 'transcript.cache': { for (const [id, txt] of Object.entries(m.cache || {})) st.ctxEst.set(id, Math.min(96, Math.round((txt || '').length / 512))); renderMembers(); break; }
      case 'error': toast(m.message || '出错了'); break;
      case P + 'chat': {
        const ev = m.ev; if (!ev) break;
        if (!st.journal.has(ev.projectId)) st.journal.set(ev.projectId, []);
        const arr = st.journal.get(ev.projectId);
        arr.push(ev);
        if (arr.length > 800) arr.splice(0, arr.length - 400); // 与服务端 tail(400) 对齐，挂机标签页不无界膨胀
        if (ev.projectId !== st.pid) break;
        if (ev.kind === 'fuse') { st.fuse = ev; renderFuse(); }
        else if (visible(ev)) scheduleStream(); // 当前频道看不见的事件（群聊时的工作日志风暴）只入账，不烧全量重渲染
        break;
      }
      case P + 'state': {
        st.srv = m.version || null;
        if (m.bossName) st.bossName = m.bossName;
        if (typeof m.backupDir === 'string') st.backupDir = m.backupDir;
        if (m.members) st.members = new Map(m.members.map(x => [x.seatName, x]));
        st.stale = st.srv !== EXPECT;
        if (st.stale) { const c = $('#connHint'); c.style.display = ''; c.textContent = '⚠ 服务器还在跑旧版程序（' + (st.srv || '0.1.3 以前') + '，应为 ' + EXPECT + '）——请关掉服务器窗口后重新运行启动脚本'; }
        else if ($('#connHint').textContent.startsWith('⚠')) $('#connHint').style.display = 'none';
        if (m.projectId !== st.pid) break;
        st.journal.set(m.projectId, m.journal || []); st.fuse = { fuse: m.fuse, paused: m.paused, limit: m.limit }; st.round = m.round || null; renderFuse(); renderRound(); renderStream(); break;
      }
      case P + 'round': { if (m.projectId === st.pid) { st.round = m.round || null; renderRound(); } break; }
      case P + 'group': { if (st.gsWait) { st.gsWait = false; renderGroupSettings(m); } break; }
      case P + 'tpl': { if (st.tplWait) renderTplEditor(m); break; }
      case P + 'oper': {
        if (m.op === 'groupCreate') {
          if (m.ok && st.gcPending && m.projectId === st.gcPending.pid) {
            switchGroup(m.projectId);
            toast('新群「' + st.gcPending.name + '」已建好——点左栏「添加成员」拉人');
            st.gcPending = null;
          } else if (!m.ok) {
            if (st.gcPending) unregisterProject(st.gcPending.pid);
            st.gcPending = null; toast('建群失败：' + (m.error || ''));
          }
          break;
        }
        if (m.op === 'groupClone') {
          if (m.ok && st.gcClone && m.projectId === st.gcClone.pid) {
            const { pid, name, dir } = st.gcClone; st.gcClone = null; // 原群不动：不关工位、不改状态
            switchGroup(pid);
            const cmds = agentCmds();
            const seats = (m.members || []).filter(x => x.commandId && cmds.some(c => c.id === x.commandId));
            const skipped = (m.members || []).filter(x => !seats.includes(x)).map(x => x.seatName);
            seats.forEach((s0, i) => createSeat(pid, s0.seatName, s0.commandId, dir, 1200 + i * 900));
            toast('新群「' + name + '」克隆完成（原群不受影响），' + seats.length + ' 个全新工位陆续上岗' + (skipped.length ? '；' + skipped.join('、') + ' 引擎没记录，去群设置手动上岗' : ''));
          } else if (!m.ok) {
            if (st.gcClone) unregisterProject(st.gcClone.pid);
            st.gcClone = null; toast('克隆失败：' + (m.error || ''));
          }
          break;
        }
        if (m.op === 'pickFolder') { // 资源管理器选完回填（建群/克隆哪个弹窗开着填哪个；取消则静默）
          if (m.ok && m.path) { const el = $('#gclPath') || $('#gcPath'); if (el) el.value = m.path; }
          break;
        }
        if (m.op === 'memberUpdate' && m.ok && m.silent) { hello(); break; } // 静默补记引擎，不弹提示
        if (m.op === 'memberAdd' && m.ok) {
          const pi = st.pendingSeats.findIndex(x => x.seatName === m.seatName && x.pid === st.pid);
          if (pi >= 0) { const p0 = st.pendingSeats.splice(pi, 1)[0]; createSeat(p0.pid, p0.seatName, p0.commandId, (proj() || {}).path); toast('档案已建，工位启动中…'); }
          else toast('档案已保存');
          hello(); // 刷新头像/档案缓存
          break;
        }
        if ((m.op === 'memberUpdate' || m.op === 'memberRemove') && m.ok) hello();
        const nice = { groupUpdate: '群设置已保存，新版章程已直发在岗成员', memberUpdate: '档案已更新，新角色卡已直发本人', memberRemove: '成员已移除，已广播', memberReorder: '发言顺序已保存', regen: '章程已重发给在岗成员', recharter: '已安排补发章程（TA 空闲时送达）', tplSave: '模板已保存（影响以后的章程生成）', tplReset: '已恢复出厂默认模板', journalClear: '聊天记录已清理' };
        toast(m.ok ? (nice[m.op] || '操作完成') : ('失败：' + (m.error || '')));
        break;
      }
    }
  }
  function hello() { if (st.pid) plug('hello', { projectId: st.pid }); }

  // ---------- 渲染：左栏 ----------
  function renderRail() {
    const rail = document.querySelector('.rail');
    let h = '<span class="glide" id="railGlide" aria-hidden="true"></span>';
    for (const p of st.projects) h += `<button class="rbtn ${p.id === st.pid ? 'on' : ''}" data-pid="${p.id}" title="${esc(p.name)}">${esc((p.name || '?').slice(0, 1))}</button>`;
    h += '<button class="rbtn" id="newGroup" title="开新群" style="border:1.5px dashed var(--line2); background:transparent; font-size:19px; color:var(--ink3)">+</button>';
    h += '<div class="spacer"></div>';
    h += '<button class="rbtn" id="themeBtn" title="切换深浅色"><svg class="ico"><use href="#i-moon"/></svg></button>';
    h += '<button class="rbtn" id="stockBtn" title="打开原版 CliDeck 界面（调试用，用完关掉）"><svg class="ico"><use href="#i-sliders"/></svg></button>';
    rail.innerHTML = h;
    glider(rail, '.rbtn', '.rbtn.on');
  }

  function renderSide() {
    const side = document.querySelector('.side');
    const p = proj();
    const ms = memberList();
    const asks = jlist().some(e => e.kind === 'listen' || e.kind === 'listen-reply');
    let h = '<span class="glide" aria-hidden="true"></span>';
    h += `<div class="head"><button class="teambtn" id="teamBtn"><span class="trow">${esc(p ? p.name : '未选群')} <svg class="ico chev"><use href="#i-chev"/></svg></span><span class="sub">${esc(p ? (p.path || '') : '')} · ${ms.length} 名成员</span></button></div>`;
    h += `<div class="sec"><div class="label">频道</div><button class="chan ${st.channel === 'group' ? 'on' : ''}" data-chan="group"><svg class="ico cic"><use href="#i-hash"/></svg><span class="nm">群聊</span><span class="tag2">全员上下文</span></button></div>`;
    h += '<div class="sec"><div class="label">私聊<span class="lnote">· 只进双方上下文</span></div>';
    for (const m of ms) h += `<button class="chan ${st.channel === 'dm-' + m.id ? 'on' : ''}" data-chan="dm-${m.id}"><svg class="ico cic"><use href="#i-msg"/></svg><span class="nm">${esc(m.name)}</span></button>`;
    h += '</div>';
    h += `<div class="sec"><div class="label">旁听<span class="lnote">· 同事互问，你可插话</span></div><button class="chan ${st.channel === 'listen' ? 'on' : ''}" data-chan="listen"><svg class="ico cic"><use href="#i-eye"/></svg><span class="nm">同事互问</span>${asks ? '' : '<span class="tag2">暂无</span>'}</button></div>`;
    h += `<div class="sec"><div class="label">成员<span class="lcount">${ms.length}</span></div>`;
    for (const m of ms) {
      const col = colorOf(m.id), pct = st.ctxEst.get(m.id) || 0, C = 2 * Math.PI * 7;
      const rec = st.members.get(m.name);
      const avIn = rec && rec.avatar ? `<span class="av"><img src="${rec.avatar}" alt=""/></span>` : `<span class="av" style="background:var(--${col}-soft); color:var(--${col})">${esc(m.name.slice(0, 1))}</span>`;
      h += `<button class="mem" data-mem="${m.id}" title="${m.working ? '干活中' : '空闲'} · 上下文约 ${pct}%">
        <span class="avw">${avIn}<span class="pdot ${m.working ? 'busy' : 'idle'}"></span></span>
        <span class="info"><span class="nm">${esc(m.name)}</span><span class="st">${esc(engineOf(m))}</span></span>
        <span class="mctx"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--panel2)" stroke-width="2.6"></circle><circle cx="9" cy="9" r="7" fill="none" stroke="var(--${pct > 75 ? 'danger' : pct > 55 ? 'warn' : 'ok'})" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 9 9)"></circle></svg></span></button>`;
    }
    h += `<button class="chan" id="addMem"><svg class="ico cic"><use href="#i-plus"/></svg><span class="nm">添加成员</span></button></div>`;
    side.innerHTML = h;
    glider(side, '.chan, .mem, .teambtn', '.chan.on');
    renderHead();
  }
  function renderMembers() { renderSide(); }

  // ---------- 渲染：主区 ----------
  function chanInfo() {
    if (st.channel === 'group') return { title: '群聊', desc: '发言广播给全员，@ 只是点名提醒', pill: '群聊 · 进入全员上下文' };
    if (st.channel === 'listen') return { title: '旁听 · 同事互问', desc: '成员之间 clideck ask 的往来，你随时可插话（以「' + st.bossName + '」身份进群聊）', pill: '插话将发到群聊' };
    const m = sess(st.channel.slice(3));
    return { title: '私聊 · ' + (m ? m.name : '?'), desc: '你和 TA 的私聊；TA 与同事的 ask 往来也在这里可见', pill: '私聊' + (m ? m.name : '') + ' · 其他成员不可见' };
  }
  function renderHead() { const c = chanInfo(); $('#chTitle').textContent = c.title; $('#chDesc').textContent = c.desc; $('#targetPill').textContent = c.pill; $('#fusePill').style.display = st.channel === 'group' ? '' : 'none'; renderFuse(); renderRound(); }
  // 发言轮次状态条：全员阅读进度 / 当前发言权归属 / 排队消息数
  function renderRound() {
    const el = $('#roundPill'); if (!el) return;
    const r = st.round;
    if (st.channel !== 'group' || !r) { el.style.display = 'none'; return; }
    el.style.display = '';
    let t = '';
    if (r.warmup) t = '接回成员中' + (r.waiting && r.waiting.length ? '（等 ' + r.waiting.join('、') + ' 开机）' : '（开机静默期）');
    else if (r.phase === 'processing') t = '全员阅读中 ' + (r.done ? r.done.length : 0) + '/' + (r.total || 0) + (r.pending && r.pending.length ? '（等 ' + r.pending.join('、') + '）' : '');
    else if (r.phase === 'chaining') t = '发言权：' + (r.holder || '?');
    if (r.queued) t += (t ? ' · ' : '') + '排队 ' + r.queued + ' 条';
    el.textContent = t || '空闲';
    el.title = '发言权由程序按成员顺序轮流授予：全员读完上一条消息后，才轮到下一位公开发言。@某人可让TA优先。';
  }
  function renderFuse() {
    const f = st.fuse, el = $('#fusePill'); if (!el) return;
    if (f.paused) { el.className = 'pill paused'; el.textContent = '已熔断 · 点此放行'; el.onclick = () => plug('resumeFanout', { projectId: st.pid }); }
    else { el.className = 'pill'; el.textContent = '自由讨论 · 熔断剩 ' + Math.max(0, (f.limit || 6) - (f.fuse || 0)) + ' 轮'; el.onclick = null; }
  }

  function avatarHtml(id, name) {
    const rec = st.members.get(name);
    if (rec && rec.avatar) return `<span class="av" data-mem="${id}" title="查看${esc(name)}档案"><img src="${rec.avatar}" alt=""/></span>`;
    const col = colorOf(id);
    return `<span class="av" style="background:var(--${col}-soft); color:var(--${col})" data-mem="${id}" title="查看${esc(name)}档案">${esc((name || '?').slice(0, 1))}</span>`;
  }
  const fmtT = ts => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  function visible(ev) {
    if (st.channel === 'group') {
      if (['turn', 'conflict', 'reverted', 'resetTo', 'sys'].includes(ev.kind)) return true;
      if (ev.kind === 'boss') return ev.scope === 'group';
      if (ev.kind === 'msg') return ev.scope === 'group';
      if (ev.kind === 'receipt') return ev.scope !== 'dm';
      return false;
    }
    if (st.channel === 'listen') return ev.kind === 'listen' || ev.kind === 'listen-reply';
    const id = st.channel.slice(3);
    const m = sess(id);
    if (ev.kind === 'boss') return ev.scope === 'dm' && ev.dmWith === id;
    if (ev.kind === 'msg') return ev.scope === 'dm' && ev.sessionId === id;
    if (ev.kind === 'receipt') return ev.scope === 'dm' && ev.sessionId === id; // 私聊已读 ✓
    // TA 与同事的 clideck ask 往来也显示在 TA 的私聊窗（旧事件没有 fromId/toId，按名字兜底）
    if (ev.kind === 'listen') return ev.toId === id || ev.fromId === id || (m && ev.from === m.name);
    if (ev.kind === 'listen-reply') return ev.fromId === id || ev.toId === id || (m && ev.to === m.name);
    if (ev.kind === 'raw-user' || ev.kind === 'raw-agent') return ev.sessionId === id; // 终端工作日志只进成员私聊窗
    return false;
  }

  let streamRaf = 0; // 事件风暴入口（chat/typing）合并到一帧一次全量重建；切频道等低频路径仍直呼 renderStream
  function scheduleStream() { if (streamRaf) return; streamRaf = requestAnimationFrame(() => { streamRaf = 0; renderStream(); }); }
  function renderStream() {
    const list = jlist().filter(visible);
    const ackMap = new Map(); // 消息编号 -> 回执们（吸附到对应气泡下，不受到达顺序影响）
    for (const ev of list) if (ev.kind === 'receipt' && ev.ackOf) { if (!ackMap.has(ev.ackOf)) ackMap.set(ev.ackOf, []); ackMap.get(ev.ackOf).push(ev); }
    const rlineHtml = evs => {
      const seen = new Map(); // 同一成员多条回执只留一个头像
      for (const r of evs) seen.set(r.member, r);
      const items = [...seen.values()].map(r => r.timeout
        ? `<span title="${esc(r.member)} 处理超时（工位可能卡住，点头像看终端）" style="opacity:.55">⏱${avatarHtml(r.sessionId, r.member)}</span>`
        : `<span title="${esc(r.member)} 已读">${avatarHtml(r.sessionId, r.member)}</span>`).join('');
      return `<div class="rline"><span>✓</span>${items}</div>`;
    };
    let h = '', pendingReceipts = [];
    const flushR = () => { if (!pendingReceipts.length) return; h += rlineHtml(pendingReceipts); pendingReceipts = []; };
    for (const ev of list) {
      if (ev.kind === 'receipt') { if (!ev.ackOf) pendingReceipts.push(ev); continue; } // 无编号的老回执走旧的按时间排
      flushR();
      if (ev.kind === 'boss' || ev.kind === 'raw-user') {
        const tag = ev.kind === 'raw-user' ? `<span class="tag">原版界面输入 · ${esc(ev.member)}</span>` : '';
        h += `<div class="row me"><span class="av boss">你</span><span class="bwrap"><span class="meta">${tag}${esc(st.bossName)} · ${fmtT(ev.ts)}</span><div class="bub">${esc(ev.text)}</div></span></div>`;
      } else if (ev.kind === 'msg') {
        if (clientChrome(ev.text)) continue;
        h += `<div class="row">${avatarHtml(ev.sessionId, ev.from)}<span class="bwrap"><span class="meta">${esc(ev.from)} · ${fmtT(ev.ts)}</span><div class="bub md">${mdHtml(ev.text)}</div></span></div>`;
      } else if (ev.kind === 'raw-agent') {
        h += `<div class="receipt" data-rc><span>${esc(ev.member)} 的终端工作日志 · ${fmtT(ev.ts)}</span> <button>展开</button><div class="detail">${esc(ev.text)}</div></div>`;
      } else if (ev.kind === 'listen') {
        h += `<div class="row"><span class="av" style="background:var(--panel2); color:var(--ink2)">${esc(ev.from.slice(0, 1))}</span><span class="bwrap"><span class="meta">${esc(ev.from)} 问 ${esc(ev.to)} · ${fmtT(ev.ts)}</span><div class="bub md"><div class="quote">ask → ${esc(ev.to)}</div>${mdHtml(ev.text)}</div></span></div>`;
      } else if (ev.kind === 'listen-reply') {
        h += `<div class="row">${avatarHtml(ev.fromId, ev.from)}<span class="bwrap"><span class="meta">${esc(ev.from)} 答 ${esc(ev.to)} · ${fmtT(ev.ts)}</span><div class="bub md">${mdHtml(ev.text)}</div></span></div>`;
      } else if (ev.kind === 'turn') {
        const amb = ev.others && ev.others.length ? `<span style="color:var(--ink3)">（当时 ${esc(ev.others.join('、'))} 也在干活，归属按收工先后判定）</span>` : '';
        h += `<div class="snap"><span class="card"><svg class="ico" style="width:14px;height:14px"><use href="#i-camera"/></svg> ${esc(ev.member)} ${fmtT(ev.ts)} 收工 · 改动 ${ev.files.length} 个文件（${esc(ev.files.slice(0, 3).join('、'))}${ev.files.length > 3 ? '…' : ''}）${amb} <button class="act" data-roll="${ev.turnId}">撤销这轮</button><button class="act" data-reset="${ev.turnId}" style="color:var(--ink3)">回到此刻</button></span></div>`;
      } else if (ev.kind === 'conflict') {
        h += `<div class="sysalert"><span class="ttl"><svg class="ico" style="width:13px;height:13px"><use href="#i-alert"/></svg> 覆盖提醒</span> · <b>${esc(ev.a)}</b> 与 <b>${esc(ev.b)}</b> 先后改了 <code>${esc(ev.files.join('、'))}</code>，两个版本都在快照里，可用「撤销这轮」找回。</div>`;
      } else if (ev.kind === 'reverted') {
        h += `<div class="sysline">已撤销「${esc(ev.member)}」那一轮的 ${ev.files.length} 个文件改动 · 已广播更正声明</div>`;
      } else if (ev.kind === 'resetTo') {
        h += `<div class="sysline">工作区已整体回退到「${esc(ev.member)}」那一轮之前 · 已广播更正声明</div>`;
      } else if (ev.kind === 'sys') {
        h += `<div class="sysline">${esc(ev.text)}</div>`;
      }
      if (ev.mid && ackMap.has(ev.mid)) h += rlineHtml(ackMap.get(ev.mid));
    }
    flushR();
    // 批准卡（未落日志的活动状态）
    for (const [id, m] of st.menus) {
      const s = sess(id); if (!s || s.projectId !== st.pid) continue;
      if (st.channel !== 'group' && st.channel !== 'dm-' + id) continue;
      let btns = '';
      (m.choices || []).forEach((c, i) => {
        const label = typeof c === 'string' ? c : (c.label || c.value || String(i + 1));
        const val = typeof c === 'object' && c.value ? String(c.value) : String(i + 1);
        btns += `<button class="btn ${i === 0 ? 'pri' : ''}" data-menu="${id}" data-val="${esc(val)}">${esc(label).slice(0, 40)}</button>`;
      });
      h += `<div class="row">${avatarHtml(id, s.name)}<span class="bwrap"><span class="meta">${esc(s.name)} · 请求批准</span><div class="acard"><div class="h"><svg class="ico" style="color:var(--warn)"><use href="#i-alert"/></svg> 需要你拍板</div><div class="cmd">${esc(m.header || '（看不清上下文时点头像 → 看原始终端）')}</div><div class="btns">${btns}<button class="btn" data-always="${id}">今后自动允许</button></div></div></span></div>`;
    }
    $('#stream').innerHTML = h + typingHtml();
    $('#stream').scrollTop = $('#stream').scrollHeight;
  }
  function typingHtml() {
    if (st.channel === 'listen') return '';
    const who = memberList().filter(m => m.working && (st.channel === 'group' || st.channel === 'dm-' + m.id));
    return who.length ? `<div class="typing"><span class="shim">${esc(who.map(m => m.name).join('、'))} 正在干活…</span></div>` : '';
  }
  function renderTyping() { scheduleStream(); }

  // ---------- @ 选人卡片（群聊/旁听输入框；@某人 = 让TA优先拿发言权） ----------
  let mention = null; // {start, end, items, sel}：start=@ 的下标，end=光标位置
  function mentionCandidates(q) {
    const live = memberList();
    const liveBy = new Map(live.map(s => [s.name, s]));
    const names = [...st.members.keys()];                          // 档案顺序 = 默认发言顺序
    for (const s of live) if (!names.includes(s.name)) names.push(s.name); // 没档案的在岗成员排最后
    const ql = String(q || '').toLowerCase();
    return names.filter(n => !ql || n.toLowerCase().includes(ql)).slice(0, 8)
      .map(n => { const rec = st.members.get(n) || {}; const s = liveBy.get(n); return { name: n, identity: rec.identity || '', avatar: rec.avatar || '', live: !!s }; });
  }
  function mentionScan() {
    if (st.channel.startsWith('dm-')) return closeMention();       // 私聊只有一个人，@ 没有意义
    const el = $('#input');
    const pos = el.selectionStart, txt = el.value;
    let i = pos - 1;
    while (i >= 0 && txt[i] !== '@' && !/\s/.test(txt[i])) i--;    // 从光标往回找最近的 @，先撞到空白就说明不在点名
    if (i < 0 || txt[i] !== '@') return closeMention();
    const q = txt.slice(i + 1, pos);
    if (q.length > 16) return closeMention();
    const items = mentionCandidates(q);
    if (!items.length) return closeMention();
    mention = { start: i, end: pos, items, sel: 0 };
    renderMention();
  }
  function renderMention() {
    const p = $('#mpop');
    if (!mention) { p.classList.remove('open'); return; }
    p.innerHTML = mention.items.map((it, i) => `<button data-mi="${i}" class="${i === mention.sel ? 'on' : ''}" role="option">
      <span class="mav">${it.avatar ? `<img src="${it.avatar}" alt=""/>` : esc(it.name.slice(0, 1))}</span>
      <b>${esc(it.name)}</b><span class="idt">${esc(it.identity)}</span>${it.live ? '' : '<span class="off">未上线</span>'}</button>`).join('');
    const r = $('#input').getBoundingClientRect();
    p.style.left = r.left + 'px';
    p.style.bottom = (innerHeight - r.top + 8) + 'px';
    p.classList.add('open');
  }
  function pickMention(i) {
    if (!mention) return;
    const it = mention.items[i]; if (!it) return;
    const el = $('#input'), v = el.value;
    el.value = v.slice(0, mention.start) + '@' + it.name + ' ' + v.slice(mention.end);
    const caret = mention.start + it.name.length + 2;
    closeMention();
    el.focus(); el.setSelectionRange(caret, caret);
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }
  function closeMention() { if (mention) { mention = null; $('#mpop').classList.remove('open'); } }

  // ---------- 发送 ----------
  // 可接续记录：同名多条（多次重启存档）取最近保存的那份
  function resumableOf(name) {
    const recs = st.resumable.filter(x => x.projectId === st.pid && x.name === name)
      .sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
    return recs[recs.length - 1] || null;
  }
  // 默认接续：给群里发消息时，把有档案但离线的成员带着记忆接回来（点"上岗"才是换新脑子）
  function resumeOffline() {
    if (!st.pid) return [];
    const live = new Set(memberList().map(s => s.name));
    const names = [];
    for (const seatName of st.members.keys()) {
      if (live.has(seatName)) continue;
      const rec = resumableOf(seatName);
      if (!rec) continue;
      send({ type: 'session.resume', id: rec.id });
      st.resumable = st.resumable.filter(x => x.id !== rec.id);
      names.push(seatName);
    }
    if (names.length) plug('seatsResuming', { projectId: st.pid, names });
    return names;
  }
  function doSend() {
    const v = $('#input').value.trim(); if (!v || !st.pid) return;
    const scope = st.channel.startsWith('dm-') ? 'dm' : 'group';
    const back = scope === 'group' ? resumeOffline() : [];
    if (!memberList().length && !back.length) { toast('先添加成员再发言（老成员可在群设置里上岗）'); return; }
    if (back.length) toast('正在把 ' + back.join('、') + ' 带记忆接回，消息等他们就位后开始传阅');
    plug('send', { projectId: st.pid, scope, targetId: scope === 'dm' ? st.channel.slice(3) : undefined, text: v });
    $('#input').value = '';
    $('#input').style.height = 'auto';
    closeMention();
  }

  // ---------- 成员档案抽屉 ----------
  function openDrawer(id) {
    const m = sess(id); if (!m) return;
    const col = colorOf(id);
    const rec0 = st.members.get(m.name);
    if (rec0 && rec0.avatar) { $('#dAv').style.background = 'none'; $('#dAv').innerHTML = `<img src="${rec0.avatar}" alt=""/>`; }
    else { $('#dAv').style.background = `var(--${col}-soft)`; $('#dAv').style.color = `var(--${col})`; $('#dAv').textContent = m.name.slice(0, 1); }
    $('#dName').textContent = m.name; $('#dEngine').textContent = engineOf(m);
    $('#dModel').textContent = (() => { const c = (st.config?.commands || []).find(c => c.id === m.commandId); const mm = c && /--model[= ]([\w.:-]+)/.exec(c.command); return mm ? mm[1] : '引擎默认'; })();
    setRing(st.ctxEst.get(id) || 0);
    $('#dDm').onclick = () => { $('#drawer').classList.remove('open'); switchChan('dm-' + id); };
    $('#compactBtn').onclick = () => { send({ type: 'input', id, data: '/compact' }); setTimeout(() => send({ type: 'input', id, data: '\r' }), 150); plug('recharter', { projectId: st.pid, sessionId: id }); toast('已发送 /compact，完成后会自动给TA补发章程'); };
    $('#dModelBtn').onclick = () => {
      // 各家 /model 菜单的持久化行为不同（实测 2026-07）：codex 选了就写 ~/.codex/config.toml 全局默认；claude 系仅本会话
      const c = (st.config?.commands || []).find(x => x.id === m.commandId) || {};
      const isCodex = /codex/i.test((c.label || '') + ' ' + (c.command || ''));
      const isClaude = /^\s*claude\b/i.test(c.command || '');
      const relay = isClaude && ((c.env && c.env.ANTHROPIC_BASE_URL) || /--settings\b/.test(c.command || ''));
      if (isCodex && !confirm('注意：Codex 的模型菜单会把选择保存为全局默认——影响所有 Codex 工位和你自己以后的 Codex 会话，不只是这个工位。仍要打开吗？')) return;
      $('#drawer').classList.remove('open'); openRaw(id);
      setTimeout(() => { send({ type: 'input', id, data: '/model' }); setTimeout(() => send({ type: 'input', id, data: '\r' }), 200); }, 400);
      toast(isCodex ? '已打开模型菜单：方向键选择，回车确认（Codex 的选择会成为全局默认）'
        : isClaude ? ('已打开模型菜单：方向键选择，回车确认（仅本会话生效' + (relay ? '；此工位走中转，菜单里的型号名只是壳，实际模型由中转方决定，一般不用换' : '') + '）')
        : '已打开模型菜单：方向键选择，回车确认（注意：部分引擎会把选择保存为全局默认）');
    };
    $('#dRaw').onclick = () => { $('#drawer').classList.remove('open'); openRaw(id); };
    $('#dRename').onclick = () => { const n = prompt('新名字（同事互相喊人用它）：', m.name); if (n && n.trim() && n.trim() !== m.name) send({ type: 'rename', id, name: n.trim() }); };
    $('#dRestart').onclick = () => { if (confirm('重开会话：' + m.name + ' 将失忆重来（会话可恢复则接续）。重开后系统会自动补发章程和角色卡。确定？')) { send({ type: 'session.restart', id }); plug('recharter', { projectId: st.pid, sessionId: id }); } };
    $('#dKick').onclick = () => { if (confirm('移出工位：关闭「' + m.name + '」的终端并从群里移除。确定？')) { send({ type: 'close', id }); $('#drawer').classList.remove('open'); if (st.channel === 'dm-' + id) switchChan('group'); } };
    $('#drawer').classList.add('open');
  }
  function setRing(pct) { const c = 2 * Math.PI * 27; $('#ringVal').setAttribute('stroke-dasharray', `${c * pct / 100} ${c}`); $('#ringVal').style.stroke = pct > 75 ? 'var(--danger)' : pct > 55 ? 'var(--warn)' : 'var(--ok)'; $('#ctxPct').textContent = pct + '%'; document.querySelector('.ctxnum small').textContent = '估算值 · 后续接遥测精化'; }

  // ---------- 原始终端查看 ----------
  function openRaw(id) {
    const o = st.terms.get(id); if (!o) return toast('该工位还没有终端数据');
    let bg = $('#rawBg');
    if (!bg) {
      bg = document.createElement('div'); bg.id = 'rawBg'; bg.className = 'modal-bg';
      bg.innerHTML = '<div class="modal" style="width:min(1240px,96vw)"><h3>原始终端（可直接打字操作）</h3><div id="rawHost" style="background:#000; border-radius:10px; padding:10px; overflow:auto; max-height:74vh"></div><div class="btns" style="margin-top:12px"><button class="btn" id="rawClose">关闭</button></div></div>';
      document.body.appendChild(bg);
      bg.addEventListener('pointerdown', e => { bg._downOnBg = e.target === bg; });
      bg.addEventListener('click', e => {
        const onBg = e.target === bg && bg._downOnBg;
        bg._downOnBg = false;
        if (onBg || e.target.id === 'rawClose') { $('#terms').appendChild(st.rawOpen.div); st.rawOpen = null; bg.classList.remove('open'); }
      });
    }
    if (!o.wired) { o.term.onData(d => send({ type: 'input', id, data: d })); o.wired = true; }
    $('#rawHost').appendChild(o.div); o.div.style.display = ''; st.rawOpen = o;
    bg.classList.add('open');
    setTimeout(() => {
      try { o.term.refresh(0, o.term.rows - 1); o.term.scrollToBottom(); o.term.focus(); } catch (e) {}
      send({ type: 'resize', id, cols: COLS, rows: ROWS });
    }, 120);
  }

  // ---------- 建群 / 群设置 / 成员档案 / 模板编辑（v0.2.0 源头-印刷品体系） ----------
  const INP = 'style="width:100%; font:inherit; padding:8px 10px; border:1px solid var(--line2); border-radius:9px; background:var(--chip); color:var(--ink)"';
  const TXA = 'style="width:100%; font:inherit; padding:8px 10px; border:1px solid var(--line2); border-radius:9px; background:var(--chip); color:var(--ink); min-height:70px; resize:vertical"';
  function agentCmds() { return (st.config?.commands || []).filter(c => c.enabled && c.isAgent); }
  // 新群登记进上游配置（建群/克隆共用）：路径校验+归一+发号；失败用 unregisterProject 回滚
  const PALETTE = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#3161D1', '#ef4444'];
  function registerProject(name, rawDir) {
    let dir = String(rawDir || '').trim();
    if (!/^[A-Za-z]:[\\/]/.test(dir)) { toast('文件夹要填完整路径，例如 C:\\projects\\portfolio'); return null; }
    dir = dir.replace(/\//g, '\\').replace(/\\+$/, '');
    const pid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    send({ type: 'config.update', config: { projects: [...st.projects, { id: pid, name, path: dir, color: PALETTE[st.projects.length % PALETTE.length], collapsed: false }] } });
    return { pid, dir };
  }
  const unregisterProject = pid => send({ type: 'config.update', config: { projects: st.projects.filter(p => p.id !== pid) } });
  function switchGroup(pid) { st.pid = pid; localStorage.setItem('kfq.pid', pid); st.channel = 'group'; renderRail(); renderSide(); renderStream(); hello(); }
  // 开工位的唯一入口：pendingSeats 登记（'created' 事件靠它触发入职通知）与 create 消息永远成对
  function createSeat(pid, seatName, commandId, cwd, delay) {
    st.pendingSeats.push({ pid, seatName, commandId });
    const go = () => send({ type: 'create', commandId, name: seatName, projectId: pid, cwd, cols: COLS, rows: ROWS });
    if (delay) setTimeout(go, delay); else go();
  }
  function modal(id, html) {
    let bg = $('#' + id); if (bg) bg.remove();
    bg = document.createElement('div'); bg.id = id; bg.className = 'modal-bg open';
    bg.innerHTML = html;
    document.body.appendChild(bg);
    // 按下和松手都落在遮罩上才算"点遮罩关闭"——防止从卡片里拖选文字滑出边缘误关
    bg.addEventListener('pointerdown', e => { bg._downOnBg = e.target === bg; });
    bg.addEventListener('click', e => { if (e.target === bg && bg._downOnBg) bg.remove(); bg._downOnBg = false; });
    return bg;
  }

  function openGroupCreate() {
    const bg = modal('gcBg', `<div class="modal" style="width:min(620px,94vw)"><h3>开新群</h3>
      <p>群名（必填）：</p><input id="gcName" ${INP} placeholder="例如：简历工作室"/>
      <p style="margin-top:10px">工作文件夹（必填，成员只在里面干活）：</p>
      <div style="display:flex; gap:8px"><span style="flex:1"><input id="gcPath" ${INP} placeholder="点右边「浏览」选，或直接粘贴完整路径"/></span><button class="btn" id="gcBrowse" style="flex-shrink:0">浏览…</button></div>
      <p style="margin-top:10px">核心任务（可选，写进章程）：</p><textarea id="gcTask" ${TXA} placeholder="这个群要达成什么。例：两周内产出一份能投大厂的中文简历"></textarea>
      <p style="margin-top:10px">团队指令（可选，对所有成员生效）：</p><textarea id="gcIns" ${TXA} placeholder="例：所有产出先给我过目再定稿；语气专业克制"></textarea>
      <label style="display:flex; gap:8px; align-items:center; margin-top:10px; font-size:13px"><input type="checkbox" id="gcGit" checked/> 启用文件快照（「撤销这轮/回到此刻」依赖它）</label>
      <div class="btns" style="margin-top:12px"><button class="btn" id="gcCancel">取消</button><button class="btn pri" id="gcOk">建群</button></div></div>`);
    $('#gcCancel').onclick = () => bg.remove();
    $('#gcBrowse').onclick = () => { plug('pickFolder', {}); toast('已打开文件夹选择窗口（若没看见，检查任务栏）'); };
    $('#gcOk').onclick = () => {
      const name = $('#gcName').value.trim();
      if (!name) return toast('先起个群名');
      const reg = registerProject(name, $('#gcPath').value);
      if (!reg) return;
      st.gcPending = { pid: reg.pid, name };
      plug('groupCreate', { projectId: reg.pid, name, path: reg.dir, task: $('#gcTask').value.trim(), instructions: $('#gcIns').value.trim(), snapshot: $('#gcGit').checked });
      bg.remove();
    };
  }

  // 克隆群 = 纯复制：配置和成员档案原样带走（含头像与引擎），全新记忆，建好后自动逐个上岗；原群保持原状继续可用
  function openGroupClone(g) {
    const cmds = st.config?.commands || [];
    const engName = cid => { const c = cmds.find(x => x.id === cid); return c ? c.label : ''; };
    const mrows = (g.members || []).map(x => `<li style="margin:2px 0">${esc(x.seatName)}${x.commandId ? '（' + esc(engName(x.commandId) || '引擎已记录') + '）' : '<span style="color:var(--warn)">（引擎没记录，克隆后上岗时选）</span>'}</li>`).join('') || '<li>（源群还没有成员档案）</li>';
    const bg = modal('gclBg', `<div class="modal" style="width:min(620px,94vw)"><h3>克隆此群 · 配置带走，脑子全新</h3>
      <p>新群名：</p><input id="gclName" ${INP} value="${esc((g.name || '') + '·新')}"/>
      <p style="margin-top:10px">工作文件夹：</p>
      <div style="display:flex; gap:8px"><span style="flex:1"><input id="gclPath" ${INP} value="${esc((proj() || {}).path || '')}"/></span><button class="btn" id="gclBrowse" style="flex-shrink:0">浏览…</button></div>
      <p style="font-size:12px; color:var(--ink3); margin-top:4px">克隆只复制配置，<b>原群保持原状、照常可用</b>。保持原路径 = <b>共用文件夹</b>：新群和原群在同一个文件夹里干活（文件、代码、git 历史共享；聊天、章程、成员记忆各自独立）——同时开工时留意别让两拨人改同一处代码。<br/>填一个新路径 = <b>另起项目</b>：文件夹从零开始，与原群互不相干。</p>
      <p style="margin-top:10px">核心任务（可顺手改成新目标）：</p><textarea id="gclTask" ${TXA}>${esc(g.task || '')}</textarea>
      <p style="margin-top:10px">团队指令：</p><textarea id="gclIns" ${TXA}>${esc(g.instructions || '')}</textarea>
      <label style="display:flex; gap:8px; align-items:center; margin-top:10px; font-size:13px"><input type="checkbox" id="gclGit" checked/> 启用文件快照</label>
      <p style="margin-top:10px">原样带走的成员档案（工位为全新记忆，建好后自动依次上岗）：</p><ul style="margin:4px 0 0 18px; font-size:13px">${mrows}</ul>
      <div class="btns" style="margin-top:12px"><button class="btn" id="gclCancel">取消</button><button class="btn pri" id="gclOk">克隆</button></div></div>`);
    $('#gclCancel').onclick = () => bg.remove();
    $('#gclBrowse').onclick = () => { plug('pickFolder', {}); toast('已打开文件夹选择窗口（若没看见，检查任务栏）'); };
    $('#gclOk').onclick = () => {
      const name = $('#gclName').value.trim();
      if (!name) return toast('先起个群名');
      const reg = registerProject(name, $('#gclPath').value);
      if (!reg) return;
      st.gcClone = { pid: reg.pid, name, dir: reg.dir };
      plug('groupClone', { sourceId: st.pid, projectId: reg.pid, name, path: reg.dir, task: $('#gclTask').value, instructions: $('#gclIns').value, snapshot: $('#gclGit').checked });
      bg.remove();
    };
  }

  function openMemberForm(opts) { // {mode:'add'|'edit'|'attach', seatName?, data?}
    const isAdd = opts.mode === 'add';
    const d = opts.data || {};
    const cmds = agentCmds();
    const engineRow = isAdd ? `<p style="margin-top:10px">引擎：</p><div>${cmds.map((c, i) => `<label style="display:inline-flex; gap:6px; align-items:center; margin-right:14px; font-size:13.5px"><input type="radio" name="mfEng" value="${c.id}" ${i === 0 ? 'checked' : ''}/> ${esc(c.label)}</label>`).join('') || '没有可用引擎'}</div>` : '';
    const bg = modal('mfBg', `<div class="modal" style="width:min(620px,94vw)"><h3>${isAdd ? '添加成员' : (opts.mode === 'attach' ? '补建档案 · ' : '编辑档案 · ') + esc(opts.seatName || '')}</h3>
      ${isAdd ? `<p>名字（同事互相喊人用它）：</p><input id="mfName" ${INP} placeholder="例如：主笔"/>` : ''}
      ${engineRow}
      <p style="margin-top:10px">头像（可选）：</p>
      <div style="display:flex; align-items:center; gap:10px">
        <span id="mfAvPrev" class="av" style="width:44px; height:44px; background:var(--chip); color:var(--ink3); font-size:11px; overflow:hidden; cursor:default">${d.avatar ? `<img src="${d.avatar}" alt=""/>` : '首字'}</span>
        <input type="file" id="mfAvFile" accept="image/*" style="display:none"/>
        <button class="btn" id="mfAvPick">选图片…</button>
        <button class="btn" id="mfAvClear">用首字</button>
      </div>
      <p style="margin-top:10px">一句话身份（写进章程分工表，给同事看）：</p><input id="mfId" ${INP} value="${esc(d.identity || '')}" placeholder="例如：文字担当，负责简历正文与措辞"/>
      <p style="margin-top:10px">职责（做什么、边界、核心目标）：</p><textarea id="mfDuty" ${TXA} placeholder="例：负责简历正文与措辞打磨；只改文字不动排版；目标是通过大厂初筛">${esc(d.duty || '')}</textarea>
      <p style="margin-top:10px">规范（行为约束）：</p><textarea id="mfRules" ${TXA} placeholder="例：改动前先备份原文；产出放 docs/；拿不准的表述先问我">${esc(d.rules || '')}</textarea>
      <div class="btns" style="margin-top:12px"><button class="btn" id="mfCancel">取消</button><button class="btn pri" id="mfOk">${isAdd ? '开工位' : '保存'}</button></div></div>`);
    $('#mfCancel').onclick = () => bg.remove();
    let mfAvatar = d.avatar || '';
    $('#mfAvPick').onclick = () => $('#mfAvFile').click();
    $('#mfAvClear').onclick = () => { mfAvatar = ''; $('#mfAvPrev').innerHTML = '首字'; };
    $('#mfAvFile').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          const S = 96, c = document.createElement('canvas'); c.width = S; c.height = S;
          const x = c.getContext('2d'); const s = Math.max(S / img.width, S / img.height);
          x.drawImage(img, (S - img.width * s) / 2, (S - img.height * s) / 2, img.width * s, img.height * s);
          mfAvatar = c.toDataURL('image/jpeg', 0.82);
          $('#mfAvPrev').innerHTML = `<img src="${mfAvatar}" alt=""/>`;
        };
        img.src = String(r.result);
      };
      r.readAsDataURL(f);
    };
    $('#mfOk').onclick = () => {
      const identity = $('#mfId').value.trim(), duty = $('#mfDuty').value.trim(), rules = $('#mfRules').value.trim();
      if (isAdd) {
        const seatName = $('#mfName').value.trim();
        if (!seatName) return toast('先起个名字');
        if (seatName.length > 16 || /[，。；、！？,.;!?]/.test(seatName)) return toast('名字要短（同事喊人用的称呼）——长描述请放进"一句话身份"');
        const eng = bg.querySelector('input[name=mfEng]:checked');
        if (!eng) return toast('先选引擎');
        st.pendingSeats.push({ pid: st.pid, seatName, commandId: eng.value });
        plug('memberAdd', { projectId: st.pid, seatName, identity, duty, rules, avatar: mfAvatar, commandId: eng.value });
      } else if (opts.mode === 'attach') {
        plug('memberAdd', { projectId: st.pid, seatName: opts.seatName, identity, duty, rules, avatar: mfAvatar });
      } else {
        plug('memberUpdate', { projectId: st.pid, seatName: opts.seatName, identity, duty, rules, avatar: mfAvatar });
      }
      bg.remove();
    };
  }

  // 让已有档案的成员（重启后/被误关）重新开工位；档案没记引擎时弹选择
  function startSeat(seatName, commandId) {
    const cmds = agentCmds();
    const go = cid => {
      createSeat(st.pid, seatName, cid, (proj() || {}).path);
      toast('「' + seatName + '」工位启动中，入职通知随后送达…');
    };
    if (commandId && cmds.some(c => c.id === commandId)) return go(commandId);
    const bg = modal('seBg', `<div class="modal"><h3>让「${esc(seatName)}」上岗</h3><p>用哪个引擎：</p>
      <div>${cmds.map((c, i) => `<label style="display:flex; gap:8px; align-items:center; padding:5px 2px; font-size:13.5px"><input type="radio" name="seEng" value="${c.id}" ${i === 0 ? 'checked' : ''}/> ${esc(c.label)}</label>`).join('') || '没有可用引擎'}</div>
      <div class="btns" style="margin-top:12px"><button class="btn" id="seCancel">取消</button><button class="btn pri" id="seOk">上岗</button></div></div>`);
    $('#seCancel').onclick = () => bg.remove();
    $('#seOk').onclick = () => { const eng = bg.querySelector('input[name=seEng]:checked'); if (!eng) return toast('先选引擎'); bg.remove(); go(eng.value); };
  }

  function openGroupSettings() { st.gsWait = true; plug('groupGet', { projectId: st.pid }); }
  function renderGroupSettings(m) {
    const g = m.group || {}, legacy = m.mode === 'legacy', ro = legacy;
    const liveNames = memberList().map(s => s.name);
    const recNames = (g.members || []).map(x => x.seatName);
    const rows = (g.members || []).map(x => `<div draggable="true" data-drag="${esc(x.seatName)}" style="display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px dashed var(--line2); font-size:13.5px; cursor:grab">
        <span style="color:var(--ink3); cursor:grab" title="按住拖动调整发言顺序">⠿</span>
        <b style="min-width:76px">${esc(x.seatName)}</b><span style="flex:1; color:var(--ink3); font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(x.identity || '')}</span>
        <span style="font-size:11.5px; color:${liveNames.includes(x.seatName) ? 'var(--ok)' : 'var(--ink3)'}">${liveNames.includes(x.seatName) ? '在岗' : '未上线'}</span>
        ${liveNames.includes(x.seatName) ? '' : (resumableOf(x.seatName) ? `<button class="btn" data-gsresume="${esc(x.seatName)}" title="带着上次的记忆接着干">接续上岗</button>` : '') + `<button class="btn" data-gsup="${esc(x.seatName)}" title="全新记忆开工（发入职通知）">上岗</button>`}
        <button class="btn" data-gsedit="${esc(x.seatName)}">编辑</button><button class="btn" data-gskick="${esc(x.seatName)}" style="color:var(--danger)">移除</button></div>`).join('')
      + liveNames.filter(n => !recNames.includes(n)).map(n => `<div style="display:flex; align-items:center; gap:8px; padding:5px 0; font-size:13.5px"><b style="min-width:76px">${esc(n)}</b><span style="flex:1; color:var(--ink3); font-size:12.5px">（在岗，但没有档案）</span><button class="btn" data-gsattach="${esc(n)}">补建档案</button></div>`).join('');
    const bg = modal('gsBg', `<div class="modal" style="width:min(680px,94vw)"><h3>群设置 · ${esc(g.name || (proj() || {}).name || '')}</h3>
      ${legacy ? '<p style="font-size:12.5px; color:var(--warn); margin-bottom:8px">老格式群：章程是手写文件，下面的字段编辑对它不生效（想迁移到新体系喊 Claude）。</p>' : ''}
      <p>群名：</p><input id="gsName" ${INP} value="${esc(g.name || (proj() || {}).name || '')}" ${ro ? 'disabled' : ''}/>
      <p style="margin-top:10px">核心任务：</p><textarea id="gsTask" ${TXA} ${ro ? 'disabled' : ''}>${esc(g.task || '')}</textarea>
      <p style="margin-top:10px">团队指令（对所有成员生效）：</p><textarea id="gsIns" ${TXA} ${ro ? 'disabled' : ''}>${esc(g.instructions || '')}</textarea>
      <div class="mrow" style="margin-top:10px"><span>工作目录（不可更改）</span><span class="v" style="user-select:all">${esc(m.path || '')}</span></div>
      <label style="display:flex; gap:8px; align-items:center; margin-top:6px; font-size:13px"><input type="checkbox" id="gsGit" ${g.snapshot !== false ? 'checked' : ''} ${ro ? 'disabled' : ''}/> 启用文件快照</label>
      <div class="mrow" style="margin-top:8px"><span>聊天记录清理（只清你的账本，不动成员记忆）</span><span class="v"><button class="btn" id="gsClearSys">清系统动态</button><button class="btn" id="gsClearAll" style="color:var(--danger)">全部清空</button></span></div>
      <p style="margin-top:12px">成员（自上而下 = 群聊默认发言顺序，按住 ⠿ 拖动可调整；@某人则TA优先）：</p><div id="gsRows" style="max-height:180px; overflow:auto">${rows || '<span style="color:var(--ink3); font-size:13px">还没有成员，去左栏点「添加成员」</span>'}</div>
      <details style="margin-top:12px"><summary style="cursor:pointer; font-size:13px">章程预览（系统随入职通知直发给工位的内容，目录里不落文件）</summary>
        <pre style="max-height:240px; overflow:auto; font-size:12px; background:var(--chip); border:1px solid var(--line2); border-radius:8px; padding:10px; white-space:pre-wrap; margin-top:8px">${esc(m.teamPreview || '（还没有章程）')}</pre>
        ${ro ? '' : '<button class="btn" id="gsRegen" style="margin-top:6px" title="怀疑有成员断片忘了协议时点这个">重发章程给在岗成员</button>'}</details>
      <div class="btns" style="margin-top:12px"><button class="btn" id="gsRebrain" title="关闭所有工位，用相同名字和引擎重开全新记忆的会话">全员换脑</button>${ro ? '' : '<button class="btn" id="gsClone" title="成员档案和群配置原样复制成一个新群，工位全新记忆；原群不受影响。文件夹可共用原路径，也可另起新路径">克隆此群…</button>'}<span class="grow" style="flex:1"></span><button class="btn" id="gsCancel">关闭</button>${ro ? '' : '<button class="btn pri" id="gsSave">保存修改</button>'}</div></div>`);
    $('#gsCancel').onclick = () => bg.remove();
    // 全员换脑：同群同文件夹，工位全部重开为全新记忆（配置/聊天记录/文件快照都不动）
    const grb = $('#gsRebrain'); if (grb) grb.onclick = () => {
      const roster = g.members || [];
      const live = memberList();
      if (!roster.length && !live.length) return toast('群里还没有成员');
      if (!confirm('全员换脑：关闭所有在岗工位，用相同名字和引擎重开【全新记忆】的会话，并自动送达入职通知（会重读最新章程）。群配置、聊天记录、文件快照都不动。确定？')) return;
      bg.remove();
      const cmds = agentCmds();
      const seats = [], skipped = [], seen = new Set();
      for (const m of live) {
        const rec = roster.find(x => x.seatName === m.name);
        const cid = (rec && rec.commandId) || m.commandId;
        if (rec && !rec.commandId && m.commandId) plug('memberUpdate', { projectId: st.pid, seatName: m.name, commandId: m.commandId }); // 静默补记引擎
        send({ type: 'close', id: m.id });
        seen.add(m.name);
        if (cid && cmds.some(c => c.id === cid)) seats.push({ seatName: m.name, commandId: cid }); else skipped.push(m.name);
      }
      for (const rec of roster) {
        if (seen.has(rec.seatName)) continue;
        if (rec.commandId && cmds.some(c => c.id === rec.commandId)) seats.push({ seatName: rec.seatName, commandId: rec.commandId }); else skipped.push(rec.seatName);
      }
      seats.forEach((s0, i) => createSeat(st.pid, s0.seatName, s0.commandId, (proj() || {}).path, 1500 + i * 900));
      toast('全员换脑中：' + seats.length + ' 个工位将依次重开' + (skipped.length ? '；' + skipped.join('、') + ' 引擎没记录，去群设置手动上岗' : ''));
      if (st.channel.startsWith('dm-')) switchChan('group');
    };
    const gcl = $('#gsClone'); if (gcl) gcl.onclick = () => { bg.remove(); openGroupClone(g); };
    $('#gsClearSys').onclick = () => { if (confirm('清理本群聊天里的系统动态（上岗/广播线及其回执、终端画面折叠条），对话消息保留。继续？')) { plug('journalClear', { projectId: st.pid, mode: 'sys' }); bg.remove(); } };
    $('#gsClearAll').onclick = () => { if (confirm('清空本群全部聊天记录（消息、回执、完工快照卡都会消失；成员记忆和 git 文件历史不受影响，但界面上的「撤销这轮」入口会没掉，需要回滚时喊 Claude）。不可恢复，确定？')) { plug('journalClear', { projectId: st.pid, mode: 'all' }); bg.remove(); } };
    if (!ro) {
      $('#gsSave').onclick = () => {
        const name = $('#gsName').value.trim();
        plug('groupUpdate', { projectId: st.pid, name, task: $('#gsTask').value, instructions: $('#gsIns').value, snapshot: $('#gsGit').checked });
        if (name && proj() && name !== proj().name) send({ type: 'config.update', config: { projects: st.projects.map(p => p.id === st.pid ? { ...p, name } : p) } });
        bg.remove();
      };
      const rg = $('#gsRegen'); if (rg) rg.onclick = () => { plug('regen', { projectId: st.pid }); bg.remove(); };
    }
    // 拖动排序：松手后把新顺序整表发给服务端（顺序 = 默认发言顺序）
    const rowsBox = $('#gsRows');
    if (rowsBox && !ro) {
      const order0 = (g.members || []).map(x => x.seatName).join('|');
      let dragEl = null;
      rowsBox.querySelectorAll('[data-drag]').forEach(el => {
        el.addEventListener('dragstart', e => { dragEl = el; el.style.opacity = '.4'; try { e.dataTransfer.setData('text/plain', el.dataset.drag); e.dataTransfer.effectAllowed = 'move'; } catch {} });
        el.addEventListener('dragend', () => {
          el.style.opacity = '';
          const now = [...rowsBox.querySelectorAll('[data-drag]')].map(x => x.dataset.drag);
          if (now.join('|') !== order0 && now.length) plug('memberReorder', { projectId: st.pid, order: now });
          dragEl = null;
        });
        el.addEventListener('dragover', e => {
          e.preventDefault();
          if (!dragEl || dragEl === el) return;
          const rc = el.getBoundingClientRect();
          rowsBox.insertBefore(dragEl, (e.clientY - rc.top) < rc.height / 2 ? el : el.nextSibling);
        });
      });
      rowsBox.addEventListener('dragover', e => e.preventDefault());
    }
    bg.querySelectorAll('[data-gsup]').forEach(b => b.onclick = () => { const sn = b.dataset.gsup; const rec = (g.members || []).find(x => x.seatName === sn) || {}; bg.remove(); startSeat(sn, rec.commandId); });
    bg.querySelectorAll('[data-gsresume]').forEach(b => b.onclick = () => {
      const sn = b.dataset.gsresume; bg.remove();
      const rec = resumableOf(sn);
      if (!rec) return toast('没有可接续的会话存档，只能全新上岗');
      send({ type: 'session.resume', id: rec.id });
      st.resumable = st.resumable.filter(x => x.id !== rec.id);
      plug('seatsResuming', { projectId: st.pid, names: [sn] });
      toast('「' + sn + '」带记忆接回中…');
    });
    bg.querySelectorAll('[data-gsedit]').forEach(b => b.onclick = () => { const sn = b.dataset.gsedit; const rec = (g.members || []).find(x => x.seatName === sn); bg.remove(); openMemberForm({ mode: 'edit', seatName: sn, data: rec }); });
    bg.querySelectorAll('[data-gsattach]').forEach(b => b.onclick = () => { const sn = b.dataset.gsattach; bg.remove(); openMemberForm({ mode: 'attach', seatName: sn, data: {} }); });
    bg.querySelectorAll('[data-gskick]').forEach(b => b.onclick = () => {
      const sn = b.dataset.gskick;
      if (!confirm('移除成员「' + sn + '」：关闭工位并从章程分工表中删除（角色卡文件留档）。确定？')) return;
      const live = memberList().find(s => s.name === sn);
      plug('memberRemove', { projectId: st.pid, seatName: sn }); // 先发离职（服务端要趁工位活着定位广播收件人）
      if (live) send({ type: 'close', id: live.id });
      bg.remove();
      if (live && st.channel === 'dm-' + live.id) switchChan('group');
    });
  }

  function openTplEditor(which) { st.tplWait = which; plug('tplGet', {}); }
  function renderTplEditor(m) {
    const which = st.tplWait; st.tplWait = null;
    const t = which === 'role' ? m.role : m.team;
    if (!t) return;
    const title = which === 'role' ? '角色卡模板（role.template.md）' : '章程模板（TEAM.template.md）';
    const holders = which === 'role' ? '{{名字}} {{一句话身份}} {{职责}} {{规范}} {{用户称呼}}' : '{{群名}} {{路径}} {{核心任务}} {{附加指令}} {{成员表}} {{用户称呼}}';
    const bg = modal('teBg', `<div class="modal" style="width:min(760px,94vw)"><h3>${title}</h3>
      <p style="font-size:12px; color:var(--ink3); margin-bottom:8px">当前生效：<b>${t.source === 'custom' ? '你的自定义版' : '出厂默认版'}</b> · 程序会把这些占位符换成你填的字段：${esc(holders)}</p>
      <textarea id="teText" style="width:100%; font:12.5px/1.55 ui-monospace, Consolas, monospace; padding:10px; border:1px solid var(--line2); border-radius:9px; background:var(--chip); color:var(--ink); min-height:320px; resize:vertical">${esc(t.text)}</textarea>
      <div class="btns" style="margin-top:10px">
        <input type="file" id="teFile" accept=".md,.txt" style="display:none"/>
        <button class="btn" id="teImport">导入本地文件…</button>
        <button class="btn" id="teReset" ${t.source === 'custom' ? '' : 'disabled'}>恢复出厂默认</button>
        <button class="btn" id="teCancel">关闭</button><button class="btn pri" id="teSave">保存</button></div>
      <p style="font-size:11.5px; color:var(--ink3); margin-top:6px">模板只影响以后的生成（新群、加成员、点"重新生成"）；已有群的文件不会自动改。</p></div>`);
    $('#teCancel').onclick = () => bg.remove();
    $('#teImport').onclick = () => $('#teFile').click();
    $('#teFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('#teText').value = String(r.result).replace(/^﻿/, ''); toast('已读入「' + f.name + '」的内容，点保存生效'); }; r.readAsText(f, 'utf-8'); };
    $('#teSave').onclick = () => { plug('tplSave', { which, text: $('#teText').value }); bg.remove(); };
    $('#teReset').onclick = () => { if (confirm('丢弃自定义模板，恢复出厂默认？')) { plug('tplReset', { which }); bg.remove(); } };
  }

  function switchChan(ch) { st.channel = ch; closeMention(); renderSide(); renderStream(); }

  // 只为老账本（v0.3.x 横幅泄漏时代）兜底：整条全是界面符号/裸转义码才算噪音，符号类与 index.js chromeLine 保持一致。
  // 含真实文字的消息绝不吞——信封正文按契约原样入账，渲染层不做第二把清洗刀
  function clientChrome(t) {
    const lines = String(t || '').split('\n').map(l => l.trim()).filter(Boolean);
    const symbolic = l => /^[─—━═_\-=~|│┌┐└┘├┤╭╮╰╯╌·.…\s><*▀▄█▌▐■□▓▒░⠀-⣿]+$/.test(l) || /^[>›❯\s]*[\d;=]+[a-zA-Z](\s*[\d;=]+[a-zA-Z])*$/.test(l);
    return lines.length === 0 || lines.every(symbolic);
  }

  // ---------- 极简 markdown（成员气泡）：粗体/行内代码/围栏代码/列表/标题；
  // 单个换行按 md 规则并回同一段（终端转写的硬换行不再把句子撕两半），CJK 相邻处不加空格
  const CJK = /[⺀-鿿豈-﫿　-〿＀-￯]/;
  function joinLines(ls) {
    let s = '';
    for (const l of ls) {
      if (s) s += (CJK.test(s.slice(-1)) && CJK.test(l.charAt(0))) ? '' : ' ';
      s += l;
    }
    return s;
  }
  const mdInline = s => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const LI_RE = /^([-*]|\d{1,3}[.)])\s+(.*)$/;
  function mdHtml(src) {
    const lines = String(src ?? '').split('\n');
    const out = [];
    let i = 0, para = [];
    const flush = () => { if (para.length) { out.push('<p>' + mdInline(joinLines(para)) + '</p>'); para = []; } };
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s) { flush(); i++; continue; }
      if (s.startsWith('```')) {                       // 围栏代码原样保留
        flush(); const buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
        i++; out.push('<pre>' + esc(buf.join('\n')) + '</pre>'); continue;
      }
      const h = s.match(/^#{1,4}\s+(.*)$/);
      if (h) { flush(); out.push('<p class="mdh">' + mdInline(h[1]) + '</p>'); i++; continue; }
      const li = s.match(LI_RE);
      if (li) {
        flush();
        const ordered = /^\d/.test(li[1]);
        const start = ordered ? parseInt(li[1], 10) : 0;
        const items = [];
        while (i < lines.length) {
          let cur = lines[i].trim();
          if (!cur) {                                  // 空行后若还是同类型列表项 → 仍算同一张列表（md 宽松列表，编号不重头）
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            const nx = j < lines.length && lines[j].trim().match(LI_RE);
            if (!nx || /^\d/.test(nx[1]) !== ordered) break;
            i = j; cur = lines[i].trim();
          }
          const m = cur.match(LI_RE);
          if (!m || /^\d/.test(m[1]) !== ordered) break;
          const body = [m[2]]; i++;                    // 项内折行（含缩进续行）并回同一项
          while (i < lines.length && lines[i].trim() && !LI_RE.test(lines[i].trim()) && !lines[i].trim().startsWith('```')) { body.push(lines[i].trim()); i++; }
          items.push('<li>' + mdInline(joinLines(body)) + '</li>');
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + (start > 1 ? ' start="' + start + '"' : '') + '>' + items.join('') + '</' + tag + '>');
        continue;
      }
      para.push(s); i++;
    }
    flush();
    return out.join('');
  }

  function openSettings() {
    const lim = st.fuse.limit || 6;
    const bg = modal('setBg', `<div class="modal"><h3>设置</h3>
      <div class="mrow"><span>你的称呼（成员怎么叫你）</span><span class="v"><input id="setBoss" type="text" maxlength="12" value="${esc(st.bossName)}" style="width:110px; font:inherit; padding:5px 8px; border:1px solid var(--line2); border-radius:8px; background:var(--chip); color:var(--ink)"/></span></div>
      <div class="mrow"><span>熔断阈值（成员连续扩散条数）</span><span class="v"><input id="setFuse" type="number" min="2" max="30" value="${lim}" style="width:70px; font:inherit; padding:5px 8px; border:1px solid var(--line2); border-radius:8px; background:var(--chip); color:var(--ink)"/></span></div>
      <div class="mrow"><span>备份文件夹（群配置+聊天记录，留空=不备份）</span><span class="v"><input id="setBak" type="text" value="${esc(st.backupDir)}" placeholder="例如 C:\\AgentBureau-Backups" style="width:190px; font:inherit; padding:5px 8px; border:1px solid var(--line2); border-radius:8px; background:var(--chip); color:var(--ink)"/></span></div>
      <div class="mrow"><span>原版 CliDeck 界面（调试用）</span><span class="v"><button class="btn" id="setStock">新标签页打开</button></span></div>
      <div class="mrow"><span>章程模板（建群的底稿）</span><span class="v"><button class="btn" id="setTplTeam">查看/编辑</button></span></div>
      <div class="mrow"><span>角色卡模板（加成员的底稿）</span><span class="v"><button class="btn" id="setTplRole">查看/编辑</button></span></div>
      <div class="mrow"><span>版本</span><span class="v">界面 ${EXPECT} · 服务端 ${st.srv || '旧版（请重启服务器）'}</span></div>
      <p style="margin-top:8px; font-size:12px; color:var(--ink3)">备份只给你自己看：路径不会出现在任何成员的上下文里，也别把它设在群工作文件夹内（会被拒绝）。原版界面用完请关掉那个标签页——长开会和本界面抢终端快照。深浅色用左下角月亮切换。</p>
      <div class="btns" style="margin-top:10px"><button class="btn" id="setCancel">关闭</button><button class="btn pri" id="setOk">保存</button></div></div>`);
    $('#setCancel').onclick = () => bg.remove();
    $('#setStock').onclick = () => window.open('/', '_blank');
    $('#setTplTeam').onclick = () => { bg.remove(); openTplEditor('team'); };
    $('#setTplRole').onclick = () => { bg.remove(); openTplEditor('role'); };
    $('#setOk').onclick = () => {
      const v = Math.max(2, Math.min(30, Number($('#setFuse').value) || 6));
      send({ type: 'plugin.settings.update', pluginId: 'kaifabuqun', key: 'fuseLimit', value: v });
      st.fuse.limit = v; renderFuse();
      const bn = $('#setBoss').value.trim().slice(0, 12) || '用户';
      if (bn !== st.bossName) { send({ type: 'plugin.settings.update', pluginId: 'kaifabuqun', key: 'bossName', value: bn }); st.bossName = bn; renderStream(); renderHead(); }
      const bd = $('#setBak').value.trim();
      if (bd !== st.backupDir) { send({ type: 'plugin.settings.update', pluginId: 'kaifabuqun', key: 'backupDir', value: bd }); st.backupDir = bd; }
      bg.remove(); toast('已保存');
    };
  }

  // ---------- 全局点击 ----------
  document.addEventListener('click', e => {
    const pidBtn = e.target.closest('[data-pid]');
    if (pidBtn) { switchGroup(pidBtn.dataset.pid); return; }
    if (e.target.closest('#themeBtn')) { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; return; }
    if (e.target.closest('#stockBtn')) { openSettings(); return; }
    if (e.target.closest('#newGroup')) { openGroupCreate(); return; }
    if (e.target.closest('#teamBtn')) { openGroupSettings(); return; }
    if (e.target.closest('#addMem')) { openMemberForm({ mode: 'add' }); return; }
    const ch = e.target.closest('[data-chan]');
    if (ch) { switchChan(ch.dataset.chan); return; }
    const mem = e.target.closest('[data-mem]');
    if (mem) { openDrawer(mem.dataset.mem); return; }
    const rc = e.target.closest('[data-rc]');
    if (rc && e.target.tagName === 'BUTTON') { rc.classList.toggle('open'); e.target.textContent = rc.classList.contains('open') ? '收起' : '展开'; return; }
    const mb = e.target.closest('[data-menu]');
    if (mb) { const id = mb.dataset.menu; send({ type: 'input', id, data: mb.dataset.val === '1' ? '\r' : mb.dataset.val }); st.menus.delete(id); renderStream(); return; }
    const al = e.target.closest('[data-always]');
    if (al) { plug('autoApprove', { sessionId: al.dataset.always, enabled: true }); toast('该成员后续的菜单将自动确认'); return; }
    if (e.target.dataset.roll) { confirmModal(e.target.dataset.roll, 'revert'); return; }
    if (e.target.dataset.reset) { confirmModal(e.target.dataset.reset, 'reset'); return; }
  });

  function confirmModal(turnId, op) {
    const ev = jlist().find(x => x.kind === 'turn' && x.turnId === turnId); if (!ev) return;
    const bg = $('#modalBg');
    bg.querySelector('h3').textContent = op === 'revert' ? `撤销「${ev.member}」这一轮的改动？` : `回到「${ev.member}」这一轮开始之前？`;
    bg.querySelector('p').textContent = op === 'revert' ? `只反做这一轮碰过的 ${ev.files.length} 个文件，其他成员此后的改动不受影响：` : '警告：此后所有成员的所有文件改动都会作废：';
    bg.querySelector('ul').innerHTML = ev.files.map(f => `<li>${esc(f)}</li>`).join('');
    bg.querySelector('.note').textContent = '只恢复文件，不清除记忆——完成后自动在群里广播更正声明。';
    $('#mOk').textContent = op === 'revert' ? '确认撤销并广播' : '确认整体回退并广播';
    $('#mOk').onclick = () => { plug(op === 'revert' ? 'revertTurn' : 'resetTo', { projectId: st.pid, turnId }); bg.classList.remove('open'); };
    $('#mCancel').onclick = () => bg.classList.remove('open');
    bg.classList.add('open');
  }

  // ---------- 输入区 ----------
  $('#sendBtn').onclick = doSend;
  $('#input').addEventListener('keydown', e => {
    if (mention) { // 选人卡片开着：方向键选人，回车/Tab 确认，Esc 关闭——不触发发送
      if (e.key === 'ArrowDown') { e.preventDefault(); mention.sel = (mention.sel + 1) % mention.items.length; renderMention(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mention.sel = (mention.sel - 1 + mention.items.length) % mention.items.length; renderMention(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mention.sel); return; }
      if (e.key === 'Escape') { closeMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  $('#input').addEventListener('input', () => { const el = $('#input'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; mentionScan(); });
  $('#input').addEventListener('click', mentionScan); // 光标挪动后重新判断是否在 @ 词上
  $('#mpop').addEventListener('click', e => { const b = e.target.closest('[data-mi]'); if (b) pickMention(Number(b.dataset.mi)); });
  document.addEventListener('click', e => { if (!e.target.closest('#mpop') && e.target !== $('#input')) closeMention(); });
  $('#quickBtn').onclick = e => {
    const p = $('#qpop'); const r = e.target.closest('button').getBoundingClientRect();
    const prompts = [...(st.config?.prompts || []).map(x => x.text), '汇报一下各自手头进度，一句话即可。', '把今天的结论整理成会议纪要存到 docs\\，并在群里贴出路径。'];
    p.innerHTML = prompts.slice(0, 6).map(t => `<button data-q="${esc(t)}">${esc(t.slice(0, 30))}${t.length > 30 ? '…' : ''}</button>`).join('');
    p.style.left = Math.max(8, r.left - 20) + 'px'; p.style.bottom = (innerHeight - r.top + 10) + 'px'; p.classList.toggle('open'); e.stopPropagation();
  };
  document.addEventListener('click', e => { if (!e.target.closest('#qpop') && !e.target.closest('#quickBtn')) $('#qpop').classList.remove('open'); });
  $('#qpop').addEventListener('click', e => { if (e.target.dataset.q) { $('#input').value = e.target.dataset.q; $('#qpop').classList.remove('open'); $('#input').focus(); } });
  document.querySelector('.composer .ibtn.fr').onclick = () => {
    const path = prompt('附件路径（成员会按路径读取该文件）：'); if (!path) return;
    $('#input').value = ($('#input').value + '\n[附件] ' + path).trim(); $('#input').focus();
  };
  $('#drawerClose').onclick = () => $('#drawer').classList.remove('open');

  // ---------- 悬停滑块（沿用设计稿） ----------
  function glider(box, itemSel, activeSel) {
    const g = box.querySelector('.glide'); if (!g) return;
    const move = el => { if (!el) { g.style.opacity = '0'; return; } g.style.top = el.offsetTop + 'px'; g.style.left = el.offsetLeft + 'px'; g.style.width = el.offsetWidth + 'px'; g.style.height = el.offsetHeight + 'px'; g.style.opacity = '1'; };
    const rest = () => move(box.querySelector(activeSel));
    box._glideMove = move; box._glideRest = rest; // .glide 元素每次 innerHTML 重建都换新，闭包挂在容器上让老监听器指到新元素
    if (!box._glide) { // 容器常驻：监听器只绑一次，防每次 render 叠加一对新处理器（内存 + mouseover 串行跑全量的卡顿）
      box._glide = true;
      box.addEventListener('mouseover', e => { const b = e.target.closest(itemSel); if (b && box.contains(b)) box._glideMove(b); });
      box.addEventListener('mouseleave', () => box._glideRest());
    }
    g.style.transition = 'none'; rest(); requestAnimationFrame(() => { g.style.transition = ''; });
  }

  connect();
})();
