# Server boot, HTTP routing/static serving, WebSocket setup, port/host config, single-instance lock (clideck v1.31.24 @ C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck)

## Summary
CliDeck boots via bin/clideck.js: subcommands `agents`/`ask` go to sibling CLIs; otherwise it requires server.js. server.js first runs checkSelfUpdate() (only when stdin+stdout are TTYs AND __dirname contains node_modules/clideck; runs `npm view clideck version`, may interactively `npm install -g clideck` and respawn), then acquireServerLock() from single-instance.js — if ~/.clideck/server.lock names a live pid other than its own, it prints "CliDeck is already running at <url>" and exits 0, so exactly one instance per user regardless of port. It then wires the module graph: ensurePtyHelper(); sessions.loadSessions(); transcript.init/telemetry.init/opencode-bridge.init/pi-bridge.init (each given sessions.broadcast + sessions.getSessions); plugins.init (given broadcast, getSessions, getConfig, saveConfig, sessions.input, sessions.createProgrammatic, sessions.close). A single http.createServer handles, in order: OTLP telemetry (POST /v1/logs or POST /), lifecycle hooks (POST /hook/codex/*, /hook/claude/*, /hook/gemini/*, /hook/pi), POST /opencode-events, the loopback-only agent bridge (POST /api/session/ask, GET /api/session/agents), a catch-all that answers ANY other POST with 200 "{}", plugin static files under /plugins/, three node_modules aliases (/xterm.css, /xterm.js, /addon-fit.js), and finally static files from PUBLIC_ROOT = join(__dirname,'public') — hardcoded, no env/config override, "/" maps to index.html, path-traversal blocked by a startsWith check, MIME map covers .html/.css/.js/.png/.svg/.mp3. The WebSocket endpoint is `new WebSocketServer({ server, verifyClient })` with no `path` option, so a WS upgrade on ANY path of the same port succeeds; verifyClient only checks Origin — requests with no Origin header (non-browser clients) always pass, an Origin whose host equals the request Host header passes, otherwise Origin must be one of http://localhost:PORT, http://127.0.0.1:PORT, http://[::1]:PORT, http://HOST:PORT; every accepted socket goes to handlers.js onConnection. PORT comes from `--port` arg, then env CLIDECK_PORT, then env PORT, then 4000; HOST is 127.0.0.1 unless `--host <value>` is given (bare `--host` means 0.0.0.0, which triggers a printed no-authentication warning). Shutdown on SIGINT/SIGTERM runs plugins.shutdown(), sessions.shutdown(getConfig()), removes the lock if owned, and exits.

## Interfaces

### [cli] clideck [--host <host>] [--port <port>]
- direction: internal
- shape: bin/clideck.js: args[0]==='agents' -> clideck-agents-cli.run; args[0]==='ask' -> clideck-ask-cli.run; --help/-h, --version/-v; else require('../server.js')
- notes: --host with no value binds 0.0.0.0; omitting --host binds 127.0.0.1

### [env-var] CLIDECK_PORT / PORT
- direction: internal
- shape: integer 1..65535; precedence: --port arg > CLIDECK_PORT > PORT > 4000 (runtime.js)

### [file-format] ~/.clideck/server.lock
- direction: disk
- shape: JSON { pid: number, host: string, port: number, url: string, startedAt: ISO-8601 string }
- notes: single-instance.js. Liveness = process.kill(pid,0) (EPERM counts alive). Not port-scoped: one lock per user; second instance exits 0 even on a different port. Read this file to discover a running instance's url/port. Deleted on exit only if lock.pid === process.pid.

### [ws-msg] WebSocket endpoint (any path, same HTTP port)
- direction: client->server
- shape: new WebSocketServer({ server, verifyClient }) — no path filter; verifyClient = isAllowedWsOrigin(req.headers.origin, req.headers.host): no Origin -> allow; origin.host === Host header -> allow; else origin must be in {http://localhost:PORT, http://127.0.0.1:PORT, http://[::1]:PORT, http://HOST:PORT}
- notes: Accepted sockets -> handlers.js onConnection (message protocol is a separate slice). No token/auth beyond origin check.

### [http-route] POST /v1/logs (also POST /)
- direction: client->server
- shape: body: OTLP JSON, limit 1e6 bytes; parsed into req.body (null on parse failure) then telemetry-receiver.handleLogs(req,res)
- notes: POST / is accepted because Gemini posts telemetry to root — do NOT design a custom API on POST /

### [http-route] POST /hook/claude/<route> where route ∈ {start,stop,idle,session-end,session-start,menu}
- direction: client->server
- shape: body JSON { session_id?: string, clideck_id?: string, source?: string }; matches session by clideck_id or by sessionToken===session_id; responds 200 '{}' always
- notes: Effects via sessions.broadcast: {type:'session.status', id, working:true|false, source:'hook'}; delayed {type:'terminal.capture', id} (menu adds menuVersion:number); session-start with source==='compact' is ignored as idle signal

### [http-route] POST /hook/codex/<route> where route ∈ {start,stop}
- direction: client->server
- shape: body JSON { clideck_id?: string, 'thread-id'?: string, session_id?: string }; start -> telemetry.markCodexStart(id,'hook'), stop -> telemetry.armCodexStop(id); 200 '{}'

### [http-route] POST /hook/gemini/<route> where route ∈ {start,stop,menu}
- direction: client->server
- shape: body JSON { clideck_id?: string, session_id?: string }; menu -> poll broadcast {type:'terminal.capture', id} every 500ms for 3s; else broadcast {type:'session.status', id, working: route==='start', source:'hook'}; 200 '{}'

### [http-route] POST /opencode-events and POST /hook/pi
- direction: client->server
- shape: body JSON forwarded to opencode-bridge.handleEvent / pi-bridge.handleEvent; 200 '{}'

### [http-route] POST /api/session/ask
- direction: client->server
- shape: loopback-only (403 otherwise). Request JSON { callerSessionId: string, target: string (session id | name | '@project/session'), message: string, timeoutMs?: number (default 600000, max 3600000) }. 200 response { targetSessionId: string, targetName: string, response: string }. Errors { error: string } with 400 (bad input), 404 (caller/target not found), 409 (target busy — no queueing), 504 (timeout).
- notes: Injects '[CliDeck ask from <caller>]\n\n<message>' into the target PTY via bracketed paste (\x1b[200~ … \x1b[201~) + '\r'; waits for session.status working:false plus transcript agent text or lastPreview newer than dispatch time. Also broadcasts {type:'session.dispatch', fromId, fromName, toId, toName}. This is the built-in agent-to-agent message primitive — a group-chat orchestrator can call it directly over HTTP.

### [http-route] GET /api/session/agents?callerSessionId=<id>[&all=1|true]
- direction: client->server
- shape: loopback-only. 200 { agents: [{ id, name, preset, projectId, project, address, working: boolean, lastPreview: string, lastActivityAt: string|null, caller: boolean }] }; 404 { error } if callerSessionId is not an active session
- notes: address is '@<project>/<name>' when the session has a projectId; without all=1 only same-project sessions are listed

### [http-route] POST <anything else>
- direction: client->server
- shape: unconditional 200 '{}' catch-all
- notes: any unrecognized POST silently succeeds — mistyped custom routes will not error

### [http-route] GET /plugins/<id>/client.js and GET /plugins/<id>/public/*
- direction: server->client
- shape: plugin-loader.resolveFile(req.url) -> file bytes with MIME by extension (default application/javascript); 404 if unresolved
- notes: the only sanctioned static-extension point besides public/

### [http-route] GET static (everything else)
- direction: server->client
- shape: ALIASES: /xterm.css, /xterm.js, /addon-fit.js -> require.resolve of @xterm packages; else resolve(join(__dirname,'public'), url) with '/' -> index.html; 403 on path escape, 404 missing, 500 read error; MIME map {.html,.css,.js,.png,.svg,.mp3} else application/octet-stream
- notes: PUBLIC_ROOT is hardcoded — no env var or config to point at an alternative frontend directory

### [ws-msg] session.status (broadcast emitted by hook routes)
- direction: server->client
- shape: { type: 'session.status', id: string, working: boolean, source: 'hook' }

### [ws-msg] terminal.capture (broadcast emitted by hook routes / ask flow)
- direction: server->client
- shape: { type: 'terminal.capture', id: string, menuVersion?: number }

### [ws-msg] session.dispatch (broadcast emitted by /api/session/ask)
- direction: server->client
- shape: { type: 'session.dispatch', fromId: string, fromName: string, toId: string, toName: string }

### [function-api] single-instance.js exports
- direction: internal
- shape: acquireServerLock() -> { ok: boolean, lock }; removeLockIfOwned(); isPidAlive(pid); LOCK_PATH

### [function-api] runtime.js exports
- direction: internal
- shape: PORT: number, HOST: string, localUrl(host=HOST, port=PORT) -> 'http://<host|localhost>:<port>' ('0.0.0.0' rendered as 'localhost')

### [function-api] paths.js exports
- direction: disk
- shape: DATA_DIR = os.homedir() + '/.clideck' (created on require; migrates from ~/.termix and legacy package-root files)

## Integration notes
Reuse the backend as-is and do NOT fork server.js. (1) Discovery: read ~/.clideck/server.lock for { url, port, pid } to find the running instance; if absent, spawn `clideck` non-interactively (no TTY skips the self-update prompt) or with CLIDECK_PORT set. Never try to run a second instance on another port — the lock is per-user, not per-port, and the second process exits immediately. (2) Realtime channel: open a WebSocket to ws://127.0.0.1:PORT/ (any path works — ws has no path filter). A Node/backend orchestrator sends no Origin header and always passes verifyClient; a BROWSER frontend served from a different port/origin will be REJECTED (origin.host must equal the Host header or be localhost/127.0.0.1/[::1] on the same port). So a custom group-chat UI must either (a) be served through CliDeck itself — the clean hook is the plugin system: /plugins/<id>/client.js and /plugins/<id>/public/* are served by plugin-loader.resolveFile, and plugins.init receives broadcast/getSessions/getConfig/saveConfig/sessions.input/createProgrammatic/close, i.e. full programmatic session control; or (b) sit behind your own reverse proxy that rewrites/strips the Origin header; or (c) talk only to your own backend which relays to CliDeck's WS. Dropping files into the package's public/ works (index.html is only the '/' default; /yourapp.html is served) but is wiped on every npm update — avoid. (3) Group-chat send primitive without touching the WS protocol: POST /api/session/ask (loopback-only) injects a message into an idle session's PTY and returns the agent's reply as JSON; GET /api/session/agents lists sessions with working/idle state. 409 means busy — you must retry, there is no queue. (4) Avoid POST / and any custom POST route names: POST / is the OTLP telemetry endpoint and every other unknown POST returns 200 '{}', so collisions fail silently. (5) The WS message protocol itself lives in handlers.js/sessions.js (onConnection, broadcast) — map that slice separately; server.js only wires it.

## Risks
Highest risk: the WS origin allowlist blocks any browser-based custom frontend not served from the same host:port — plan for the plugin route or a proxy from day one. The catch-all `POST -> 200 '{}'` masks integration bugs (a typo'd endpoint "succeeds"). Single-instance lock means your orchestrator and the human's normal CliDeck dashboard share one server — restarting it kills all live PTY sessions for both. checkSelfUpdate can interactively prompt and respawn the process when started from a TTY in node_modules — always spawn detached/non-TTY for automation. No authentication anywhere: with `--host 0.0.0.0` anyone on the LAN gets full PTY control (the server itself prints this warning); keep 127.0.0.1. /api/session/ask response extraction is heuristic (transcript text or lastPreview after working:false, 700ms/2500ms quiet timers) — replies can be truncated or missed for slow multi-part agent turns; set generous timeoutMs (default 10min, cap 60min). Files added to public/ or edits to server.js are destroyed by `npm install -g clideck` upgrades. Verified against clideck v1.31.24; route strings and shapes may shift in future versions since the catch-all and hook routes are internal contracts, not a documented API.
