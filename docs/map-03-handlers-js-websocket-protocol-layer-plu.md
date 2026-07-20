# handlers.js — WebSocket protocol layer (plus resolved shapes from sessions.js, config.js, transcript.js, plugin-loader.js, runtime.js, server.js)

## Summary
handlers.js exports `onConnection(ws)` (wired to a `ws` WebSocketServer attached to the main HTTP server in server.js) and `getConfig()`. All client<->server traffic is JSON-stringified objects with a `type` discriminator over a single WebSocket on the same port as the HTTP UI (PORT = --port arg || CLIDECK_PORT || PORT env || 4000, host default 127.0.0.1). There is NO authentication — only a browser Origin check that explicitly allows origin-less (non-browser) clients, so a custom frontend can connect with a plain `new WebSocket('ws://127.0.0.1:4000')`. On connect the server immediately pushes 8 snapshot messages (config, themes, presets, sessions, sessions.resumable, transcript.cache, plugins, pills) followed by per-session `output` replay buffers or `session.history` transcript replays. The message handler is one big switch over ~33 client->server types covering session lifecycle (create/resume/restart/input/resize/rename/close), status+menu detection (session.statusReport, terminal.buffer), config and project CRUD (config.get/config.update/project.delete/project.openPath), directory browsing (dirs.list/dirs.mkdir), telemetry auto-setup per agent preset (telemetry.autosetup/telemetry.configure — these write hooks into ~/.claude/settings.json, ~/.codex/config.toml, ~/.gemini/settings.json, opencode/pi bridge files), plugins (plugin.settings.update/install/delete, pill.getLogs, and a `plugin.*` catch-all forwarded to plugin frontend handlers), and clideck-remote pairing/voice. Server->client pushes are broadcast to ALL connected clients (no per-client sessions), so multiple frontends stay in sync automatically. A crucial inverted flow: the server sends `terminal.capture {id}` asking the CLIENT to snapshot its xterm buffer and reply with `terminal.buffer {id, lines[]}` — the server then runs menu detection and transcript extraction on those lines, meaning a custom headless frontend MUST implement this round-trip (maintain a terminal emulator per session server-side of your frontend, e.g. xterm-headless) or menu detection, working/idle status via menus, and clean transcripts silently degrade.

## Interfaces

### [ws-msg] create
- direction: client->server
- shape: {type:'create', commandId: string, cwd?: string, themeId?: string, name?: string, projectId?: string|null, cols?: number, rows?: number, installId?: string}
- notes: Spawns PTY for the config command matching commandId (falls back to cfg.commands[0] then default shell). Duplicate session name within same project => reply {type:'error', message}. Success => broadcast 'created'; may also broadcast 'session.needsSetup' if agent telemetry not configured.

### [ws-msg] session.resume
- direction: client->server
- shape: {type:'session.resume', id: string}
- notes: id must be in the resumable list. Substitutes {{sessionId}} in cmd.resumeCommand with saved sessionToken. Errors reply {type:'error', message}. Success => broadcast 'sessions.resumable' (updated list) + 'created' with resumed:true, lastPreview.

### [ws-msg] session.restart
- direction: client->server
- shape: {type:'session.restart', id: string, themeId?: string, cols?: number, rows?: number}
- notes: Kills and respawns the PTY (resume command if token captured, else original command). Replies/broadcasts {type:'session.restarted', id, resumed?: bool, error?: string}.

### [ws-msg] input
- direction: client->server
- shape: {type:'input', id: string, data: string}
- notes: Raw keystrokes to the PTY (send '\r' for Enter). Special handling: when a menu is active and data is '\r' or digit 1-9, clears menu (broadcasts session.menu choices:[] + session.status working:true source:'menu-input'); ESC ('\x1b') while working broadcasts session.status working:false source:'esc'. Data passes through plugins.transformInput first.

### [ws-msg] session.statusReport
- direction: client->server
- shape: {type:'session.statusReport', id: string, working: boolean}
- notes: Client-observed spinner state; rebroadcast as {type:'session.status', id, working, source:'client'} if session exists.

