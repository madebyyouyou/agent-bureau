# PTY session lifecycle (sessions.js), Claude token tracking (claude-session.js), agent guide injection (agent-session-guide.js), and agent discovery (session-agents.js) in C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck

## Summary
sessions.js is the single source of truth for live PTY sessions: an in-memory `Map` keyed by `crypto.randomUUID()`, each value `{ name, themeId, commandId, cwd, pty, chunks: [], chunksSize, sessionToken, projectId, presetId, working }`. `spawnSession()` spawns via node-pty (`name:'xterm-256color'`, default 80x24) with env `{...process.env, ...commandEnv(cmd), ...buildTelemetryEnv(id,cmd), ...COLORFGBG}`; buildTelemetryEnv always injects `CLIDECK_SESSION_ID`, `CLIDECK_PORT`, `CLIDECK_URL`, and for telemetry-enabled presets (claude-code by default) the OTEL vars from agent-presets.json plus `OTEL_RESOURCE_ATTRIBUTES=...,clideck.session_id=<id>`. Before spawn, `withCliDeckGuide()` (agent-session-guide.js) splices `--append-system-prompt <GUIDE>` into claude args (or `-c developer_instructions=<json>` for codex) so agents learn the `clideck agents`/`clideck ask` peer protocol; on Windows it accounts for the `cmd.exe /c` wrapper that `parseCommand()` adds for non-.exe commands. All terminal output is appended to a per-session rolling `chunks` buffer capped at MAX_BUFFER = 2*1024*1024 chars and broadcast as `{type:'output', id, data}` over the shared WebSocket client set; reconnecting clients get the full buffer replayed via `sendBuffers(ws)` as `{type:'output', id, data, replay:true}`, falling back to `{type:'session.history', id, text, replay:true}` from the transcript module for idle agents with empty buffers. The resume token is captured by matching the preset's `sessionIdPattern` regex (e.g. claude-code: `"Session ID:\s+([0-9a-f]{8}-...)"`) against the joined (and ANSI-stripped) buffer; claude-session.js's `updateClaudeSessionToken()` lets telemetry/hooks later overwrite it, validating against `CLAUDE_SESSION_ID_RE`. On PTY exit (or server shutdown auto-save), sessions with `canResume && resumeCommand && sessionToken` and not `ephemeral` are written to `~/.clideck/sessions.json` (DATA_DIR from paths.js) as `[{id, name, commandId, presetId, cwd, themeId, sessionToken, projectId, muted, lastPreview, lastActivityAt, savedAt}]`; `resume` respawns with `cmd.resumeCommand.replace('{{sessionId}}', sessionToken)` under the SAME clideck id. `name` and `projectId` are plain fields on the session record set at create time (msg.name || cmd.label; msg.projectId || null) with case-insensitive name uniqueness enforced per-project via `sessionNameExistsInScope()`; rename/setProject re-check it. The WS dispatch lives in handlers.js (`case 'create' / 'session.resume' / 'session.restart' / 'input' / 'resize' / 'rename' / 'close' / 'session.setPreview' / 'session.setProject' ...`), and session-agents.js serves `GET /api/session/agents` (loopback-only) for the `clideck agents` CLI roster.

## Interfaces

### [ws-msg] create
- direction: client->server
- shape: {type:'create', commandId?: string, cwd?: string, themeId?: string, name?: string, projectId?: string|null, installId?: string, cols?: number, rows?: number}
- notes: cmd resolved from cfg.commands by id, else cfg.commands[0], else {label:'Shell', command: defaultShell}. cwd via resolveValidDir(msg.cwd || cmd.defaultPath || cfg.defaultPath) -> falls back to os.homedir(). name defaults to cmd.label. Duplicate name in same projectId scope -> {type:'error', message:'Agent name "X" is already taken in this project.'} sent only to the requesting ws.

### [ws-msg] created
- direction: server->client
- shape: {type:'created', id: uuid, name, themeId, commandId, presetId, projectId, installId?} ; resume variant adds {muted: boolean, resumed: true, lastPreview: string}
- notes: Broadcast to ALL clients. May be followed by {type:'session.needsSetup', id} if preset has telemetrySetup/bridge and cmd.telemetryEnabled/telemetryStatus.ok not set.

