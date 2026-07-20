# Working/idle detection: OTLP telemetry receiver + per-engine lifecycle hooks (telemetry-receiver.js, activity.js, bin/claude-hook.js, bin/codex-hook.js, bin/gemini-hook.js, bin/notify-helper.js, codex-hooks.js, codex-config.js, plus resolving siblings server.js, sessions.js, handlers.js, claude-session.js, agent-presets.json, runtime.js, transcript.js)

## Summary
CliDeck runs one HTTP+WS server (default 127.0.0.1:4000, runtime.js) that doubles as an OTLP HTTP/JSON log receiver: `POST /v1/logs` (and `POST /` for Gemini, which ignores the path) feeds telemetry-receiver.js `handleLogs`, which flattens `resourceLogs[].resource.attributes` (keys `clideck.session_id`, `service.name` with values `claude-code`, `codex_cli_rs`, `gemini-cli`, `clideck-agent`) and each `logRecords[].attributes` (keys `event.name`, `event.kind`, `session.id`, `conversation.id`, `decision`, `call_id`, `interactive`). Working/idle is engine-specific: Claude and Gemini status comes ONLY from deterministic HTTP hooks (`/hook/claude/<route>`, `/hook/gemini/<route>`) that broadcast `{type:'session.status', id, working, source:'hook'}`; OTLP for those two is used only to capture the agent-native session id for resume (via `updateClaudeSessionToken` / `sess.sessionToken`). Codex is a hybrid state machine: `codex.user_prompt` or the `/hook/codex/start` hook (Codex hooks.json event `UserPromptSubmit`) sets working=true; idle is committed only when a `codex.sse_event` with `event.kind='response.completed'` arrives within 5000ms of an armed stop (from the `/hook/codex/stop` hook — Codex `Stop` event or legacy `notify` helper) or of a `codex.websocket_event:response.output_item.done` fallback, AND no tool call is pending (`response.function_call_arguments.done` opens a tool phase; `codex.tool_decision` with non-`denied` `decision` tracks `call_id` until `codex.tool_result` resolves it), then a 300ms settle timer that any fresh Codex event cancels. Permission/approval UI is NOT a first-class event on any engine: Claude's `PreToolUse` hook hits route `menu`, Gemini's `BeforeTool` hits `menu`, and Codex's `response.completed` starts a 3s/500ms poll — all of which broadcast `{type:'terminal.capture', id}` asking the frontend to send back the visible buffer as `{type:'terminal.buffer', id, lines, menuVersion}`, which handlers.js runs through `transcript.detectMenu` producing `choices:[{value,label,selected}]` broadcast as `{type:'session.menu', id, choices}` plus working=false source='menu'; answering is just PTY input ('\r' or digit 1-9) which flips back to working via source='menu-input'. Claude's only Notification hook is `matcher:'idle_prompt'` → route `idle` (idle signal), so permission-request notifications are not captured. There is zero token/context-window parsing anywhere (activity.js is now just dead-simple byte counters); a context meter would have to be added inside `handleLogs`, where full Claude Code OTLP log-record attributes already arrive and are discarded after `event.name` is read.

## Interfaces

### [http-route] POST /v1/logs (also POST /)
- direction: client->server
- shape: OTLP/JSON body: { resourceLogs: [{ resource: { attributes: [{key, value:{stringValue|intValue|doubleValue|boolValue}}] }, scopeLogs: [{ logRecords: [{ attributes: [...] }] }] }] }. Resource attr keys consumed: 'clideck.session_id' (maps to CliDeck session), 'service.name' ('claude-code'|'codex_cli_rs'|'gemini-cli'|'clideck-agent'). LogRecord attr keys consumed: 'event.name', 'event.kind', 'session.id', 'conversation.id', 'interactive', 'decision', 'call_id' (or 'call.id')
- notes: telemetry-receiver.js handleLogs, mounted in server.js:106. Event names acted on: 'codex.user_prompt' (working=true), 'codex.sse_event' kind 'response.completed' (idle candidate + menu poll), 'codex.websocket_event' kinds 'response.function_call_arguments.done' / 'response.output_item.done', 'codex.tool_decision' (working=true; attrs.decision==='denied' clears tool phase), 'codex.tool_result', 'clideck.turn_start' (working=true), 'clideck.agent_idle' (working=false). Claude/Gemini records only harvest session ids. /v1/traces and /v1/metrics are NOT handled (any other POST gets empty 200, server.js:270).