### [ws-msg] terminal.buffer
- direction: client->server
- shape: {type:'terminal.buffer', id: string, lines: string[], menuVersion?: number}
- notes: Client's reply to server push 'terminal.capture'. lines = visible terminal rows (plain text). Server runs transcript.detectMenu(lines, presetId) => broadcasts session.menu {choices: string[]} and session.status {working:false, source:'menu'}; also feeds transcript candidate extraction. menuVersion echoes the value from terminal.capture (claude-code menu dedupe).

### [ws-msg] resize
- direction: client->server
- shape: {type:'resize', id: string, cols: number, rows: number}
- notes: pty.resize; no reply.

### [ws-msg] rename
- direction: client->server
- shape: {type:'rename', id: string, name: string}
- notes: Broadcasts {type:'renamed', id, name} or {type:'session.renameRejected', id, name: oldName, message} on duplicate name in project scope.

### [ws-msg] close
- direction: client->server
- shape: {type:'close', id: string}
- notes: Kills PTY, clears transcript, broadcasts {type:'closed', id}; also removes from resumable list (broadcasts 'sessions.resumable' if changed).

### [ws-msg] config.get
- direction: client->server
- shape: {type:'config.get'}
- notes: Replies to this ws only: {type:'config', config}.

### [ws-msg] checkAvailability
- direction: client->server
- shape: {type:'checkAvailability'}
- notes: Re-probes agent binaries on PATH (which/where) and telemetry config health; replies {type:'presets'} + {type:'config'} to this ws.

### [ws-msg] config.update
- direction: client->server
- shape: {type:'config.update', config: object}
- notes: SHALLOW merge: cfg = {...cfg, ...msg.config} — send whole top-level keys you change (e.g. full commands[] or projects[] arrays). pluginsDir/version keys are stripped. Persists to config.json and broadcasts {type:'config', config} to all. This is also how projects are CREATED/EDITED — there is no project.create op; send config.update with the full projects array (project = {id, name, path?...}).

### [ws-msg] session.theme
- direction: client->server
- shape: {type:'session.theme', id: string, themeId: string}
- notes: Broadcasts same shape back on success.

### [ws-msg] telemetry.autosetup
- direction: client->server
- shape: {type:'telemetry.autosetup', commandId?: string, presetId?: string}
- notes: Writes hook/bridge config for the agent (claude-code: ~/.claude/settings.json hooks; codex: ~/.codex/config.toml [otel]+notify+hooks; gemini-cli: ~/.gemini/settings.json hooks; opencode/pi: bridge file copy). Replies {type:'telemetry.autosetup.result', presetId, commandId: string|null, success: bool, output: string} + broadcasts 'config'.

### [ws-msg] telemetry.configure
- direction: client->server
- shape: {type:'telemetry.configure', commandId?: string, presetId?: string, enable: boolean}
- notes: enable:true applies config, false removes it. No dedicated result message — only broadcasts updated 'config' (telemetryEnabled/telemetryStatus on each command).

### [ws-msg] session.mute
- direction: client->server
- shape: {type:'session.mute', id: string, muted: boolean}
- notes: Broadcasts same shape on success.

### [ws-msg] session.setProject
- direction: client->server
- shape: {type:'session.setProject', id: string, projectId: string|null}
- notes: Broadcasts same shape, or replies {type:'error', message} on duplicate-name conflict in target project.

### [ws-msg] session.setPreview
- direction: client->server
- shape: {type:'session.setPreview', id: string, text: string, timestamp?: string}
- notes: Stores last preview line (truncated to 200 chars) + lastActivityAt for sidebar; persisted by 30s auto-save. No reply.

### [ws-msg] project.delete
- direction: client->server
- shape: {type:'project.delete', id: string}
- notes: Kills ALL sessions in the project, removes it from cfg.projects, broadcasts 'config' (plus 'closed' per killed session).

### [ws-msg] project.openPath
- direction: client->server
- shape: {type:'project.openPath', id: string}
- notes: Opens project.path in OS file manager (explorer/open/xdg-open). Replies {type:'project.openPath.result', id, success: bool, error?: string, headless?: true, path?: string}.

