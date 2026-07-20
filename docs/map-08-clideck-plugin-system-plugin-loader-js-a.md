# CliDeck plugin system (plugin-loader.js) + Autopilot plugin (plugins/autopilot: index.js, client.js, clideck-plugin.json, prompt.md, package.json)

## Summary
CliDeck's plugin system lives in C:\Users\<user>\AppData\Roaming\npm\node_modules\clideck\plugin-loader.js. Bundled plugins ship in <app>\plugins and are seeded/updated into ~/.clideck/plugins (DATA_DIR from paths.js); each plugin is a folder with clideck-plugin.json (manifest: id, name, version, install:"npm", settings[]) plus index.js (server side, exports init(api)) and optional client.js (browser side, ES module served at GET /plugins/<id>/client.js via plugins.resolveFile in server.js:277 and dynamically import()ed by public/js/app.js loadPlugins()). The server api (buildApi, version:1) gives plugins hooks — onSessionInput (input transform, wired at sessions.js:317), onSessionOutput (raw PTY bytes, sessions.js:145), onStatusChange(id, working, source) (fired from sessions.broadcast on every 'session.status' broadcast, deduped in plugin-loader.notifyStatus), onTranscriptEntry, onMenuDetected(id, choices), onConfigChange — plus actuators: inputToSession(id, data) (writes through the normal input path), createSession/closeSession, setAutoApproveMenu(id, bool) (handlers.js:402 then auto-sends '\r' 500ms after any detected menu), getTranscript(id, n, order) returning folded [{role:'user'|'agent', text}] turns, sendToFrontend/onFrontendMessage (WS messages namespaced 'plugin.<pluginId>.<event>'), expose()/invoke() for server-internal capabilities, settings accessors, session pills, and resolve() for plugin-local node_modules. Autopilot (bundled plugin, v0.20.0) is an LLM dispatcher: per project it snapshots all non-shell sessions as "workers", infers a project goal and a role+summary per worker by calling a router LLM (via @mariozechner/pi-ai, provider/model/apiKey from plugin settings, apiKey falling back to the provider env var e.g. ANTHROPIC_API_KEY), then on every status change waits for a worker to go idle, 5s later captures its latest agent transcript turn (latestAgentOutput, capped 8000 chars), and when ALL workers are idle consults the router LLM with a state context + agent outputs; the model must call exactly one tool: route(from, to) — which pastes the source agent's captured output verbatim (with a bracketed header naming team/target/role/from) into the target session's PTY followed by '\r' 150ms later — or notify_user(reason) which stops autopilot and toasts the user. Role names live only in memory (proj.workers Map: sessionId → {name, label, role, summary, presetId}; label = session display name, deduped with a 6-char id suffix) and are echoed into a per-project JSONL knowledge base; persistent files are ~/.clideck/autopilot/<safeProjectId>.jsonl (routing/KB log), ~/.clideck/autopilot/goals/<safeProjectId>.json ({text, builtAt, source}), ~/.clideck/autopilot/usage.json (projectId → {input, output} token totals), and optional debug transcripts in ~/.clideck/autopilot/logs/*.md when the 'debugging' setting is on. Idle/working state itself originates outside the plugin: 'session.status' broadcasts come from telemetry hooks (source 'hook'), the browser's 'session.statusReport' (source 'client'), menu detection over browser-fed 'terminal.buffer' lines (source 'menu'), Esc (source 'esc'), and menu answers (source 'menu-input') — meaning autopilot's observation loop partially depends on an active browser tab feeding terminal buffers.

## Interfaces

### [function-api] Server plugin API (buildApi, version 1)
- direction: internal
- shape: init(api) receives: { version:1, pluginId, pluginDir, onSessionInput(fn(id,data)->string?), onSessionOutput(fn(id,data)), onStatusChange(fn(id, working:boolean, source:string)), onTranscriptEntry(fn(id, role, text)), onMenuDetected(fn(id, choices)), onConfigChange(fn(cfg)), sendToFrontend(event, data) -> broadcasts {...data, type:`plugin.${pluginId}.${event}`}, onFrontendMessage(event, fn(msg)), expose(name, fn) (invoked via plugins.invoke(pluginId,name,data)), getSession(id)/getSessions() -> {id, name, cwd, commandId, presetId, themeId, projectId, working:boolean}, createSession(opts:{presetId?|commandId?, cwd?, themeId?, name?, projectId?, ephemeral?}) -> id|null, closeSession(id), inputToSession(id, data), setAutoApproveMenu(id, enabled), getProjects(), getTranscript(id, n=20, order='end'|'start') -> [{role:'user'|'agent', text}], detectMenu(lines, presetId) -> [{value:'1', label, selected:boolean}]|null, addToolbarAction({id,title,icon})/addProjectAction({id,title,icon}), addSessionPill({id,title,projectId,icon?})/updateSessionPill(id,{title?,working?,statusText?,projectId?})/appendPillLog(id,text)/removeSessionPill(id), getSetting(key)/getSettings()/onSettingsChange(fn(key,value))/setSettingOptions(key,options)/setSetting(key,value), resolve(specifier), onShutdown(fn), log(msg) }
- notes: plugin-loader.js:190-324. Hooks fire from sessions.js (transformInput at input(), notifyOutput at pty.onData, notifyStatus inside broadcast() for type 'session.status') and handlers.js:412 (notifyMenu). notifyStatus dedupes on `${working?1:0}:${source}` per session.

