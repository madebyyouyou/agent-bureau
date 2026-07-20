const http = require('http');
const https = require('https');

function usage() {
  return [
    'Usage:',
    '  clideck agents [--json] [--all]',
    '',
    'Lists active CliDeck sessions in the same project as the caller session.',
    'Use this to discover other agents before communicating with them through `clideck ask`.',
    'Use this from inside a CliDeck session before `clideck ask` to discover target names.',
    'Use --all to discover cross-project targets and their @project/session ask addresses.',
    'Use the printed ask= value exactly when present, and prefer idle targets for `clideck ask`.',
    '',
    'Options:',
    '  --json       Print machine-readable JSON.',
    '  --all        List sessions across all projects.',
    '  --url <url>  CliDeck server URL. Default: CLIDECK_URL or http://127.0.0.1:<port>.',
    '  -h, --help   Show this help.',
  ].join('\n');
}

function parseArgs(args) {
  const port = process.env.CLIDECK_PORT || process.env.PORT || '4000';
  const out = { json: false, all: false, url: process.env.CLIDECK_URL || `http://127.0.0.1:${port}` };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--url') out.url = args[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function getJson(url, callerSessionId, all = false) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/session/agents', url);
    target.searchParams.set('callerSessionId', callerSessionId);
    if (all) target.searchParams.set('all', '1');
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck agents failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
  });
}

function formatAgents(agents, opts = {}) {
  if (!agents.length) return opts.all ? 'No active sessions found.' : 'No active sessions found in this project.';
  return agents.map(a => {
    const marker = a.caller ? 'self' : 'peer';
    const status = a.working ? 'working' : 'idle';
    const preview = a.lastPreview ? ` - ${a.lastPreview}` : '';
    const address = a.address && a.address !== a.name ? ` ask=${a.address}` : '';
    const project = opts.all && a.project ? ` project="${a.project}"` : '';
    return `${a.name} (${marker}, ${a.preset}, ${status}) id=${a.id}${address}${project}${preview}`;
  }).join('\n');
}

async function run(args) {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(usage());
      return;
    }
    const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');

    const res = await getJson(opts.url, callerSessionId, opts.all);
    if (opts.json) process.stdout.write(JSON.stringify(res.agents || [], null, 2) + '\n');
    else process.stdout.write(formatAgents(res.agents || [], opts) + '\n');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs, formatAgents };