### [ws-msg] dirs.list
- direction: client->server
- shape: {type:'dirs.list', path?: string, showHidden?: boolean}
- notes: Replies {type:'dirs', path, entries: [...dir names/objects from utils.listDirs], error?: string}. Defaults to cfg.defaultPath.

### [ws-msg] dirs.mkdir
- direction: client->server
- shape: {type:'dirs.mkdir', parent: string, name: string}
- notes: Replies {type:'dirs.mkdir', success: bool, path?: string, error?: string}. name must not contain slashes or be '.'/'..'.

### [ws-msg] plugin.settings.update
- direction: client->server
- shape: {type:'plugin.settings.update', pluginId: string, key: string, value: any}
- notes: Value validated against plugin manifest setting type; broadcasts {type:'plugins', list}.

### [ws-msg] plugin.install
- direction: client->server
- shape: {type:'plugin.install', pluginId: string}
- notes: Replies {type:'plugin.install.progress', pluginId} immediately, then {type:'plugin.install.result', pluginId, success: bool, error?: string}; broadcasts 'plugins' on success.

### [ws-msg] plugin.delete
- direction: client->server
- shape: {type:'plugin.delete', pluginId: string}
- notes: Broadcasts 'plugins' on success, else replies {type:'plugin.delete.error', pluginId, error}.

### [ws-msg] pill.getLogs
- direction: client->server
- shape: {type:'pill.getLogs', id: string}
- notes: Replies {type:'pill.logs', id, logs: any[]}.

### [ws-msg] remote.status
- direction: client->server
- shape: {type:'remote.status', forceUpdate?: boolean}
- notes: Replies {type:'remote.status', installed: bool, ...clideck-remote status --json fields} and {type:'remote.update', checked: bool, installed?: string, latest?: string, available: bool}.

### [ws-msg] remote.pair
- direction: client->server
- shape: {type:'remote.pair'}
- notes: Runs `clideck-remote pair --json`; replies {type:'remote.paired', ...json} or {type:'remote.error', error}.

### [ws-msg] remote.unpair
- direction: client->server
- shape: {type:'remote.unpair'}
- notes: Broadcasts {type:'remote.unpaired'} or replies {type:'remote.error', error}.

### [ws-msg] remote.getHistory
- direction: client->server
- shape: {type:'remote.getHistory', id: string}
- notes: Replies {type:'remote.history', id, turns: [{role:'user'|'agent', text: string}]} — last 20 folded transcript turns. Very useful for a chat frontend.

### [ws-msg] remote.voice.transcribe
- direction: client->server
- shape: {type:'remote.voice.transcribe', requestId: string, audio: string(base64)}
- notes: Requires voice-input plugin. Replies {type:'remote.voice.result', requestId, text, ...} or {type:'remote.voice.error', requestId, error}.

### [ws-msg] remote.voice.send
- direction: client->server
- shape: {type:'remote.voice.send', requestId: string, id: string(sessionId), audio: string(base64)}
- notes: Transcribes then injects text + '\r' (150ms later) into session. Replies {type:'remote.voice.sent', requestId, id, text?: string, skipped?: true} or remote.voice.error.

### [ws-msg] remote.install
- direction: client->server
- shape: {type:'remote.install', update?: boolean, restart?: boolean}
- notes: npm install -g clideck-remote; streams {type:'remote.install.progress', text} then {type:'remote.install.done', success, update, restarted?: false, restart?: object, error?: string}.

### [ws-msg] plugin.* (catch-all)
- direction: client->server
- shape: {type:'plugin.<anything>', ...}
- notes: Any unmatched type starting with 'plugin.' is routed to plugins.handleMessage(msg) — dispatched to plugin-registered frontend handlers keyed by exact type string.

### [ws-msg] connect snapshot (8 messages)
- direction: server->client
- shape: On WS open, in order: {type:'config', config}, {type:'themes', themes: [{id, theme:{background,...}, ...}]}, {type:'presets', presets: [agent-presets.json entries + available/version/versionOk/health]}, {type:'sessions', list}, {type:'sessions.resumable', list}, {type:'transcript.cache', cache: {[sessionId]: string}}, {type:'plugins', list}, {type:'pills', list} — then per live session either {type:'output', id, data, replay:true} (joined PTY buffer, max 2MB) or {type:'session.history', id, text, replay:true} (formatted transcript for idle agents).