### [http-route] POST /hook/claude/<route>
- direction: client->server
- shape: JSON { clideck_id: string (env CLIDECK_SESSION_ID), session_id: string, hook_event_name: string, source: string, reason: string, payload: string (raw hook stdin JSON) }. Routes: 'start' (UserPromptSubmit → working=true), 'stop' (Stop), 'idle' (Notification matcher 'idle_prompt'), 'session-end' (SessionEnd) — all three → working=false + terminal.capture after 500ms; 'session-start' (SessionStart → working=false unless payload.source==='compact'); 'menu' (PreToolUse → increments sess._menuVersion, broadcasts terminal.capture{menuVersion} after 500ms)
- notes: server.js:159-206. Session matched by clideck_id first, else by sessionToken===session_id. Hook installer in handlers.js:759-792 writes ~/.claude/settings.json hooks: UserPromptSubmit/Stop/SessionStart/SessionEnd/PreToolUse plus Notification [{matcher:'idle_prompt'}], each {type:'command', command:'"<node>" "<clideck>/bin/claude-hook.js" <port> <route>'}.

### [http-route] POST /hook/codex/<route>
- direction: client->server
- shape: JSON: Codex hook payload passthrough + { clideck_id: string, source: 'hook' }. Thread id read as payload['thread-id'] || payload.session_id. Routes ('[^a-z]' stripped): 'start' → telemetry.markCodexStart(id,'hook') (working=true, clears all pending state); 'stop' → telemetry.armCodexStop(id) (arms 5s pending-stop; idle NOT broadcast yet)
- notes: server.js:124-156. Installed by codex-hooks.js into ~/.codex/hooks.json: { hooks: { UserPromptSubmit: [{hooks:[{type:'command', command:'"<node>" "<clideck>/bin/codex-hook.js" <port> start', timeout:5}]}], Stop: [...route 'stop'] } }. Legacy notify path: bin/notify-helper.js also POSTs Codex's notify JSON (with clideck_id merged) to /hook/codex/stop.

### [http-route] POST /hook/gemini/<route>
- direction: client->server
- shape: JSON { clideck_id: string, session_id: string (hook.session_id || env GEMINI_SESSION_ID), payload: string }. Routes: 'start' (BeforeAgent → working=true), 'stop' (AfterAgent AND SessionEnd → working=false), 'menu' (BeforeTool → startGeminiMenuPoll: broadcast terminal.capture every 500ms for 3s)
- notes: server.js:209-233. Installer (handlers.js:819-848) writes ~/.gemini/settings.json hooks BeforeAgent/AfterAgent/SessionEnd/BeforeTool with matcher:'*', {type:'command', command:'"<node>" "<clideck>/bin/gemini-hook.js" <port> <route>', name:'clideck-<route>', timeout:5000}.

### [ws-msg] session.status
- direction: server->client
- shape: { type: 'session.status', id: string, working: boolean, source: 'hook'|'telemetry'|'telemetry-stop'|'telemetry-fallback'|'menu'|'menu-input'|'esc'|'client' }
- notes: THE working/idle signal. sessions.js broadcast() also mirrors it into sess.working and fires plugins.notifyStatus(id, working, source). 'menu' = approval menu visible (idle-ish, waiting on user); 'menu-input' = user answered menu; 'esc' = user pressed ESC while working.

### [ws-msg] session.menu
- direction: server->client
- shape: { type: 'session.menu', id: string, choices: [{ value: string (menu number), label: string, selected: boolean }] } — empty choices array clears the menu
- notes: This is the permission-approval-card payload. Produced by transcript.detectMenu scraping the bottom 40 terminal lines for numbered choices + an 'esc' footer + a per-preset selection marker. To answer: send WS {type:'input', id, data:'\r'} or a digit '1'-'9' — sessions.input() special-cases that, clears the menu, and re-broadcasts working=true.