### [ws-msg] input / output
- direction: client->server / server->client
- shape: in: {type:'input', id, data: string} ; out: {type:'output', id, data: string, replay?: true}
- notes: input passes through plugins.transformInput; ESC ('\x1b') while working broadcasts {type:'session.status', id, working:false, source:'esc'}; Enter/digit on an active menu broadcasts {type:'session.menu', id, choices: []} then {type:'session.status', id, working:true, source:'menu-input'}. output replay:true on reconnect carries the full joined 2MB rolling buffer.

### [ws-msg] session.history
- direction: server->client
- shape: {type:'session.history', id, text: string, replay: true}
- notes: Sent by sendBuffers(ws) instead of raw output when a session's chunks are empty, its presetId is one of ['claude-code','codex','gemini-cli','opencode','pi','clideck-agent'], it is not working, and transcript.getReplayText(id, presetId) returns text.

### [ws-msg] resize / rename / close
- direction: client->server
- shape: {type:'resize', id, cols, rows} ; {type:'rename', id, name} ; {type:'close', id}
- notes: rename success broadcasts {type:'renamed', id, name}; duplicate broadcasts {type:'session.renameRejected', id, name:<oldName>, message} to ALL clients. close kills pty, clears telemetry/transcript/bridges, broadcasts {type:'closed', id}, and also drops the id from the resumable list (re-broadcasting sessions.resumable).

### [ws-msg] session.resume
- direction: client->server
- shape: {type:'session.resume', id: <saved session id>}
- notes: Looks up id in `resumable`; errors ({type:'error', message}) if not found, cmd lacks canResume/resumeCommand, or resumeCommand contains {{sessionId}} but no sessionToken was captured. Respawns under the SAME id with parseCommand(cmd.resumeCommand.replace('{{sessionId}}', saved.sessionToken)); then broadcasts updated {type:'sessions.resumable', list} and {type:'created', ..., resumed:true}.

### [ws-msg] session.restart
- direction: client->server
- shape: {type:'session.restart', id, themeId?, cols?, rows?} -> broadcast {type:'session.restarted', id, resumed?: boolean, error?: string}
- notes: Kills the live PTY and respawns same id, preferring resumeCommand when cmd.canResume && cmd.resumeCommand && sessionToken; clears transcript/telemetry state but preserves name/cwd/projectId/muted/lastPreview/lastActivityAt.

### [ws-msg] sessions / sessions.resumable (connect bootstrap)
- direction: server->client
- shape: {type:'sessions', list:[{id, name, themeId, commandId, presetId, projectId, muted, working, lastPreview, lastActivityAt, menu?}]} ; {type:'sessions.resumable', list:[<sessions.json record>]}
- notes: handlers.js onConnection(ws) sends, in order: config, themes, presets, sessions, sessions.resumable, transcript.cache, plugins, pills, then sessions.sendBuffers(ws) replays terminal buffers. A custom frontend gets full state just by connecting.

### [ws-msg] session.status
- direction: server->client
- shape: {type:'session.status', id, working: boolean, source: 'hook'|'client'|'esc'|'menu'|'menu-input'|...}
- notes: CAUTION: broadcast() itself applies the state transition (sets s.working, s._finalizeOnIdle) — transport and state are coupled by design (see comment at sessions.js:43). Clients can inject status via {type:'session.statusReport', id, working} which rebroadcasts with source:'client'.

### [ws-msg] session.setPreview / session.setProject / session.mute / session.theme
- direction: client->server
- shape: {type:'session.setPreview', id, text, timestamp} ; {type:'session.setProject', id, projectId} ; {type:'session.mute', id, muted} ; {type:'session.setPreview'} stores text.slice(0,200) as lastPreview + lastActivityAt
- notes: setProject re-runs the per-project name-uniqueness check and echoes {type:'session.setProject', id, projectId} on success. lastPreview/lastActivityAt are client-pushed and persisted by auto-save — a custom frontend must push them itself or sidebar previews stay empty.