### [ws-msg] config
- direction: server->client
- shape: {type:'config', config: {defaultPath, commands: [{id, presetId?, label, icon, command, enabled, defaultPath, isAgent, canResume, resumeCommand, sessionIdPattern, outputMarker, env: {}, telemetryEnabled, telemetryStatus: {ok: bool, error?: string}|null, telemetrySetupConsent?, bridge?}], confirmClose, notifyIdle, notifySoundEnabled, notifySound, notifyMinWork, askDispatchSoundEnabled, askDispatchSound, defaultTheme, defaultShell, prompts: [{id,name,text}], projects: [{id, name, path?, ...}], pluginSettings?, pluginInstalled?, pluginsDir: string, version: string}}
- notes: Broadcast after every config-mutating op. commands are filtered for disabled presets.

### [ws-msg] sessions
- direction: server->client
- shape: {type:'sessions', list: [{id, name, themeId, commandId, presetId, projectId, muted: bool, working: bool, lastPreview: string, lastActivityAt: string|null, menu?: string[]}]}
- notes: Only sent on connect (not re-broadcast on change — track via created/closed/renamed/session.* deltas).

### [ws-msg] sessions.resumable
- direction: server->client
- shape: {type:'sessions.resumable', list: [{id, name, commandId, presetId, cwd, themeId, sessionToken, projectId, muted, lastPreview, lastActivityAt, savedAt}]}
- notes: Broadcast on connect, after resume, after close-of-resumable, and when a resumable session exits.

### [ws-msg] created
- direction: server->client
- shape: {type:'created', id, name, themeId, commandId, presetId, projectId, installId?, muted?: bool, resumed?: true, lastPreview?: string}
- notes: installId echoes the client's create msg so the originating client can claim the session.

### [ws-msg] closed
- direction: server->client
- shape: {type:'closed', id: string}

### [ws-msg] renamed / session.renameRejected
- direction: server->client
- shape: {type:'renamed', id, name} | {type:'session.renameRejected', id, name: currentName, message: string}

### [ws-msg] output
- direction: server->client
- shape: {type:'output', id: string, data: string, replay?: true}
- notes: Raw PTY output (ANSI included) broadcast to all clients on every chunk. replay:true only on connect buffer replay.

