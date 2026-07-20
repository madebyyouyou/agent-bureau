# CliDeck ask mechanism (agent-to-agent messaging): CLI-in-PTY -> HTTP loopback -> PTY injection -> reply capture; plus agents discovery endpoint

## Summary
Every PTY session CliDeck spawns gets three env vars injected at spawn (sessions.js buildTelemetryEnv, line 82): CLIDECK_SESSION_ID (the session UUID), CLIDECK_PORT, and CLIDECK_URL (e.g. http://localhost:4000). The `clideck ask` CLI (bin/clideck.js -> clideck-ask-cli.js) running inside a PTY reads CLIDECK_SESSION_ID as its caller identity and POSTs plain JSON over HTTP to `/api/session/ask` on CLIDECK_URL (fallback http://127.0.0.1:${CLIDECK_PORT||PORT||4000}); there is no pipe or WS from the CLI — pure loopback HTTP, and the server rejects non-loopback remoteAddress with 403. The server handler (session-ask.js askSession) resolves the target by id/name within the caller's project or via "@project/session" cross-project address, hard-rejects with 409 if `target.working` is truthy (no queueing), then injects the message into the target PTY as a bracketed paste: `\x1b[200~` + `\n\n` + `[CliDeck ask from ${callerName}]\n\n${message}` + `\x1b[201~`, followed by `\r` after a length-scaled delay (min(2500, max(500, 300+ceil(len/80)*100)) ms) and a second retry `\r` 1500ms later if the target still isn't working. It then waits (default 10 min, capped 60 min) by listening to internal broadcast events: a `session.status` working:true->false transition (or 2.5s output quiet while idle) triggers a `terminal.capture` broadcast, and 700ms later it reads the answer as the newest transcript entry with role 'agent' since dispatch, falling back to `session.lastPreview`. Critically, `terminal.capture` is answered by the browser frontend, which dumps its xterm buffer back as a `terminal.buffer` WS message; handlers.js feeds those lines into transcript.updateAgentCandidate/commitAgentCandidate — so reply capture depends on a connected client that echoes captures. The HTTP response is `{targetSessionId, targetName, response}` and the CLI prints `response` to stdout (progress hints to stderr, polling `/api/session/agents` every 15s). `clideck agents` GETs `/api/session/agents?callerSessionId=...[&all=1]` and prints rows `{id, name, preset, projectId, project, address, working, lastPreview, lastActivityAt, caller}` either as JSON (--json) or as text lines `Name (peer, claude-code, idle) id=... ask=@proj/Name`.

## Interfaces

### [env-var] CLIDECK_SESSION_ID / CLIDECK_PORT / CLIDECK_URL
- direction: internal
- shape: Injected into every spawned PTY env (sessions.js:82): { CLIDECK_SESSION_ID: <session uuid string>, CLIDECK_PORT: String(PORT), CLIDECK_URL: localUrl() e.g. 'http://localhost:4000' }. CLIs error with 'CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.' when absent. CLIDECK_URL/CLIDECK_PORT/PORT resolve the server base URL; --url flag overrides.
- notes: For claude-code preset, OTEL_RESOURCE_ATTRIBUTES also gets ',clideck.session_id=<id>' appended and preset telemetryEnv vars with {{port}} substituted.

### [http-route] POST /api/session/ask
- direction: client->server
- shape: Request JSON: { callerSessionId: string (required, must be an ACTIVE session id), target: string (session id | session name | '@project/session'), message: string (required, trimmed), timeoutMs?: number (default 600000, clamped to max 3600000) }. Success 200: { targetSessionId: string, targetName: string, response: string }. Errors: { error: string } with 403 non-loopback ('CliDeck ask only accepts local requests'), 404 caller/target not found ('Caller session is not active'), 409 busy ('Target agent "X" is busy right now. CliDeck ask only sends to idle agents and does not queue requests...'), 400 ambiguity/validation, 504 'Timed out waiting for target session response'. Max body 2MB.
- notes: Long-polling: the HTTP request stays open until the target answers or times out. Server: server.js:258 -> session-ask.js handleHttp/askSession.

### [http-route] GET /api/session/agents
- direction: client->server
- shape: Query: ?callerSessionId=<id>[&all=1]. Success 200: { agents: [{ id: string, name: string, preset: string (presetId or 'shell'), projectId: string|null, project: string ('No project' when null), address: string (projectId ? `@${project}/${name}` : name), working: boolean, lastPreview: string, lastActivityAt: string|null (ISO), caller: boolean }] }. Errors: 403 non-loopback, 404 'Caller session is not active'.
- notes: Without all=1, filtered to sessions where (projectId||null) equals the caller's. Server: server.js:264 -> session-agents.js agentRow/listProjectAgents. The caller session itself IS included (caller:true).

### [cli] clideck ask
- direction: internal
- shape: clideck ask [--session|-s <name-or-id>] [--message|-m <text>] [--timeout|-t <30s|10m|1h, bare number = ms, default 10m>] [--url <base>] [--no-progress]; positional form: clideck ask <target> <message...>; stdin used as message when -m omitted and stdin is not a TTY. Response text -> stdout (trimEnd + '\n'); progress hints -> stderr (first at 5s, then every 15s, polling /api/session/agents); non-zero exitCode on error with message to stderr.
- notes: HTTP client timeout is timeoutMs + 5000ms. bin/clideck.js dispatches args[0]==='ask' to clideck-ask-cli.js.

### [cli] clideck ask status / clideck agents
- direction: internal
- shape: clideck ask status [--json] [--all] [--url]: JSON mode prints the agents array with an added status: 'busy'|'idle' field; text mode lines: `${'busy'|'idle'.padEnd(4)}  ${name}[ self][ ${address}][ project="${project}"]`. clideck agents [--json] [--all] [--url]: JSON mode prints raw agents array (JSON.stringify(res.agents, null, 2)); text mode lines: `${name} (${caller?'self':'peer'}, ${preset}, ${working?'working':'idle'}) id=${id}[ ask=${address}][ project="${project}"][ - ${lastPreview}]`. Empty: 'No active sessions found in this project.' or 'No active sessions found.' with --all.
- notes: address is only printed when address !== name (i.e. session has a project). project=" only with --all.

### [function-api] PTY injection format (submitAskInput, session-ask.js:127)
- direction: internal
- shape: sessionsApi.input({ id: targetId, data: '\x1b[200~' + '\n\n' + '[CliDeck ask from ' + (caller.name || callerId.slice(0,8)) + ']\n\n' + message + '\x1b[201~' }); then input({id, data:'\r'}) after askSubmitDelay(message) = Math.min(2500, Math.max(500, 300 + Math.ceil(len/80)*100)) ms; second '\r' at delay+1500ms only if !target.working. Timers cancelled via .finally when the wait settles.
- notes: BRACKETED_PASTE_START='\x1b[200~', BRACKETED_PASTE_END='\x1b[201~'. The leading '\n\n' inside the paste clears any pending prompt text. A custom orchestrator can replicate this exact sequence through the WS 'input' message.

### [ws-msg] input
- direction: client->server
- shape: { type: 'input', id: string, data: string } — raw bytes written to the PTY (handlers.js:363 -> sessions.input). Special-cased server-side: menu Enter/digit when a menu is active, and '\x1b' while working broadcasts session.status working:false source:'esc'.
- notes: This is the same path the ask injection uses internally; a custom frontend can inject bracketed-paste messages itself via this message.

### [ws-msg] session.status
- direction: server->client
- shape: { type: 'session.status', id: string, working: boolean, source: 'hook'|'client'|'menu'|'menu-input'|'esc'|... } — broadcast to all WS clients AND applied to internal state: sessions.js broadcast() sets s.working = !!msg.working and s._finalizeOnIdle. This is the busy/idle signal the ask gate (409) and waitForAnswer both key off.
- notes: Sources include CLI hook posts (claude-hook.js etc. include clideck_id from CLIDECK_SESSION_ID) and client reports. Clients may send { type: 'session.statusReport', id, working } which is rebroadcast as session.status with source:'client'.

### [ws-msg] terminal.capture
- direction: server->client
- shape: { type: 'terminal.capture', id: string, menuVersion?: number } — server asks any connected client to dump the target session's terminal buffer. Sent by waitForAnswer on idle transition / output quiet (session-ask.js:181,188), after hooks (server.js:98,185-199), by pi-bridge and telemetry-receiver.
- notes: CRITICAL: if no client answers this, ask reply capture degrades to whatever lastPreview/transcript already holds. A custom frontend MUST implement the capture echo.

### [ws-msg] terminal.buffer
- direction: client->server
- shape: { type: 'terminal.buffer', id: string, lines: string[] (full xterm buffer, one string per row, translateToString(true)), menuVersion?: number } — handlers.js:369 runs transcript.detectMenu(lines, presetId), transcript.updateAgentCandidate(id, presetId, lines), and transcript.commitAgentCandidate when !sess.working && sess._finalizeOnIdle — this commit creates the role:'agent' transcript entry that the ask response reads.
- notes: Reference client implementation: public/js/app.js case 'terminal.capture' (lines 137-146).

### [ws-msg] session.setPreview
- direction: client->server
- shape: { type: 'session.setPreview', id: string, text: string, timestamp: string (ISO) } — handlers.js:529 -> sessions.setPreview stores s.lastPreview = text.slice(0,200) and s.lastActivityAt. This is the ask answer FALLBACK (previewTextSince) when no agent transcript entry exists since dispatch.
- notes: Browser sends it from updatePreview (last agent-looking terminal line) and on session.preview bridge events. Truncated to 200 chars server-side.

### [ws-msg] session.dispatch
- direction: server->client
- shape: { type: 'session.dispatch', fromId: string, fromName: string, toId: string, toName: string } — broadcast once per ask immediately after injection (session-ask.js:217). Frontend uses it to play a sound; a group-chat UI can use it to render 'X asked Y'.
- notes: Fired before the answer exists; pair with the eventual transcript.append on toId for the reply.

### [ws-msg] transcript.append
- direction: server->client
- shape: { type: 'transcript.append', id: string, role: 'user'|'agent', text: string } — broadcast from transcript.store (transcript.js:84) whenever a turn is committed for a session.
- notes: Best real-time feed for a group-chat frontend: it fires for both injected asks (role user) and finalized agent replies.

### [ws-msg] output
- direction: server->client
- shape: { type: 'output', id: string, data: string (raw ANSI PTY bytes), replay?: true } — every PTY output chunk is broadcast to all WS clients (sessions.js:146). waitForAnswer also listens to these internally for its 2.5s quiet timer.
- notes: Feed these into a headless xterm.js instance per session to be able to answer terminal.capture.

### [file-format] transcript entry (NDJSON per session)
- direction: disk
- shape: One JSON object per line in <data>/transcripts? file per session id (transcript.fpath): { ts: number (Date.now()), role: 'user'|'agent', text: string, prefix?: string }. session-ask reads via getEntriesSince(id, ts) filtering ts >= sinceTs, then takes the LAST entry with role==='agent' and non-empty text as the ask response.
- notes: Only 'finalize' presets (claude-code, codex, gemini-cli, opencode, pi, clideck-agent) get structured entries; shell sessions append raw.

### [function-api] sessionsApi (sessions.js exports) used by session-ask/session-agents
- direction: internal
- shape: getSessions(): Map<id, session{name, working, lastPreview, lastActivityAt, projectId, presetId, pty, ...}>; input({id, data}): void; broadcast(msg): void (WS fanout + internal listeners + state application for session.status); addBroadcastListener(fn): () => void (unsubscribe).
- notes: Timeouts/gating summary: DEFAULT_TIMEOUT_MS=600000, MAX_TIMEOUT_MS=3600000, busy=409 no queue, idle-settle delays 700ms post-capture and 2500ms output-quiet.

## Integration notes
A custom group-chat frontend/orchestrator should connect as a normal WS client to the CliDeck server (same WS the browser uses; origin check allows non-browser clients with no Origin header) and treat the backend as-is — no server changes needed for the core loop. Reuse as-is: (1) POST /api/session/ask for agent-to-agent sends — but note callerSessionId MUST be a live session id (404 'Caller session is not active' otherwise), so a pure external orchestrator cannot call ask on its own behalf; either let agents call `clideck ask` themselves from inside their PTYs (zero work — env vars are already injected) or have the orchestrator inject messages directly via WS {type:'input'} using the exact bracketed-paste + delayed-\r recipe from submitAskInput. (2) GET /api/session/agents as the roster/presence API — it returns names, @project/session addresses, working flags, and lastPreview, exactly what a group-chat member list needs; poll it or track session.status broadcasts instead. (3) transcript.append broadcasts as the chat message stream and session.dispatch as the 'X -> Y' event. MUST implement: the terminal.capture -> terminal.buffer echo. Reply capture and menu detection both depend on a connected client dumping the terminal buffer; if you replace the stock browser UI entirely, run a headless xterm.js (the package vendors @xterm/xterm) per session fed by 'output' broadcasts, and on {type:'terminal.capture', id} reply {type:'terminal.buffer', id, lines, menuVersion} (copy public/js/app.js:137-146). Also send {type:'session.setPreview', id, text, timestamp} periodically so the lastPreview fallback works. Avoid: relying on lastPreview for full replies (server truncates to 200 chars at sessions.setPreview); calling ask against busy targets (hard 409, never queued — check `working` first via /api/session/agents); binding the server to non-loopback and expecting ask/agents to work remotely (both routes 403 non-loopback addresses regardless of --host).

## Risks
1) Reply capture is heuristic and client-dependent: the answer is 'the last role:agent transcript entry since dispatch', committed only when a WS client echoes terminal.buffer while the session is idle with _finalizeOnIdle set — with no client connected (or one that ignores terminal.capture), asks can time out (504) even though the target answered, or fall back to a 200-char truncated lastPreview. 2) The 700ms post-capture and 2500ms output-quiet windows can capture partial output from slow-rendering CLIs, and if the target emits multiple agent turns only the latest is returned. 3) Concurrent asks to the same target are not serialized beyond the initial busy check — two asks racing past the working:false check will interleave pastes into one PTY. 4) `working` starts as undefined and is driven by hooks/telemetry/client reports; a preset without hooks (plain shell) may never report working:true, so waitForAnswer only settles via the output-quiet path. 5) Name-based targeting throws on duplicates and names are mutable (rename WS msg), so a frontend should address sessions by id. 6) Security is loopback-only trust: any local process can POST /api/session/ask and inject text into any session's PTY — fine for a local tool, but a custom frontend must not proxy these routes to the network. 7) The injected '[CliDeck ask from X]' prefix is not configurable in session-ask.js; a group-chat UI wanting custom sender labels must inject via WS input itself rather than the ask route.