### [function-api] createProgrammatic(opts, cfg)
- direction: internal
- shape: opts: {presetId?: string, commandId?: string, cwd?: string, themeId?: string, name?: string, projectId?: string|null, ephemeral?: boolean} -> {id: uuid} | {error: string}
- notes: Server-side session creation for plugins/orchestrators (wired into plugins.init in server.js). ephemeral:true excludes the session from sessions.json persistence and from the resumable list on exit. Still broadcasts {type:'created', ...} to all WS clients.

### [env-var] PTY child env (buildTelemetryEnv + commandEnv + color)
- direction: internal
- shape: Always: CLIDECK_SESSION_ID=<clideck uuid>, CLIDECK_PORT=<port>, CLIDECK_URL=http://<host>:<port> (localUrl(), default http://localhost:4000). If preset.telemetryEnv && (cmd.telemetryEnabled ?? presetId==='claude-code'): CLAUDE_CODE_ENABLE_TELEMETRY=1 (claude only), OTEL_LOGS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>, OTEL_LOGS_EXPORT_INTERVAL=2000, OTEL_RESOURCE_ATTRIBUTES=<existing,>clideck.session_id=<id>. Plus COLORFGBG='0;15' (light theme) or '15;0' (dark). cmd.env entries are whitelisted by /^[A-Za-z_][A-Za-z0-9_]*$/ and stringified.
- notes: CLIDECK_SESSION_ID is how a CLI inside the PTY identifies itself back to the server (used by `clideck ask`/`clideck agents` and the GUIDE text). OTLP telemetry POSTs land on the same HTTP server at POST /v1/logs (or /).

### [file-format] ~/.clideck/sessions.json
- direction: disk
- shape: JSON array: [{id: uuid, name: string, commandId: string, presetId: string, cwd: string, themeId: string, sessionToken: string, projectId: string|null, muted: boolean, lastPreview: string, lastActivityAt: string|null, savedAt: ISO string}]
- notes: DATA_DIR = join(os.homedir(), '.clideck') (paths.js). Written by saveSessions() on a 30s auto-save interval (broadcasts {type:'sessions.saved'} when count>0) and on shutdown; loaded on startup into the in-memory `resumable` array. Only live sessions whose cmd has canResume && resumeCommand — and a captured sessionToken when resumeCommand contains {{sessionId}} — are persisted; ephemeral and shell sessions are dropped.

### [http-route] GET /api/session/agents
- direction: client->server
- shape: GET /api/session/agents?callerSessionId=<clideck session id>&all=1 -> 200 {agents:[{id, name, preset, projectId, project, address, working, lastPreview, lastActivityAt, caller: boolean}]} ; 403 if not loopback; 404 if caller session not active
- notes: session-agents.js, mounted in server.js at req.url.startsWith('/api/session/agents'). address is `@<projectName>/<name>` when the session has a projectId, else bare name. Without all=1 the roster is filtered to the caller's project (sameProject).

### [function-api] withCliDeckGuide(parts, presetId) + GUIDE
- direction: internal
- shape: (parts: string[], presetId: string) -> string[]. claude-code: splices ['--append-system-prompt', GUIDE] after argv[0] (skipped if '--system-prompt' or '--append-system-prompt' already present). codex: splices ['-c', 'developer_instructions=' + JSON.stringify(GUIDE)] (skipped if developer_instructions already configured). commandStart() offsets +2 past a Windows 'cmd.exe /c' wrapper.
- notes: GUIDE tells the agent: it runs in CliDeck only when CLIDECK_SESSION_ID is set; use `clideck agents` (--all for cross-project @project/session addresses), `clideck ask status`, `clideck ask "<target>" "<message>" --timeout 10m`; busy targets are NOT queued. This is the built-in agent-to-agent messaging a group-chat frontend can piggyback on.

### [function-api] updateClaudeSessionToken(sess, token, clideckId, options)
- direction: internal
- shape: (sess, token: string, clideckId: string, options?: {label?: string, source?: string}) -> boolean. CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
- notes: claude-session.js. Only mutates sess.sessionToken when sess.presetId === 'claude-code' and token matches the UUID regex; no-ops on same token. Keeps the resume token current when Claude Code rotates session ids (called from telemetry/hook paths). Initial capture happens separately in spawnSession via preset sessionIdPattern 'Session ID:\s+([0-9a-f]{8}-...)' against the output buffer.