### [function-api] Client plugin API (browser injection)
- direction: internal
- shape: app.js loadPlugins(): for each plugin with hasClient, `await import('/plugins/${id}/client.js')` then mod.init({ pluginId, send(event, data={}) -> ws send {...data, type:`plugin.${id}.${event}`}, onMessage(event, fn) (single handler per `plugin.${id}.${event}`), addToolbarButton(opts), addTerminalInputButton(opts), getActiveSessionId(), getTerminalSelection(), writeToSession(id, text) -> ws {type:'input', id, data:text}, toast(message, {title?, type:'info'|'warn'|'error', duration?, markdown?, iconHtml?}), registerHotkey(combo, cb), unregisterHotkey(combo) })
- notes: public/js/app.js:1091-1113. Incoming WS msgs with type starting 'plugin.' are dispatched to the single registered handler (app.js:397, dispatchPluginMessage).

### [http-route] GET /plugins/:id/client.js and /plugins/:id/<public asset>
- direction: server->client
- shape: path regex ^\/plugins\/([^/]+)\/(.+)$; 'client.js' served from plugin dir root, anything else only from <pluginDir>/public/
- notes: plugin-loader.resolveFile, called from server.js:277.

### [ws-msg] plugin.<pluginId>.<event> (generic plugin channel)
- direction: client->server
- shape: { type: 'plugin.<pluginId>.<event>', ...arbitrary fields }; unmatched types starting with 'plugin.' fall through to plugins.handleMessage (handlers.js:743)
- notes: Toolbar buttons send {type, action:actionId}; project-header buttons send {type, action:actionId, projectId}.

### [ws-msg] plugin.settings.update / plugin.install / plugin.delete / pill.getLogs
- direction: client->server
- shape: {type:'plugin.settings.update', pluginId, key, value} | {type:'plugin.install', pluginId} -> replies 'plugin.install.progress' then 'plugin.install.result' {pluginId, success, error?} | {type:'plugin.delete', pluginId} -> error reply 'plugin.delete.error' {pluginId, error} | {type:'pill.getLogs', id} -> reply {type:'pill.logs', id, logs:[{ts,text}]}
- notes: handlers.js:598-627. Server broadcasts {type:'plugins', list} (shape per plugin: id,name,version,author,description,icon,settings,settingValues,dynamicOptions,actions,capabilities,hasClient,bundled,installed) and on connect sends {type:'pills', list}.

### [ws-msg] pill.added / pill.updated / pill.removed / pill.log
- direction: server->client
- shape: {type:'pill.added'|'pill.updated', pill:{id, pluginId, title, projectId, working, statusText, icon, startedAt}} | {type:'pill.removed', id} | {type:'pill.log', id, entry:{ts, text}}
- notes: Autopilot's run pill id is `autopilot-${projectId}`.

### [ws-msg] session.status (idle/working signal autopilot consumes)
- direction: server->client
- shape: {type:'session.status', id, working:boolean, source:'hook'|'client'|'menu'|'menu-input'|'esc'}
- notes: sessions.broadcast intercepts this type, updates session.working, and calls plugins.notifyStatus(id, working, source) (sessions.js:42-62). 'client' source comes from browser msg {type:'session.statusReport', id, working} (handlers.js:364).

### [ws-msg] terminal.buffer (menu detection feed)
- direction: client->server
- shape: {type:'terminal.buffer', id, lines:string[], menuVersion?:number}
- notes: handlers.js:369-417. Server runs transcript.detectMenu(lines, presetId); on a menu it broadcasts {type:'session.menu', id, choices:[{value,label,selected}]}, calls plugins.notifyMenu, broadcasts session.status working:false source:'menu', and if plugins.shouldAutoApproveMenu(id) (set by autopilot for all workers) sends '\r' input after 500ms. Browser-fed: no active client = no menu detection.

