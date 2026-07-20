# Frontend app bootstrap, state/send layer, navigation, and settings (public/js/app.js, state.js, nav.js, settings.js — plus creator.js and terminals.js excerpts needed to resolve payload shapes)

## Summary
CliDeck's frontend is a zero-HTTP-API, WebSocket-only client: app.js's connect() opens `new WebSocket(`${wsProtocol}//${location.host}`)` (same origin as the page; ws: or wss: chosen from location.protocol) and ALL data — config, themes, presets, sessions, resumable sessions, pills, plugins, transcript cache — arrives as server-pushed JSON messages after connection; there is no fetch()/XHR anywhere in public/js. Projects are not a separate resource: they live as an array on the config object (`state.cfg.projects`), so project create/rename/recolor/collapse are all done by mutating `state.cfg` client-side and sending the ENTIRE config back via `{type:'config.update', config: state.cfg}` (only project delete and open-in-file-manager have dedicated messages: `project.delete`, `project.openPath`). Session creation is `{type:'create', commandId, name, cwd, projectId, cols, rows}` where commandId references an entry in `cfg.commands[]` — that command entry (presetId, command string, env map, resumeCommand, etc.) IS the "role" of a session; there is no separate role-assignment message, only `session.setProject` to move a session between projects and `rename` to rename it (server may answer `session.renameRejected` if the name is taken in the project). Settings save (settings.js saveConfig) likewise rebuilds `cfg.commands` from the DOM and sends the whole config in one `config.update`; the server responds by broadcasting a fresh `config` message that re-renders everything. state.js's send() silently DROPS messages while the socket is closed unless the type is in a 17-entry QUEUEABLE_TYPES whitelist (create, close, config.update, session.* etc. — notably `input`, `rename`, and `resize` are NOT queued); queued config.updates are deduped to the latest. Notifications are entirely client-side: the server sends `{type:'session.status', id, working}` and terminals.js setStatus() fires a sound (`/fx/{cfg.notifySound}.mp3`) plus a browser Notification on the working→idle transition, gated by cfg.notifyIdle, cfg.notifyMinWork (seconds), mute state, and document.hasFocus(); `{type:'session.dispatch', toId}` plays cfg.askDispatchSound. nav.js is pure DOM panel switching (chats/prompts/plugins/settings) with no server traffic. On ws open the client sends `{type:'remote.status', forceUpdate:true}` and flushes the queue; on close it reconnects every 1000ms, and replayed `output`/`session.history` messages carry `replay:true` which the client skips for terminals that survived the reconnect.

## Interfaces

