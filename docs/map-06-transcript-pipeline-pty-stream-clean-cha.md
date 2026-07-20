# Transcript pipeline: PTY stream → clean chat turns (transcript.js, transcript-parser.js, transcript-normalizer.js, transcript-candidate.js, ansi-utils.js in C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck)

## Summary
CliDeck turns raw PTY traffic into chat bubbles through two independent capture paths that both funnel into transcript.js store(). USER side: sessions.js writeSessionInput() calls transcript.trackInput(id, data) on every keystroke before pty.write; trackInput is a stateful char scanner that swallows OSC (ESC ] … BEL or ESC \), CSI (ESC [ … until a letter or '~'), and lone ESC+char sequences, applies backspace (\x7f/\x08), and on \r/\n stores the buffered trimmed line as a role:'user' entry — so user bubbles come from local keystroke reconstruction, never from terminal echo. AGENT side has two modes keyed by finalizePreset: (a) for plain shells, trackOutput() debounces raw PTY output 300ms, then flush() runs stripAnsi (ANSI_RE = /\x1b[\[\]()#;?]*[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g) plus a control-char strip /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, keeps trimmed lines longer than 2 chars, and stores them as one 'agent' entry; (b) for known agents ('claude-code','codex','gemini-cli','opencode','pi','clideck-agent', enabled via setFinalizeOnIdle at spawn, sessions.js:120), trackOutput is bypassed entirely — instead the server broadcasts {type:'terminal.capture', id} to the BROWSER, whose xterm.js instance replies {type:'terminal.buffer', id, lines} with buffer lines rendered via line.translateToString(true) (so ANSI is already gone), and handlers.js:369 feeds those lines to transcript.updateAgentCandidate. transcript-parser.js extracts turns per engine by output marker: claude-code agent /^(?:[│ ]\s*)?[⏺•●]\s(.*)$/ and user /^(?:[│ ]\s*)?[❯›]\s(.*)$/; codex agent /^(?:│\s*)?•\s(.*)$/ and user /^(?:│\s*)?›\s(.*)$/; gemini-cli agent lines startsWith('✦ ') and user startsWith(' > ') with a chrome filter; user-marker lines only count as user turns when the captured text matches a known typed prompt (userTexts set), continuation lines strip a leading '│ ' or two spaces, and collapseAgentTurns keeps only the LAST of consecutive agent turns (latest full render wins). transcript-normalizer.cleanAgentText then chops trailing UI chrome (input prompt box at last '›'/'❯' for codex/claude-code, '\n >' for gemini-cli, 'esc to interrupt', '? for shortcuts', '(running stop hook)', spinner blocks /\n\n\s*[✻✢✣✤✥✦✧]/, rules ─{5,}); transcript-candidate keeps exactly one cleaned candidate string per session (rejecting transient chrome like /^Working \(/), and commitAgentCandidate stores it as the 'agent' entry when the session goes idle (sess._finalizeOnIdle, set on session.status working:false unless source==='esc' or non-codex 'menu') or when a menu is detected, with dedupe against lastAgentText. Every store() rewrites/appends ~/.clideck/transcripts/<sessionId>.jsonl (one JSON object per line: {ts, role, text, prefix?}) and broadcasts {type:'transcript.append', id, role, text} over WS. The ask flow (session-ask.js, POST /api/session/ask, loopback-only) injects '[CliDeck ask from <name>]\n\n<message>' via bracketed paste (\x1b[200~…\x1b[201~) + delayed '\r', then waits: on working→false (or 2.5s output quiet) it broadcasts terminal.capture, waits 700ms for the browser round-trip + commit, and reads the reply as the newest role:'agent' transcript entry with ts >= sinceTs (fallback: session.lastPreview), timing out per timeoutMs (default 10min, max 60min).

## Interfaces

### [file-format] transcript JSONL
- direction: disk
- shape: ~/.clideck/transcripts/<sessionId>.jsonl — one JSON object per line: {"ts": number (Date.now() ms), "role": "user"|"agent", "text": string, "prefix"?: string}. DATA_DIR = join(os.homedir(), '.clideck') from paths.js (auto-migrated from ~/.termix). Legacy files ending '-parsed.jsonl' / '.screen' are deleted at init.
- notes: In finalize mode the whole file is REWRITTEN on every store (compacted: consecutive user entries concatenated with \n, consecutive agent entries replaced by the newest). In append mode (plain shells) lines are appendFile'd. Files whose id is not in validIds are deleted at init. Safe for an external frontend to tail/read, but expect full rewrites, not pure appends.

### [ws-msg] transcript.append
- direction: server->client
- shape: {type:'transcript.append', id: string(sessionId), role:'user'|'agent', text: string}
- notes: Emitted from transcript.js store() on EVERY committed entry — this is the single event a chat frontend should subscribe to for new bubbles. Also mirrored to plugins via notifyPlugin(id, role, text).

### [ws-msg] transcript.cache
- direction: server->client
- shape: {type:'transcript.cache', cache: {[sessionId]: string}} — per-session plain-text history (entry texts joined by \n, tail-capped at 50*1024 chars)
- notes: Sent once on WS connection (handlers.js onConnection).

### [ws-msg] terminal.capture
- direction: server->client
- shape: {type:'terminal.capture', id: string, menuVersion?: number}
- notes: Server asks the BROWSER to snapshot its xterm buffer. Sent by server.js hooks (500ms after status changes), telemetry-receiver, and session-ask waitForAnswer. CRITICAL: agent-reply extraction depends on a connected client answering this.

### [ws-msg] terminal.buffer
- direction: client->server
- shape: {type:'terminal.buffer', id: string, lines: string[], menuVersion?: number} — lines are xterm buffer rows via buffer.getLine(i).translateToString(true) (ANSI-free, trailing whitespace trimmed)
- notes: Handled in handlers.js:369: detectMenu → maybe stripMenu → transcript.updateAgentCandidate(id, presetId, lines); commits candidate when (!sess.working && sess._finalizeOnIdle) or when a menu is detected. A custom frontend replacing the browser MUST implement this reply or agent bubbles never finalize.

### [ws-msg] input
- direction: client->server
- shape: {type:'input', id: string, data: string} — raw keystrokes/paste for the PTY
- notes: sessions.input() → plugins.transformInput → writeSessionInput → transcript.trackInput(id, data) then pty.write(data). trackInput reconstructs user lines: skips OSC/CSI/ESC sequences char-by-char, handles \x7f/\x08 backspace, flushes on \r/\n → store(id,'user',line) + userTexts[id].push(line) + candidate.clear.

### [ws-msg] session.status
- direction: server->client
- shape: {type:'session.status', id: string, working: boolean, source: 'client'|'hook'|'menu'|'esc'|...}
- notes: sessions.broadcast side-effect (sessions.js:42-62): sets s.working and s._finalizeOnIdle = !msg.working && msg.source !== 'esc' && (msg.source !== 'menu' || s.presetId === 'codex'). The working→false edge is what triggers candidate commit on the next terminal.buffer.

### [ws-msg] session.menu
- direction: server->client
- shape: {type:'session.menu', id: string, choices: [{value: string(digit), label: string, selected: boolean}] } — empty array clears the menu
- notes: From detectMenu in transcript.js: scans bottom 40 buffer lines for a footer matching /\besc\b|\(esc\)/i, collects numbered choices via /^\s*(?:[│❯›●•]\s+)*(\d+)\.\s+(.+)$/ walking upward, requires one selected (marker per preset: claude-code /[❯›]/, codex /[›❯]/, gemini-cli /●/).

### [http-route] POST /api/session/ask
- direction: client->server
- shape: Request JSON: {callerSessionId: string, target: string ('@project/session' | sessionId | session name), message: string, timeoutMs?: number (default 600000, max 3600000)}. Response 200: {targetSessionId: string, targetName: string, response: string}. Errors: 403 non-loopback, 404 unknown caller/target, 409 target busy ('Target agent ... is busy right now'), 504 'Timed out waiting for target session response'.
- notes: server.js:258. Loopback-only (isLoopback check). Injection: sessionsApi.input with data = '\x1b[200~' + '\n\n[CliDeck ask from <callerName>]\n\n<message>' + '\x1b[201~', then '\r' after min(2500, max(500, 300+ceil(len/80)*100)) ms, second '\r' 1500ms later if still not working. Reply = latest transcript entry role:'agent' with ts >= sinceTs (transcript.getEntriesSince), fallback session.lastPreview if lastActivityAt >= sinceTs; finish() is retried until non-empty, gated 700ms after a terminal.capture broadcast.

### [function-api] transcript module exports
- direction: internal
- shape: init(broadcast, validIds:Set, notifyPlugin) / trackInput(id, data) / recordInjectedInput(id, text) / trackOutput(id, data) / updateAgentCandidate(id, presetId, lines[]) / commitAgentCandidate(id, presetId) / clearAgentCandidate(id) / parseTurnsFromLines(id, presetId, lines, opts?) / getTurns(id, n=4, order='end'|'start') → [{role, text}] / getEntriesSince(id, tsMs) → [{ts,role,text,prefix?}] / getCache() / getReplayText(id, presetId) / clear(id) / setPrefix(id, prefix) / setFinalizeOnIdle(id, presetId|null) / detectMenu(lines, presetId) / stripMenu(lines, presetId)
- notes: getTurns folds consecutive same-role entries into merged turns. recordInjectedInput exists for programmatic injections (splits text on /\r?\n/, stores each nonblank trimmed line as 'user') but has NO caller in core — ask injection is instead recorded via the normal input→trackInput path since bracketed-paste markers are OSC/CSI-stripped and \n flushes lines.

### [function-api] parser.parseTurns / parseLastAgentOnly (per-engine markers)
- direction: internal
- shape: parseTurns(presetId, lines[], users[]) → [{role:'user'|'agent', text}] | null (null if <2 turns). Engine regexes — claude-code: agent /^(?:[│ ]\s*)?[⏺•●]\s(.*)$/, user /^(?:[│ ]\s*)?[❯›]\s(.*)$/; codex: agent /^(?:│\s*)?•\s(.*)$/, user /^(?:│\s*)?›\s(.*)$/; gemini-cli: agent line.startsWith('✦ ')→slice(2), user line.startsWith(' > ')→slice(3) plus isChrome() noise filter (drops 'shift+tab to accept', 'Type your message', '@path/to/', '/cmd ', 'no sandbox', '/model ', git-prompt '(main*)', 'Logged in with', 'Plan:', 'Tips for getting started', numbered onboarding tips, 'ℹ ' lines). Unknown presets → anchorParse(lines, users): finds prompt lines whose trimmed text ends with a known user prompt with ≤6 extra leading chars, up to 3 anchors scanning backwards; text between anchors = agent turn; requires last turn agent.
- notes: User-marker lines are only accepted as user turns if the captured text (trimmed) is in the known-users Set (userTexts from trackInput, falling back to on-disk user entries) — this prevents the echoed input box from creating fake user turns. Continuation lines strip a leading '│ ' or exactly two spaces then join with \n. collapseAgentTurns drops each agent turn immediately followed by another agent turn (keeps only the final render).

### [function-api] normalizer.cleanAgentText (chrome stripping)
- direction: internal
- shape: cleanAgentText(presetId, text) → string. Steps in order: rstrip each line + trim; strip trailing /\n\n─{5,}\s*$/; codex|claude-code: out = out.slice(0, max(lastIndexOf('›'), lastIndexOf('❯'))) if found (removes re-rendered input prompt); gemini-cli: cut at lastIndexOf('\n >'), strip /\n\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]?\s*Executing Hook:[\s\S]*$/; claude-code only: strip /\n\s*.*\(running stop hook\)[\s\S]*$/, /\n\s*\?\s*for shortcuts[\s\S]*$/, /\n\s*esc to interrupt[\s\S]*$/, spinner block /\n\n\s*[✻✢✣✤✥✦✧][\s\S]*$/, /\n\n─{5,}[\s\S]*$/.
- notes: addEntry(entries, entry, presetId) merge semantics: user+user → prev.text += '\n' + next.text; agent+agent → prev.text = next.text (REPLACE, newest screen render wins); ts updated to newest. compactEntries re-runs addEntry over a whole list; also used by getReplayText.

### [function-api] candidate module (reply staging)
- direction: internal
- shape: candidate.update(id, presetId, lines, users) → cleaned text | '' ; candidate.get(id) → string; candidate.clear(id). update = parseTurns→last turn (else parseLastAgentOnly) → if role==='agent' cleanAgentText → reject if empty or isTransientChrome (codex: /^Working \(/ or /^esc to interrupt$/i; claude-code: /^(esc to interrupt|\? for shortcuts)$/i) → candidateText[id] = text.
- notes: Exactly one candidate string per session; commitAgentCandidate (transcript.js:173) no-ops unless finalizePreset[id] is set, skips empty and skips text === lastAgentText[id] (dedupe across repeated captures), then store(id,'agent',text). trackInput/recordInjectedInput clear both candidate and lastAgentText so the next turn starts fresh.

### [function-api] stripAnsi / ANSI_RE
- direction: internal
- shape: ANSI_RE = /\x1b[\[\]()#;?]*[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g ; stripAnsi(value) → String(value||'').replace(ANSI_RE,'')
- notes: Matches CSI-ish sequences, OSC (BEL- or ESC\\-terminated, non-greedy), any lone ESC+1 char, carriage returns, and BEL. Note \r removal means CR-overwrite animations collapse; only used on the raw-PTY fallback path and session-token regex matching — the agent path relies on xterm rendering instead.

### [function-api] getReplayText marks
- direction: internal
- shape: getReplayText(id, presetId) → string: compactEntries, require last entry role==='agent' and ≥1 agent entry (hasSettledReplay), then format each entry as '<mark> <text>' joined by '\n\n'. Marks: 'claude-code' {user:'❯', agent:'⏺'}, codex {user:'›', agent:'•'}, 'gemini-cli' {user:'>', agent:'✦'}, opencode {user:'›', agent:'•'}, pi {user:'›', agent:'•'}, default {user:'›', agent:'•'}
- notes: Used by sessions.js:481 to re-feed conversation history in the engine's own marker dialect when resuming/restarting — confirms the canonical per-engine output markers: ⏺ (claude-code), • (codex/opencode/pi), ✦ (gemini-cli).

### [env-var] CLIDECK_SESSION_ID / CLIDECK_PORT / CLIDECK_URL / OTEL_RESOURCE_ATTRIBUTES
- direction: internal
- shape: Injected into every spawned PTY env (sessions.js buildTelemetryEnv): CLIDECK_SESSION_ID=<id>, CLIDECK_PORT=<port>, CLIDECK_URL=<localUrl>; for telemetry presets also preset.telemetryEnv with '{{port}}' substitution and OTEL_RESOURCE_ATTRIBUTES += 'clideck.session_id=<id>'
- notes: Not part of the transcript files themselves but how child CLIs learn the ask endpoint; codex menu trust additionally gates on telemetry-receiver.getLastEvent(id).startsWith('codex.sse_event:response.completed').

## Integration notes
Reuse as-is: the transcript module (C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck\transcript.js) plus its three helpers are self-contained (only deps: fs, path, ./paths) and give you the full stream→bubbles engine. For a custom group-chat frontend the cleanest hooks are: (1) subscribe to WS 'transcript.append' for live bubbles and read ~/.clideck/transcripts/<id>.jsonl (or WS 'transcript.cache' / getTurns via plugin API getTranscript(id,n,order)) for history; (2) send user messages as {type:'input', id, data} — wrap multi-line text in bracketed paste '\x1b[200~...\x1b[201~' + delayed '\r' exactly like session-ask.submitAskInput does, since trackInput needs the \r to flush the user line and agents need Enter to submit; (3) for agent-to-agent asks call POST /api/session/ask from loopback. The single biggest trap: agent reply extraction is CLIENT-ASSISTED — the server broadcasts 'terminal.capture' and only a connected client that renders the PTY in xterm.js and answers with 'terminal.buffer' {id, lines} makes commitAgentCandidate fire; if your custom frontend replaces the stock web UI entirely, you must either keep one stock browser tab open per session, or implement the capture→buffer reply yourself (headless xterm.js: feed 'output' data into a Terminal, on 'terminal.capture' dump buffer.active lines via translateToString(true), echo menuVersion back). Do NOT try to parse the raw 'output' WS stream yourself — the 300ms trackOutput fallback path is explicitly disabled for agent presets and is noisy. Avoid writing to the JSONL files while the server runs (finalize mode rewrites whole files). Menus: watch 'session.menu' and answer with input '\r' or a digit; sessions.input treats '\r'/[1-9] on an open menu as a choice and clears the candidate. Reply timing: after working→false, allow ~700ms+ (capture round-trip) before reading getEntriesSince; session-ask.js waitForAnswer is the reference implementation to copy.

## Risks
1) Headless-frontend blind spot: without a browser answering 'terminal.capture' with 'terminal.buffer', agent bubbles for claude-code/codex/gemini-cli/opencode/pi never commit (finalize mode disables the raw trackOutput path), so a custom frontend that drops the stock UI silently loses all agent replies — this is the most likely integration failure. 2) The candidate is a whole-screen re-parse: agent+agent entries REPLACE rather than append, so replies longer than the xterm scrollback window (10000 lines client-side, but only what translateToString returns) or heavily redrawn TUIs can truncate the captured turn; cleanAgentText's cut-at-last-'›'/'❯' also truncates any agent text that legitimately contains those characters (e.g. quoted shell prompts). 3) User-turn detection requires exact match with typed lines (userTexts Set) — messages injected by other tools that bypass trackInput/recordInjectedInput will not register as user turns and can confuse anchorParse. 4) ask's answer heuristic (latest agent entry after sinceTs, else lastPreview) can return a mid-turn partial if the agent goes idle-then-working again, and busy targets are hard-rejected (409, no queueing) — a group-chat orchestrator must handle 409 retry/backoff itself. 5) recordInjectedInput is exported but uncalled in core — verify before relying on it; behavior may differ from the trackInput path (no bracketed-paste stripping needed). 6) tlog/clog debug logging is commented out; timings (300ms flush, 500ms capture delays, 700ms finish, 2500ms quiet) are magic numbers tuned for these CLIs and may need adjustment for new engines. Version caveat: all claims are from the installed package at C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck as of 2026-07-07; upgrades may change regexes and message shapes.
