const http = require('http');
const https = require('https');

function usage() {
  return [
    'Usage:',
    '  clideck ask status [--json] [--all]',
    '  clideck ask --session <name-or-id> --message <text> [--timeout 10m]',
    '  clideck ask <name-or-id> <message> [--timeout 10m]',
    '  clideck ask "@project-name/session-name" <message> [--timeout 10m]',
    '  cat file.txt | clideck ask --session <name-or-id> [--timeout 10m]',
    '',
    'Use from inside a CliDeck session when this agent needs an answer from another active session.',
    'CliDeck ask lets agents communicate with each other without manual copy/paste through the user.',
    'Unscoped target lookup is limited to the same project as the caller session.',
    'Use @project/session only when you intentionally need to ask across projects.',
    'Run `clideck agents` or `clideck agents --all` first to discover available target sessions.',
    'Run `clideck ask status` to quickly see which project sessions are idle or busy.',
    'Copy and use the target exactly as listed by `clideck agents`; quote it if it contains spaces.',
    '',
    'Important for agents:',
    '  The target is another LLM agent, not a fast CLI command. It may need minutes to read files,',
    '  think, use tools, and answer.',
    '  Keep this shell command running until it exits. The target agent response is returned through',
    '  this command\'s stdout; if you background it, stop watching it, or let your shell/tool timeout',
    '  kill it, the target may keep working but you will lose the response channel.',
    '  Set BOTH `clideck ask --timeout` and your own shell/tool-call timeout high enough.',
    '  Waiting progress is printed to stderr; the target response is printed to stdout.',
    '  CliDeck only sends to idle target agents. If the target is busy, the ask fails immediately;',
    '  it is not queued. Try again later or ask another idle agent.',
    '  To ask multiple agents, start one `clideck ask` command per target and keep each command open.',
    '',
    'Options:',
    '  status                   Show idle/busy state for active project sessions.',
    '  -s, --session <name-or-id>  Target session name or id.',
    '  -m, --message <text>       Message to send. If omitted, stdin is used.',
    '  -t, --timeout <duration>   Wait time. Examples: 30s, 10m, 1h. Default: 10m.',
    '  --url <url>                CliDeck server URL. Default: CLIDECK_URL or local port.',
    '  --json                     With status: print machine-readable JSON.',
    '  --all                      With status: include all projects.',
    '  --no-progress              Do not print waiting hints to stderr.',
    '  -h, --help                 Show this help.',
  ].join('\n');
}

function parseStatusArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = { json: false, all: false, url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}` };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--url') out.url = args[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown status argument: ${arg}`);
  }
  return out;
}

function parseDuration(value) {
  if (!value) return 10 * 60 * 1000;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const scale = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return Math.max(1, Math.round(n * scale));
}

function parseArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = { timeoutMs: 10 * 60 * 1000, url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}`, progress: true };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session' || arg === '-s') out.session = args[++i];
    else if (arg === '--message' || arg === '-m') out.message = args[++i];
    else if (arg === '--timeout' || arg === '-t') {
      const parsed = parseDuration(args[++i]);
      if (!parsed) throw new Error('Invalid timeout value');
      out.timeoutMs = parsed;
    } else if (arg === '--url') out.url = args[++i];
    else if (arg === '--no-progress') out.progress = false;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else positional.push(arg);
  }
  if (!out.session && positional.length) out.session = positional.shift();
  if (!out.message && positional.length) out.message = positional.join(' ');
  return out;
}

function readStdinIfAvailable() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function oneLine(text, max = 160) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function getJson(url, path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck request failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CliDeck progress check timed out')));
    req.on('error', reject);
  });
}

function findAgent(agents, target) {
  const text = String(target || '').trim();
  if (!text) return null;
  const byId = agents.filter(a => a.id === text);
  if (byId.length === 1) return byId[0];
  const byAddress = agents.filter(a => a.address === text);
  if (byAddress.length === 1) return byAddress[0];
  const exact = agents.filter(a => a.name === text);
  if (exact.length === 1) return exact[0];
  const lower = text.toLowerCase();
  const insensitive = agents.filter(a => String(a.name || '').toLowerCase() === lower || String(a.address || '').toLowerCase() === lower);
  return insensitive.length === 1 ? insensitive[0] : null;
}

function formatStatus(agents, opts = {}) {
  if (!agents.length) return opts.all ? 'No active sessions found.' : 'No active sessions found in this project.';
  return agents.map(a => {
    const status = a.working ? 'busy' : 'idle';
    const self = a.caller ? ' self' : '';
    const address = a.address && a.address !== a.name ? ` ${a.address}` : '';
    const project = opts.all && a.project ? ` project="${a.project}"` : '';
    return `${status.padEnd(4)}  ${a.name}${self}${address}${project}`;
  }).join('\n');
}

async function runStatus(args) {
  const opts = parseStatusArgs(args);
  if (opts.help) {
    console.log(usage());
    return;
  }
  const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
  if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');
  const all = opts.all ? '&all=1' : '';
  const res = await getJson(opts.url, `/api/session/agents?callerSessionId=${encodeURIComponent(callerSessionId)}${all}`);
  const agents = (res.agents || []).map(a => ({ ...a, status: a.working ? 'busy' : 'idle' }));
  if (opts.json) process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
  else process.stdout.write(formatStatus(agents, opts) + '\n');
}

function startProgressHints(opts, callerSessionId) {
  if (!opts.progress) return () => {};
  const started = Date.now();
  let stopped = false;
  let lastLine = '';

  const write = (line) => {
    if (!line || line === lastLine) return;
    lastLine = line;
    process.stderr.write(`${line}\n`);
  };

  write(`[clideck ask] sent to "${opts.session}". waiting up to ${formatDuration(opts.timeoutMs)}. keep waiting until this command exits.`);

  const tick = async () => {
    if (stopped) return;
    try {
      const all = String(opts.session || '').trim().startsWith('@') ? '&all=1' : '';
      const path = `/api/session/agents?callerSessionId=${encodeURIComponent(callerSessionId)}${all}`;
      const res = await getJson(opts.url, path, 4000);
      const agent = findAgent(res.agents || [], opts.session);
      const elapsed = formatDuration(Date.now() - started);
      if (!agent) {
        write(`[clideck ask] still waiting for "${opts.session}" (${elapsed} elapsed).`);
        return;
      }
      const status = agent.working ? 'working' : 'idle/capturing answer';
      const preview = oneLine(agent.lastPreview);
      write(`[clideck ask] "${agent.name}" is ${status} (${elapsed} elapsed).${preview ? ` latest: ${preview}` : ''}`);
    } catch {
      const elapsed = formatDuration(Date.now() - started);
      write(`[clideck ask] still waiting for "${opts.session}" (${elapsed} elapsed).`);
    }
  };

  const first = setTimeout(tick, 5000);
  const interval = setInterval(tick, 15000);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/session/ask', url);
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs + 5000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck ask failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CliDeck ask timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function run(args) {
  try {
    if (args[0] === 'status') {
      await runStatus(args.slice(1));
      return;
    }
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (!opts.message) opts.message = (await readStdinIfAvailable()).trim();
    if (!opts.session || !opts.message) throw new Error(usage());
    const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');

    const stopProgress = startProgressHints(opts, callerSessionId);
    const res = await postJson(opts.url, {
      callerSessionId,
      target: opts.session,
      message: opts.message,
      timeoutMs: opts.timeoutMs,
    }, opts.timeoutMs).finally(stopProgress);
    process.stdout.write((res.response || '').trimEnd() + '\n');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs, parseDuration, parseStatusArgs, formatStatus };