### [ws-msg] WebSocket endpoint (only transport)
- direction: client->server
- shape: new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}`) — same host/port serving the static UI; every payload both ways is JSON.stringify'd {type: string, ...fields}
- notes: app.js:48-57. No HTTP routes are called by the frontend at all (verified: zero fetch/XHR in public/js). Static assets fetched by URL: /fx/{sound}.mp3, /img/clideck-logo-icon.png, /plugins/{pluginId}/client.js (dynamic import).

### [ws-msg] bootstrap push (server sends on connect, no request needed)
- direction: server->client
- shape: {type:'config', config:{commands:[], projects:[{id,name,path?,color,collapsed}], defaultPath, defaultTheme, defaultShell, colorMode, confirmClose, notifyIdle, notifyMinWork, notifySoundEnabled, notifySound, askDispatchSoundEnabled, askDispatchSound, pluginsDir, version, prompts, ...}} | {type:'themes', themes:[{id,name,theme:{background,foreground,green,blue,cyan,yellow,brightBlack,...}}]} | {type:'presets', presets:[{presetId,name,icon,command,isAgent,canResume,resumeCommand,sessionIdPattern,outputMarker,bridge,available,health:{ok,reason},versionOk,minVersion,version,telemetrySetup,telemetryAutoSetup:{label},telemetryEnabled,telemetryConfigPath,installCmd,pluginSetup}]} | {type:'sessions', list:[{id,name,themeId,commandId,projectId,muted,lastPreview,presetId,working}]} | {type:'sessions.resumable', list:[{id,projectId,...}]} | {type:'pills', list:[{id,...}]} | {type:'plugins', list:[...]} | {type:'transcript.cache', cache:{[sessionId]:string}}
- notes: app.js onmessage switch (lines 59-399). The client sends nothing to request these; a custom frontend just connects and consumes. Projects arrive ONLY inside the config message.

### [ws-msg] create (new session)
- direction: client->server
- shape: {type:'create', commandId: string (id of an entry in cfg.commands), name: string, cwd: string, projectId: string|undefined, cols: number, rows: number}
- notes: creator.js:125-135; cols/rows come from estimateSize() with floors of 80/24. Install-shell variant adds installId instead of cwd/projectId (creator.js:447). Server replies with 'created'. 'create' is in the offline queue whitelist.

### [ws-msg] created (session created ack/broadcast)
- direction: server->client
- shape: {type:'created', id, name, themeId, commandId, projectId, muted, lastPreview, presetId, working}
- notes: app.js:107-113 — client adds the terminal and auto-selects it.

### [ws-msg] rename / renamed / session.renameRejected
- direction: client->server
- shape: client sends {type:'rename', id: string, name: string}; server answers {type:'renamed', id, name} on success or {type:'session.renameRejected', id, name (reverted name), message} when the name is already taken in the project
- notes: terminals.js:1099 (send), app.js:244-254 (handlers). Client pre-validates uniqueness per project but the server verdict is authoritative. NOT offline-queueable — dropped if socket is closed.

### [ws-msg] session.setProject (move session between projects — the closest thing to role/group assignment)
- direction: client->server
- shape: {type:'session.setProject', id: string, projectId: string|null}; server echoes the same {type:'session.setProject', id, projectId} to all clients
- notes: terminals.js:1278 (send), app.js:229-233 (echo handler regroups sidebar). Agent 'role' itself is fixed at create time via commandId; to change what an agent runs you edit cfg.commands and send config.update.

### [ws-msg] config.update (settings save + ALL project create/rename/recolor/collapse + prompts + drag-reorder)
- direction: client->server
- shape: {type:'config.update', config: <the ENTIRE state.cfg object>} — full replace. Project create pushes {id: randomUUID(), name, path: string|undefined, color: '#rrggbb' (from 8-color palette), collapsed:false} into cfg.projects first (app.js:824-841). Settings save (settings.js:611-653) rebuilds cfg.commands[i] = {id, presetId, label, icon, command, enabled, defaultPath, isAgent, canResume, resumeCommand, sessionIdPattern, outputMarker, env: {KEY:'value'} (parsed from KEY=VALUE lines), telemetryEnabled, telemetrySetupConsent, telemetryStatus, bridge, userAdded} and sets cfg.defaultTheme, defaultPath, confirmClose, notifyIdle, notifyMinWork (int), notifySoundEnabled, notifySound, askDispatchSoundEnabled, askDispatchSound
- notes: Server responds by broadcasting a fresh {type:'config'} which re-renders the UI. Text inputs debounce saveConfig by 500ms. Queued offline with last-write-wins dedupe (state.js:44-49).

### [ws-msg] project.delete / project.openPath
- direction: client->server
- shape: {type:'project.delete', id: projectId} (closes the project's active sessions server-side) | {type:'project.openPath', id: projectId} → server replies {type:'project.openPath.result', success: bool, headless?: bool, path?: string, error?: string}
- notes: app.js:712, 430, 294-318. These are the only project operations NOT done via config.update.

### [ws-msg] terminal I/O and lifecycle
- direction: client->server
- shape: {type:'input', id, data: string (raw PTY bytes incl. \r)} | {type:'resize', id, cols, rows} | {type:'close', id} | {type:'session.resume', id} | {type:'session.restart', id, themeId, cols, rows} | {type:'session.mute', id, muted: bool} | {type:'session.theme', id, themeId} | {type:'session.setPreview', id, text, timestamp: ISO-8601 string} | {type:'terminal.buffer', id, lines: string[], menuVersion} (reply to server's terminal.capture) | {type:'checkAvailability'} (sent before opening the creator)
- notes: terminals.js / app.js. Server pushes back: {type:'output', id, data, replay?} | {type:'closed', id} | {type:'session.restarted', id, ...} | {type:'session.history', id, text, replay?} | {type:'terminal.capture', id, menuVersion} | {type:'session.preview', id, text} | {type:'transcript.append', id, text} | {type:'error', message}. 'input' is NOT offline-queueable — a custom group-chat frontend must gate message sends on socket readyState.

### [ws-msg] session.status / session.dispatch (notification triggers)
- direction: server->client
- shape: {type:'session.status', id, working: bool} — the working/idle signal from server-side telemetry/bridge; {type:'session.dispatch', toId: string} — an agent asked/dispatched to another agent
- notes: Notification firing is 100% client-side (terminals.js setStatus, lines 908-935): on working→idle, if !muted and workDuration>=cfg.notifyMinWork it plays /fx/{cfg.notifySound||'default-beep'}.mp3 (when tab unfocused OR session not active) and, if cfg.notifyIdle && !document.hasFocus() && Notification.permission==='granted', shows new Notification(`${project.name}: ${sessionName}`, {body:'Is now idle.\n'+lastPreviewText, icon:'/img/clideck-logo-icon.png', tag:id}). session.dispatch plays /fx/{cfg.askDispatchSound||'agent-dispatch-ambient'}.mp3 unless cfg.askDispatchSoundEnabled===false or target muted (app.js:40-46). Permission is requested via Notification.requestPermission() when the cfg-notify-idle checkbox is toggled on (settings.js:575-581).

### [ws-msg] telemetry.autosetup / telemetry.configure
- direction: client->server
- shape: {type:'telemetry.autosetup', presetId, commandId} → server replies {type:'telemetry.autosetup.result', success: bool, presetId, commandId} ; {type:'telemetry.configure', presetId, commandId: string|undefined, enable: false} (sent when disabling the last enabled command of an agent type)
- notes: app.js:614, settings.js:434/447. Auto-setup patches the CLI's hook config (e.g. Claude Code hooks) so working/idle telemetry reaches CliDeck; a session restart ({type:'session.restart'}) is offered afterward. Setup text substitutes {{port}} with location.port || '4000'.

### [ws-msg] plugin message namespace
- direction: internal
- shape: Any type matching /^plugin\./ is routed to plugin handlers. Client→server: {type:`plugin.${pluginId}.${event}`, ...data}. Server→client same naming. Plugin settings: {type:'plugin.settings.update', pluginId, key, value} ; {type:'plugin.install', pluginId} → {type:'plugin.install.result', pluginId, success} ; {type:'plugin.delete', pluginId} → {type:'plugin.delete.error', error} on failure
- notes: app.js:396-398 default-case dispatch; loadPlugins (app.js:1043-1114) dynamic-imports /plugins/{id}/client.js and hands it a send/onMessage API. A custom orchestrator can piggyback on this namespace for its own message types if it also patches the server, but plain new top-level types are simpler.

### [ws-msg] dirs.list / dirs.mkdir (folder picker)
- direction: client->server
- shape: {type:'dirs.list', path: string, showHidden: bool} → {type:'dirs', ...} ; {type:'dirs.mkdir', parent: string, name: string} → {type:'dirs.mkdir', ...}
- notes: folder-picker.js:50,124; handlers app.js:215-219.

### [function-api] send(msg) + offline queue (state.js)
- direction: internal
- shape: export function send(msg): boolean — JSON.stringify+ws.send if readyState OPEN, else enqueue ONLY if msg.type ∈ QUEUEABLE_TYPES = {'checkAvailability','close','config.update','create','plugin.delete','plugin.install','project.delete','project.openPath','remote.install','remote.pair','remote.unpair','session.mute','session.restart','session.resume','session.setProject','session.theme','telemetry.autosetup','telemetry.configure'}; config.update replaces any queued config.update; flushQueuedSends() drains on reconnect
- notes: state.js:16-65. Everything else (input, rename, resize, terminal.buffer, session.setPreview, plugin.*) is silently dropped while disconnected.

### [file-format] localStorage keys
- direction: disk
- shape: 'clideck.activeSessionId' (restored on sessions message to reselect), 'clideck.pluginsExpanded' (JSON map pluginId→true), plus a creator MRU key (MRU_KEY in creator.js) storing the last-used commandId/presetId
- notes: app.js:101, 892-897; per-browser UI state only, nothing critical.

### [ws-msg] remote.* (mobile remote pairing — likely irrelevant to a group-chat frontend)
- direction: client->server
- shape: {type:'remote.status', forceUpdate?: bool} → {type:'remote.status', installed, version, paired, pairedAt, connected, url, qr (data: URI), deviceName, location} ; {type:'remote.pair'} → {type:'remote.paired', url, qr} ; {type:'remote.unpair'} → {type:'remote.unpaired'} ; {type:'remote.install', update, restart} → progress {type:'remote.install.progress', text} then {type:'remote.install.done', success, update, restart, error} ; unsolicited {type:'remote.update', available, latest} and {type:'remote.error', error}
- notes: app.js:1180-1565. Sent once on every ws open ({type:'remote.status', forceUpdate:true}); a custom client can simply ignore this whole family.

## Integration notes
A custom group-chat frontend should bypass all four of these files and speak the WS protocol directly: connect to the same origin the CliDeck server listens on (ws:// on the HTTP port, default 4000), then passively consume the bootstrap pushes ('config', 'presets', 'sessions', 'sessions.resumable', 'transcript.cache') — no request message is needed to get initial state, and projects come embedded in config.projects. Reuse as-is conceptually: the offline-queue pattern from state.js (17-type whitelist, config.update dedupe) is worth copying verbatim since 'input'/'rename' must never be sent on a closed socket. To create an agent session for a chat member: pick or create a cfg.commands entry (that entry — presetId, command, env — is the agent's 'role'), send {type:'create', commandId, name, cwd, projectId, cols:80+, rows:24+}, wait for 'created' (carries the session id), then drive it with {type:'input', id, data} and read {type:'output', id, data} plus the cleaner {type:'session.preview'/'transcript.append'} streams for chat-style rendering; use {type:'session.status', id, working} as the typing-indicator signal. Group semantics map onto projects: create a project by appending to cfg.projects and sending a full {type:'config.update', config} (careful: FULL replace — always mutate the latest received cfg, never a stale copy), move members with {type:'session.setProject', id, projectId}, delete with {type:'project.delete', id}. Rename via {type:'rename'} and handle 'session.renameRejected' (names are unique per project). Notifications are client-side only — the server gives you session.status and session.dispatch events; reimplement sounds/Notifications yourself using cfg.notifyIdle/notifyMinWork/notifySound/askDispatchSound if you want parity. Avoid: the remote.* family (mobile pairing UI), telemetry.autosetup UI flow (but DO ensure telemetry is configured once per agent type or working/idle status won't flow), and the plugin dynamic-import machinery. If you need custom server-side behavior, the `plugin.<id>.<event>` message namespace is the sanctioned extension point.

## Risks
1) config.update is a whole-object replace with no versioning: if the custom frontend and the stock CliDeck UI (or two custom clients) are open simultaneously, whichever sends config.update last wins, and any project/command/setting the other client added since your last received 'config' message is silently destroyed — always apply mutations to the freshest broadcast config, and expect races anyway. 2) send() silently drops non-whitelisted messages when the socket is down (returns false from enqueue path) — chat messages sent as {type:'input'} during a reconnect window vanish without error; a custom frontend needs its own outbox/ack layer. 3) These frontend files pin the client half of the protocol, but exact server-side field validation (e.g. whether 'create' accepts extra fields, what 'sessions.resumable' items fully contain, dirs/pills payloads) must be confirmed against the server slice — several shapes here are inferred from how the client consumes them. 4) working/idle status depends on per-agent telemetry hooks being installed (telemetry.autosetup); on a fresh machine session.status may never fire until setup is done, so a group-chat UI relying on it for turn-taking will stall. 5) Reconnect replay: 'output'/'session.history' arrive with replay:true after reconnect and the stock client skips them for existing terminals — a custom client that doesn't handle the replay flag will duplicate transcript content. 6) Rename is optimistic client-side; server can reject (session.renameRejected), so treat names as unconfirmed until 'renamed' arrives. 7) The file set examined is the globally installed npm copy (C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\clideck) — a future `npm update -g clideck` can change this protocol without warning since it is internal and unversioned.