### [ws-msg] session.status
- direction: server->client
- shape: {type:'session.status', id: string, working: boolean, source: 'client'|'hook'|'menu'|'menu-input'|'esc'}
- notes: THE working/idle signal for a chat UI. source:'hook' comes from agent lifecycle hooks (HTTP /hook/* routes); 'menu' means an approval menu appeared (working:false); 'menu-input' means menu answered (working:true).

### [ws-msg] session.menu
- direction: server->client
- shape: {type:'session.menu', id: string, choices: string[]}
- notes: Non-empty choices = approval/choice menu detected in terminal; empty array = menu cleared. Answer by sending input {id, data:'\r'} or digit '1'-'9'.

### [ws-msg] terminal.capture
- direction: server->client
- shape: {type:'terminal.capture', id: string, menuVersion?: number}
- notes: SERVER->CLIENT REQUEST: client must reply with terminal.buffer {id, lines, menuVersion}. Triggered ~500ms after claude/gemini hook events and by session-ask. A frontend without a terminal emulator must still handle this (or menu detection breaks).

### [ws-msg] transcript.append
- direction: server->client
- shape: {type:'transcript.append', id: string, role: 'user'|'agent', text: string}
- notes: Clean parsed conversation entries as they are committed — the primary feed for a group-chat frontend.

### [ws-msg] transcript.cache
- direction: server->client
- shape: {type:'transcript.cache', cache: {[sessionId: string]: string}}
- notes: Last 50KB of concatenated transcript text per session; connect-time only.

### [ws-msg] session.history
- direction: server->client
- shape: {type:'session.history', id, text: string, replay: true}
- notes: Formatted transcript replay ('❯ user\n\n⏺ agent' style marks per preset) sent on connect for idle agent sessions with empty PTY buffer.

### [ws-msg] session.theme / session.mute / session.setProject / session.needsSetup / session.restarted / sessions.saved
- direction: server->client
- shape: {type:'session.theme', id, themeId} | {type:'session.mute', id, muted} | {type:'session.setProject', id, projectId} | {type:'session.needsSetup', id} | {type:'session.restarted', id, resumed?: bool, error?: string} | {type:'sessions.saved'}

### [ws-msg] error
- direction: server->client
- shape: {type:'error', message: string}
- notes: Generic error reply (create name conflict, resume failures, setProject conflict). Not correlated to a request id — sent only to the requesting ws.

### [ws-msg] plugins / pills / pill.logs / plugin.install.* / plugin.delete.error
- direction: server->client
- shape: {type:'plugins', list: [{id, name, version, author, description, icon, settings, settingValues, dynamicOptions, actions, capabilities: string[], hasClient: bool, bundled: bool, installed: bool}]} | {type:'pills', list: [{id, pluginId, title, projectId, working, statusText, icon, startedAt}]} | {type:'pill.logs', id, logs} | {type:'plugin.install.progress', pluginId} | {type:'plugin.install.result', pluginId, success, error?} | {type:'plugin.delete.error', pluginId, error}

### [ws-msg] remote.* replies
- direction: server->client
- shape: {type:'remote.status', installed: bool, ...} | {type:'remote.update', checked: bool, installed?: string, latest?: string, available: bool} | {type:'remote.paired', ...} | {type:'remote.unpaired'} | {type:'remote.error', error} | {type:'remote.history', id, turns:[{role,text}]} | {type:'remote.voice.result', requestId, text?} | {type:'remote.voice.error', requestId, error} | {type:'remote.voice.sent', requestId, id, text?, skipped?} | {type:'remote.install.progress', text} | {type:'remote.install.done', success, update, restarted?, restart?, error?}

### [http-route] POST /hook/claude/{start|stop|idle|session-start|session-end|menu}
- direction: client->server
- shape: body: {session_id: string, clideck_id?: string, source?: string} — written into ~/.claude/settings.json hooks by telemetry.autosetup (UserPromptSubmit->start, Stop->stop, SessionStart->session-start, SessionEnd->session-end, Notification[idle_prompt]->idle, PreToolUse->menu), invoked as: node bin/claude-hook.js <PORT> <route>
- notes: Drives session.status source:'hook' broadcasts and terminal.capture requests.

### [http-route] POST /hook/codex/{start|stop}, /hook/gemini/{start|stop|menu}, /opencode-events, /hook/pi, /v1/logs (and POST /)
- direction: client->server
- shape: codex: {clideck_id?, 'thread-id'?|session_id?}; gemini: {clideck_id?, session_id?}; /v1/logs: OTLP JSON logs body (max 1MB)
- notes: Agent-side lifecycle plumbing; a custom frontend never calls these but their side effects arrive as session.status/terminal.capture WS pushes.

### [http-route] POST /api/session/ask, GET /api/session/agents
- direction: client->server
- shape: ask: handled by session-ask.js (session-to-session messaging used by `clideck ask` CLI); agents: session discovery for `clideck agents`
- notes: Local HTTP alternative for injecting a prompt into a session from outside the WS — potentially useful for a group-chat orchestrator (see session-ask.js for exact body).

### [env-var] CLIDECK_PORT / PORT / --port / --host
- direction: internal
- shape: PORT = parseInt(--port) || CLIDECK_PORT || PORT || 4000; HOST = --host value or '0.0.0.0' if bare --host, default '127.0.0.1'
- notes: WS and all HTTP routes share this one port.

### [env-var] PTY-injected env (per session)
- direction: internal
- shape: CLIDECK_SESSION_ID=<uuid>, CLIDECK_PORT=<port>, CLIDECK_URL=http://localhost:<port>, OTEL_RESOURCE_ATTRIBUTES += clideck.session_id=<uuid>, COLORFGBG, plus preset telemetryEnv ({{port}} substituted) and per-command cfg env
- notes: How spawned agent CLIs learn to report back. Config roots overridable per command via env: CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME, PI_CODING_AGENT_DIR; presets can be gated by enabledIfEnv (value 1/true/yes).

### [file-format] transcripts (<DATA_DIR>/transcripts/<sessionId>.jsonl) and sessions.json
- direction: disk
- shape: transcript line: {ts: number, role: 'user'|'agent', text: string, prefix?: string}; sessions.json: array of resumable entries {id, name, commandId, presetId, cwd, themeId, sessionToken, projectId, muted, lastPreview, lastActivityAt, savedAt}
- notes: Readable directly for history import; auto-saved every 30s.

### [function-api] sessions.createProgrammatic(opts, cfg) / sessions.addBroadcastListener(fn)
- direction: internal
- shape: createProgrammatic({presetId?|commandId?, cwd?, themeId?, name?, projectId?, ephemeral?}) => {id} | {error}; addBroadcastListener(fn(msg)) => unsubscribe()
- notes: In-process hooks if the custom orchestrator runs as a CliDeck plugin instead of a WS client.

## Integration notes
Reuse the backend as-is and connect as a plain WS client: ws://127.0.0.1:<PORT>/ (default 4000, no path, no auth; origin-less clients pass verifyClient). For a group-chat frontend the minimal loop per agent is: (1) send {type:'create', commandId, projectId, name, cols, rows} and match the 'created' broadcast via your installId; (2) send user messages as {type:'input', id, data: text} followed by {type:'input', id, data:'\r'} (mirror the remote.voice.send pattern: text first, '\r' ~150ms later so TUIs register the submit); (3) render clean chat from 'transcript.append' events (role user/agent) seeded by 'transcript.cache' on connect or 'remote.getHistory' for folded turns — do NOT parse raw 'output' ANSI yourself; (4) track busy state from 'session.status' (working + source) and surface 'session.menu' choices as buttons that send input '\r' or '1'-'9'. CRITICAL: implement the terminal.capture -> terminal.buffer round-trip. The stock web UI feeds real xterm rows back; a headless frontend should run @xterm/headless (already a dependency pattern — feed every 'output' chunk into it per session) and reply with its visible lines plus the menuVersion echo, otherwise menu detection, claude/gemini idle detection, and transcript candidate commits degrade badly. Use projects as your 'group': create one via config.update (append to cfg.projects, remember shallow merge — always send the full array), assign sessions with session.setProject, and note session names must be unique per project. Group-chat fan-out can also go through POST /api/session/ask (the `clideck ask` bridge) which injects prompts session-to-session over HTTP without holding a WS. Avoid: mutating config keys you didn't read first (shallow merge clobbers), relying on the 'sessions' message for live state (connect-only snapshot; apply created/closed/renamed/session.* deltas), and the remote.*/plugin.* families unless you need voice or pills. All broadcasts go to every client, so the stock UI at http://127.0.0.1:4000 can run side-by-side with the custom frontend for debugging.

## Risks
1) No authentication on WS or HTTP hook routes — anything on localhost can inject input into agent sessions; do not bind --host 0.0.0.0. 2) The terminal.buffer contract is implicit and undocumented: if the custom frontend replies with badly-wrapped or ANSI-containing lines, menu detection (regex-based, scans bottom 40 lines for 'esc' footer) silently misfires; claude-code menus additionally depend on menuVersion echo for dedupe. 3) config.update is a shallow top-level merge with no validation or optimistic locking — two frontends writing concurrently lose data (last write wins, persisted immediately). 4) 'error' replies carry no request correlation id, so concurrent creates/resumes from one socket can't attribute failures; only remote.voice.* has requestId. 5) working/idle status is heuristic for non-hooked agents (depends on telemetry.autosetup having patched ~/.claude/settings.json, ~/.codex/config.toml etc.; health degrades to 'Needs re-patch'); a group-chat turn-taking orchestrator must tolerate missing or duplicated session.status transitions. 6) Session name uniqueness is enforced per project at create/rename/setProject — orchestrators generating agent names must handle the reject messages. 7) PTY replay buffer is capped at 2MB and transcript cache at 50KB/session, so long conversations need the jsonl files on disk for full history. 8) checkSelfUpdate at boot prompts on TTY stdin — if you supervise the server process, run it non-interactively so it skips the prompt.