### [ws-msg] plugin.autopilot.autopilot-toggle
- direction: client->server
- shape: {type:'plugin.autopilot.autopilot-toggle', action:'autopilot-toggle', projectId:string}
- notes: Toggles: if projects.has(projectId) stop, else start. Start errors are sent as plugin.autopilot.error {msg}.

### [ws-msg] plugin.autopilot.getStatus / sync / getTokens
- direction: client->server
- shape: {type:'plugin.autopilot.getStatus', projectId} -> reply 'plugin.autopilot.status' {projectId, active:boolean, paused:boolean, tokens:{input,output}|null}; {type:'plugin.autopilot.sync'} -> one 'status' {projectId, active:true} per running project; {type:'plugin.autopilot.getTokens', projectId} -> 'plugin.autopilot.tokens' {projectId, input, output}
- notes: index.js:1197-1217.

### [ws-msg] plugin.autopilot.* lifecycle broadcasts
- direction: server->client
- shape: {type:'plugin.autopilot.started', projectId} | {type:'plugin.autopilot.stopped', projectId} | {type:'plugin.autopilot.error', msg} | {type:'plugin.autopilot.routed', projectId, projectName, from, to} | {type:'plugin.autopilot.notify', projectId, reason, projectName?} | {type:'plugin.autopilot.paused', projectId, question} | {type:'plugin.autopilot.resumed', projectId} | {type:'plugin.autopilot.tokens', projectId, input, output}
- notes: All broadcast to every connected WS client; 'notify' reason is light markdown and always accompanies autopilot stopping (stop(pid, true)).

### [function-api] Autopilot router LLM tools
- direction: internal
- shape: route(from:string, to:string) — labels matched case-insensitively against worker.label; notify_user(reason:string). toolChoice 'any' for anthropic/google/mistral, 'required' otherwise; up to 3 attempts with corrective toolResult hints, then autopilot stops.
- notes: buildTools (index.js:642-660); system prompt from plugins/autopilot/prompt.md with {{projectName}} and {{agents}} placeholders (agents rendered as 'label [WORKING|IDLE]\n  Inferred role: ...\n  Summary: ...').

### [function-api] Routed payload injected into target PTY
- direction: internal
- shape: `[Autopilot route | output #<12-hex sha256 prefix>]\n[Team: <label, label, ...>]\n[Target session: <label>]\n[Target inferred role: <role>]\n[From: <label>]\n[Do not spawn internal agents.]\n\n<verbatim source output>` then api.inputToSession(dst, '\r') after 150ms
- notes: executeAction 'route' (index.js:940-963). Repeat guard blocks re-routing the same outputId to the same target unless newer output was captured.

### [file-format] ~/.clideck/autopilot/<safeProjectId>.jsonl (KB / routing history)
- direction: disk
- shape: one JSON object per line: {ts:number, from:label, msg:string(≤4000), outputId:'12-hex'} for captures; {ts, from, to, msg, outputId} for routes; {ts, type:'worker-role', worker:label, role, summary, added?:true}; {ts, type:'goal', goal:text, source:'explicit-message'|'model'|'saved', usage?, loaded?:true}
- notes: safeId = projectId with [^a-zA-Z0-9_-] replaced by '_', max 64 chars. File is deleted (resetProjectState) on every autopilot start. Last 30 entries feed HANDOFF LOG / RECENT HISTORY in the router context.

### [file-format] ~/.clideck/autopilot/goals/<safeProjectId>.json + usage.json + logs/
- direction: disk
- shape: goal file: {text:string, builtAt:ISO, source:'explicit-message'|'model'}; usage.json: {"<projectId>": {input:number, output:number}, ...}; logs/<pid>_<NNN>_<label>_<ts>.md debug dumps (only when 'debugging' setting true)
- notes: Explicit goal: a user message in any worker session whose line starts with 'AUTOPILOT GOAL:' (GOAL_PREFIX, index.js:9) overrides the model-built goal; multiple distinct explicit goals is a hard error. Saved goal is reused across runs.

### [file-format] clideck-plugin.json manifest
- direction: disk
- shape: {id, name, version, author?, description?, icon?(inline SVG), install?:'npm', settings?:[{key, label, type:'toggle'|'number'|'select'|'dynamic-select'|'text', default, options?, min?, max?, placeholder?, description?}]}
- notes: Autopilot settings keys: 'enabled' (toggle, default true), 'provider' (select: anthropic|openai|google|groq|openrouter|xai|mistral|cerebras, default anthropic), 'model' (dynamic-select, default 'claude-opus-4-6'), 'apiKey' (text), 'debugging' (toggle). Legacy fallback manifest name: termix-plugin.json.