### [ws-msg] terminal.capture
- direction: server->client
- shape: { type: 'terminal.capture', id: string, menuVersion?: number }
- notes: Server ASKS the frontend for the visible terminal buffer. A custom frontend MUST reply with terminal.buffer or menu/permission detection and transcript finalization silently break (used after Claude stop/idle/session-start/menu, Codex response.completed poll, Gemini BeforeTool poll).

### [ws-msg] terminal.buffer
- direction: client->server
- shape: { type: 'terminal.buffer', id: string, lines: string[], menuVersion?: number }
- notes: handlers.js:369-418 runs detectMenu over lines; for Codex the menu is only trusted if telemetry.getLastEvent(id) startsWith 'codex.sse_event:response.completed'; for Claude the menuVersion echo prevents re-detecting an already-answered menu.

### [ws-msg] session.needsSetup
- direction: server->client
- shape: { type: 'session.needsSetup', id: string }
- notes: telemetry.watchSession(id, bin) fires it 10s after spawn if no OTLP record arrived for the session. Remedy via WS {type:'telemetry.autosetup', presetId|commandId} → reply {type:'telemetry.autosetup.result', presetId, commandId, success, message} (handlers.js:451-486).

### [ws-msg] session.statusReport
- direction: client->server
- shape: { type: 'session.statusReport', id: string, working: boolean } → server re-broadcasts session.status with source:'client'
- notes: Escape hatch letting a frontend assert status; handlers.js:364.

### [env-var] Spawn-time env (sessions.js buildTelemetryEnv)
- direction: internal
- shape: Always: CLIDECK_SESSION_ID=<clideck session uuid>, CLIDECK_PORT=<port>, CLIDECK_URL=<http://host:port>. When telemetry enabled, preset telemetryEnv with {{port}} substituted — Claude: CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_LOGS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>, OTEL_LOGS_EXPORT_INTERVAL=2000 (Codex/clideck-agent: same minus CLAUDE_CODE_ENABLE_TELEMETRY). Plus OTEL_RESOURCE_ATTRIBUTES gets ',clideck.session_id=<id>' appended
- notes: agent-presets.json + sessions.js:78-91. Gemini has NO telemetryEnv (it ignores OTEL_RESOURCE_ATTRIBUTES) — its OTLP records are matched by service.name against pending sessions as a fallback. Server port precedence: --port arg, CLIDECK_PORT, PORT, default 4000 (runtime.js).

### [file-format] ~/.codex/config.toml + ~/.codex/hooks.json
- direction: disk
- shape: config.toml top-level: notify = ["<node>", "<clideck>/bin/notify-helper.js", "<port>"]; [features] hooks = true; [otel] exporter = { otlp-http = { endpoint = "http://localhost:<port>", protocol = "json" } }. hooks.json: hooks.UserPromptSubmit / hooks.Stop groups with command '"<node>" "<clideck>/bin/codex-hook.js" <port> <start|stop>', timeout 5
- notes: codex-config.js upsertCodexConfig/validateCodexConfigToml; codex-hooks.js installCodexHooks/removeCodexHooks/codexHooksHealthy (identifies its own hooks by command containing 'codex-hook.js').

### [function-api] telemetry-receiver exports
- direction: internal
- shape: init(broadcast, getSessions); handleLogs(req, res); clear(id); getLastEvent(id) → 'event.name[:event.kind]' string; cancelCodexMenuPoll(id); watchSession(id, bin); armCodexStop(id); markCodexStart(id, source='hook'); scheduleCodexIdle is internal (300ms settle before committing working=false)
- notes: An orchestrator embedding the backend can call these directly; init wiring happens in server.js:72.

### [cli] bin/claude-hook.js | bin/codex-hook.js | bin/gemini-hook.js | bin/notify-helper.js
- direction: internal
- shape: claude-hook.js <port> <route>: stdin = Claude hook JSON, forwards {clideck_id, session_id, hook_event_name, source, reason, payload}. codex-hook.js <port> <route>: stdin = Codex hook JSON, forwards payload + {clideck_id, source:'hook'}, silent, 1MB stdin cap. gemini-hook.js <port> <route>: stdin = Gemini hook JSON. notify-helper.js <port> ... <json>: Codex appends notify JSON as LAST argv; merges clideck_id, POSTs to /hook/codex/stop
- notes: All read CLIDECK_SESSION_ID from their environment (inherited from the PTY CliDeck spawned), POST to localhost:<port> with a 2s timeout, and swallow every error — hooks never block the CLI.