### [cli] claude-code preset spawn/resume commands
- direction: internal
- shape: agent-presets.json claude-code: command 'claude', resumeCommand 'claude --resume {{sessionId}}', canResume true, sessionIdPattern as above, telemetryConfigPath '~/.claude/settings.json'. parseCommand() on win32 wraps non-.exe commands as [COMSPEC||'cmd.exe','/c',...parts].
- notes: presetForCommand matches the configured cfg.commands entry to a preset; session.presetId falls back to 'shell'. The 'shell' preset's command is replaced at load with defaultShell (COMSPEC on Windows).

## Integration notes
Reuse the backend as-is and treat the WS protocol as your API: connect a WebSocket to the CliDeck HTTP server (default http://127.0.0.1:4000, port from --port / CLIDECK_PORT / PORT), and on connect you automatically receive config, themes, presets, {type:'sessions'}, {type:'sessions.resumable'}, transcript.cache, plugins, pills, and buffered output replays ({type:'output', replay:true} or {type:'session.history', replay:true}) — no extra handshake. To spawn group members send {type:'create', commandId, cwd, name, projectId, cols, rows} and correlate the async {type:'created'} broadcast via your own installId field (it is echoed back); use one projectId per group chat since agent-name uniqueness is scoped per project and the built-in @project/name addressing in /api/session/agents keys off it. Drive agents by sending {type:'input', id, data: '<prompt>\r'} and gate turns on {type:'session.status', working} broadcasts (requires the preset telemetry/hooks setup to be accurate); resume across server restarts with {type:'session.resume', id} against the sessions.resumable list. For server-side orchestration (a CliDeck plugin) prefer createProgrammatic({presetId:'claude-code', name, cwd, projectId, ephemeral:true}) so scratch group sessions never pollute ~/.clideck/sessions.json. Inside each spawned agent, CLIDECK_SESSION_ID/CLIDECK_PORT/CLIDECK_URL are already in env and the injected GUIDE teaches `clideck agents` / `clideck ask` — you get agent-to-agent messaging for free, but note asks to busy targets are dropped, not queued, so a group-chat layer should do its own queuing on top. Avoid: writing sessions.json yourself (the 30s auto-save will clobber it); passing your own --append-system-prompt to claude commands (it suppresses the GUIDE injection — merge texts instead); relying on the 2MB rolling buffer for history (use the transcript module/session.history instead); and broadcasting synthetic {type:'session.status'} messages unless you intend the side effect, because broadcast() mutates server-side session state (s.working, s._finalizeOnIdle).

## Risks
(1) No auth anywhere: any local process (or LAN peer if started with --host 0.0.0.0) that reaches the WS gets full PTY control including input to running CLIs; /api/session/agents only checks isLoopback. (2) Resume fragility: the sessionToken comes from a regex over raw terminal output ('Session ID: ...'); if Claude never prints it (or prints it after the 2MB buffer trims), the session is silently skipped at save time ('Skipped N resumable session(s): no session token captured') and cannot be resumed — telemetry-based updateClaudeSessionToken is the backstop and requires the hooks/OTLP setup. (3) broadcast() couples transport with state mutation (acknowledged in a code comment at sessions.js:43-45); a custom client can flip working state via 'session.statusReport', and any future refactor may break this contract. (4) Replay truncation: chunks cap at 2MB and trimming shifts whole chunks, so long-lived sessions replay only a tail; chunksSize counts JS string length, not bytes. (5) Error-reporting is inconsistent: create/resume errors go only to the requesting ws as {type:'error'}, while renameRejected and restarted errors are broadcast to everyone — a multi-client frontend must handle both patterns. (6) Name collisions are case-insensitive per project and rejected, so a group-chat frontend generating agent names must dedupe first. (7) ephemeral is set on the session AFTER spawnSession returns in createProgrammatic; an instant PTY exit in that window would treat the session as persistable. (8) sessions.json stores sessionToken (and cwd, previews) in plaintext under ~/.clideck. (9) Windows quirk: parseCommand wraps commands in 'cmd.exe /c' and its quote-splitting is naive — complex custom commands with nested quotes may mis-tokenize.