### [env-var] Provider API key fallback
- direction: internal
- shape: apiKey setting || piAi.getEnvApiKey(provider) — standard provider env vars, e.g. ANTHROPIC_API_KEY (manifest placeholder: 'Falls back to env var (ANTHROPIC_API_KEY, etc.)')
- notes: No key -> start() errors 'Set the API key in Autopilot settings (Plugins panel)'; mid-run it pauses with pauseReason 'config' and resumes on settings change.

### [env-var] CLIDECK_SESSION_ID / CLIDECK_PORT / CLIDECK_URL
- direction: internal
- shape: injected into every spawned PTY's env (sessions.js buildTelemetryEnv); OTEL_RESOURCE_ATTRIBUTES gets 'clideck.session_id=<id>' appended for telemetry-mapped agents
- notes: How the agent CLIs report status back (source 'hook').

## Integration notes
A custom group-chat frontend has three viable hook-in levels. (1) Reuse autopilot as-is over the existing WS: connect to the CliDeck server WebSocket, send {type:'plugin.autopilot.autopilot-toggle', projectId} to start/stop, and render the group chat from broadcasts — 'plugin.autopilot.routed' gives from/to labels for each handoff, 'plugin.autopilot.notify' is the completion/blocked message, and the actual routed text can be read from ~/.clideck/autopilot/<safeProjectId>.jsonl (from/to/msg per line, msg capped at 4000 chars) or reconstructed from per-session transcripts. Role names come through pill logs ('Role: <label> → <role>' lines via pill.log / pill.getLogs) and KB {type:'worker-role'} entries — there is no WS query that returns the worker/role table directly. (2) Replace autopilot with your own orchestrator plugin: drop a folder in ~/.clideck/plugins (clideck-plugin.json + index.js), and use api.onStatusChange + api.getTranscript + api.inputToSession + api.setAutoApproveMenu + sendToFrontend/onFrontendMessage; this gets you the same observation/actuation surface autopilot uses, with your own message vocabulary 'plugin.<yourId>.<event>' — the cleanest path for a custom group-chat protocol. (3) Drive sessions directly: send {type:'input', id, data} (goes through plugins.transformInput and transcript tracking — do NOT bypass this) and create sessions with {type:'create', commandId, name, projectId, cwd} (server broadcasts 'created'). Critical operational dependency to preserve: menu auto-approve and part of idle detection are fed by the browser — some connected client must keep sending {type:'terminal.buffer', id, lines} (visible xterm buffer lines) and {type:'session.statusReport', id, working} or menus never get detected/answered and autopilot stalls (this is why client.js toasts 'Keep this browser tab active'); a headless custom frontend must replicate that feed or keep a stock CliDeck tab open. Also reuse the worker-eligibility rule: autopilot only manages sessions where projectId is set and presetId !== 'shell', and every such session must already contain at least one user message before start. To pin the goal deterministically from your frontend, inject a message starting with 'AUTOPILOT GOAL:' into any worker session before starting. Avoid: relying on per-client replies (all plugin.* frontend messages are broadcast to every WS client — filter by projectId yourself); registering two handlers for one event name (both frontendHandlers and pluginMessageHandlers are Maps, last registration wins); calling route semantics yourself while autopilot runs (its repeat-guard and waitingOn state will fight you — stop autopilot first).

## Risks
1) Browser-in-the-loop: menu detection ('terminal.buffer') and 'client'-source status reports originate from the web UI; a custom headless frontend that doesn't replicate them breaks auto-approve and can wedge autopilot's all-idle trigger for presets without telemetry hooks. 2) Autopilot requires a paid provider API key (pi-ai direct API calls, e.g. ANTHROPIC_API_KEY) — it does not ride the user's CLI subscription quota, which conflicts with the user's stated preference; a custom orchestrator plugin using the CLIs themselves would avoid this. 3) Role/worker state is ephemeral — proj.workers lives in memory and the KB jsonl is deleted on every start; only the goal file and usage.json persist, so a frontend must rebuild role maps from pill logs/KB each run. 4) All plugin frontend messages are fan-out broadcasts with single-handler maps; multiple custom clients will all receive everything and can double-act (e.g. two clients both toggling). 5) Routing pastes raw agent output + a header into the target PTY and presses Enter after 150ms — long outputs or slow TUIs can garble input; there is no delivery confirmation. 6) executeAction trusts labels case-insensitively; sessions renamed mid-run change labels only on refreshWorkers, so KB history labels can go stale. 7) Version 0.20.0 bundled plugin is overwritten on CliDeck upgrades (seeding logic in plugin-loader), so local edits to ~/.clideck/plugins/autopilot will be clobbered when the bundled version number changes — a custom fork must use a different plugin id. 8) Idle capture uses a fixed 5s debounce and 8000/2000-char truncation of the last agent turn; fast back-to-back turns or very long outputs can lose content silently.
