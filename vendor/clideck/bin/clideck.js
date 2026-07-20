#!/usr/bin/env node
const args = process.argv.slice(2);

function usage() {
  const version = require('../package.json').version;
  return [
    `CliDeck v${version}`,
    '',
    'Usage:',
    '  clideck [--host <host>] [--port <port>]',
    '  clideck agents [--json] [--all]',
    '  clideck ask status [--json] [--all]',
    '  clideck ask --session <name-or-id> --message <text> [--timeout 10m]',
    '',
    'Options:',
    '  --host <host>     Host to bind. Default: 127.0.0.1. Use 0.0.0.0 for LAN access.',
    '  --port <port>     Port to use. Default: 4000. Can also use CLIDECK_PORT.',
    '  -h, --help        Show this help.',
    '  -v, --version     Show version.',
    '',
    'Agent tools:',
    '  clideck agents',
    '    Lists active sessions in the same project as the caller session.',
    '    Use this first when an agent needs to discover who it can ask.',
    '    Add --all to list cross-project targets with @project/session ask addresses.',
    '',
    '  clideck ask',
    '    Use from inside a CliDeck session when one agent needs an answer from another session.',
    '    This lets agents communicate with each other without manual copy/paste through the user.',
    '    Use `clideck ask status` first when the agent only needs idle/busy state.',
    '',
    'Ask behavior:',
    '  Unscoped target lookup is limited to the same project as the caller session.',
    '  Cross-project asks must use an explicit @project/session target.',
    '  Use the target exactly as shown by `clideck agents`; quote it if it contains spaces.',
    '  CliDeck sends the message into the real target terminal, presses Enter, waits for the',
    '  target to finish, then prints the target agent response to stdout.',
    '  The target is another LLM agent. It may need minutes to think, read files, and use tools.',
    '  Keep the `clideck ask` shell command running until it exits. stdout is the response channel.',
    '  Waiting progress goes to stderr; the target response goes to stdout.',
    '  Set both `--timeout` and your shell/tool-call timeout high enough, or the target may keep',
    '  working while the caller loses the response.',
    '  CliDeck only sends to idle targets and does not queue asks. If the target is busy, retry',
    '  later or ask another idle agent.',
    '  To ask multiple agents, run one `clideck ask` command per target and keep each one open.',
    '',
    'Examples:',
    '  clideck agents',
    '  clideck agents --json',
    '  clideck agents --all',
    '  clideck ask status',
    '  clideck ask status --all',
    '  clideck ask --session "Reviewer" --message "Review my changes and return only findings."',
    '  clideck ask "research manager" "Check this plan and tell me what is missing." --timeout 15m',
    '  clideck ask "@website/Docs Writer" "Check if the docs mention the new CLI flags." --timeout 15m',
    '  cat notes.md | clideck ask --session "Docs Writer" --timeout 10m',
    '',
    'Notes for agents:',
    '  CliDeck supports agent-to-agent communication: discover teammates with `clideck agents`,',
    '  then ask them directly with `clideck ask`.',
    '  Run `clideck agents` to discover available same-project sessions.',
    '  Run `clideck ask status` to check who is idle or busy before dispatching work.',
    '  Run `clideck agents --all` before a cross-project ask.',
    '  Run `clideck ask --help` for the exact ask command contract.',
    '  If a target has spaces, quote the whole target, including @project/session addresses.',
  ].join('\n');
}

if (args[0] === 'agents') {
  require('../clideck-agents-cli').run(args.slice(1));
} else if (args[0] === 'ask') {
  require('../clideck-ask-cli').run(args.slice(1));
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
} else {
  require('../server.js');
}