## Integration notes
Reuse the entire backend as-is: the OTLP receiver, hook routes, hook binaries, and per-engine installers (handlers.js 'telemetry.autosetup') are frontend-agnostic — all state reaches you through the WS broadcast. A custom group-chat frontend connects to the same WS (origin must match host or be a localhost:<port> variant, or be absent for non-browser clients) and consumes `session.status` (working flag drives typing/idle indicators per participant) and `session.menu` (drives a permission-approval card: render choices[{value,label,selected}], answer by sending {type:'input', id, data:'<digit>'} or '\r'). CRITICAL obligation: you must implement the `terminal.capture` → `terminal.buffer` round trip (send back the visible PTY buffer as a lines array, echoing menuVersion) — menu/permission detection and idle-on-menu for all three engines depend on the frontend doing this; a headless orchestrator must keep a server-side xterm headless instance (or reuse CliDeck's public/js client) per session to answer it. For lifecycle: Claude gives the richest deterministic signals (UserPromptSubmit/Stop/Notification:idle_prompt/SessionStart/SessionEnd/PreToolUse); do NOT try to infer Codex idle yourself — call telemetry-receiver's armCodexStop/markCodexStart or just trust session.status, because the in-file comment explicitly warns the Codex state machine must not grow more timing patches. For a context-window meter: nothing exists today — no token, usage, or cost attribute is read anywhere; the extension point is telemetry-receiver.js handleLogs, where every Claude Code OTLP log record's attributes are already flattened by parseAttrs and then ignored (only 'event.name' is kept) — add a branch on Claude's token-bearing event names there and broadcast a new WS message (Claude Code exports such events when CLAUDE_CODE_ENABLE_TELEMETRY=1/OTEL_LOGS_EXPORTER=otlp, which CliDeck already sets; note OTLP metrics posted to /v1/metrics are currently discarded with an empty 200, so use log events, or handle that path). For a richer permission card on Claude, you could additionally install a Notification hook without the 'idle_prompt' matcher (CliDeck deliberately registers only idle_prompt), giving you permission-request notifications with tool details instead of scraped menu text. Session identity: each PTY gets CLIDECK_SESSION_ID; agent-native ids land in sess.sessionToken (Codex 'conversation.id'/'thread-id', Claude 'session.id' validated as UUID by claude-session.js, Gemini 'session.id' preferring interactive===true records) — use sessionToken for resume commands from agent-presets.json.

## Risks
1) Codex idle detection is an acknowledged-fragile state machine (pending-stop 5s window + output_item.done fallback + 300ms settle + tool-phase/call_id tracking); the source comment forbids more timing patches without fixture tests — treat its output as best-effort and expect occasional late/missed idle transitions. 2) Menu/permission detection is terminal scraping (regex over the bottom 40 lines, per-preset markers, 'esc' footer heuristic) — CLI UI updates in Claude/Codex/Gemini can silently break approval cards, and a frontend that doesn't answer terminal.capture breaks them entirely. 3) Gemini's OTLP fallback matching (by service.name against any pending session with no activity) can mis-attach events when two Gemini sessions start within the 10s window, since Gemini omits clideck.session_id. 4) All hook/OTLP HTTP routes and the WS have no authentication — anything on localhost can forge session.status or session ids (server itself warns when bound beyond 127.0.0.1). 5) Claude idle relies on Notification matcher 'idle_prompt' plus Stop/SessionEnd; 'compact' SessionStart is deliberately ignored, and permission prompts only surface if the menu scrape succeeds after the PreToolUse-triggered capture. 6) No context-window/token data exists yet — a meter is new code, and Claude Code's exact telemetry event names/attribute keys for token usage must be verified against a live session (only 'codex.*' and 'clideck.*' event names are asserted in this codebase). 7) Hook route matching falls back to sessionToken lookup — before the first token capture, a hook missing clideck_id (e.g. CLI launched outside CliDeck) is silently dropped.
