const { binName } = require('./utils');

const GUIDE = `CliDeck session guide:
You are running inside CliDeck only when CLIDECK_SESSION_ID is set.
Use clideck agents to discover peer sessions.
Use clideck ask status to see which sessions are idle or busy.
Use clideck ask "<target>" "<message>" --timeout 10m to ask an idle peer agent.
Use the exact @project/session address from clideck agents --all for cross-project asks.
Keep clideck ask running until it exits; the answer returns on stdout.
If a target is busy, the request is not queued. Try later or ask another idle agent.
If CLIDECK_SESSION_ID is missing, ignore this guide.`;

function commandStart(parts) {
  if (process.platform === 'win32' && parts.length > 2 && /^cmd(?:\.exe)?$/i.test(binName(parts[0])) && parts[1].toLowerCase() === '/c') {
    return 2;
  }
  return 0;
}

function hasCodexDeveloperInstructions(parts) {
  return parts.some((part, idx) => {
    if (part === '-c' || part === '--config') return String(parts[idx + 1] || '').startsWith('developer_instructions=');
    return String(part || '').startsWith('-cdeveloper_instructions=')
      || String(part || '').startsWith('--config=developer_instructions=');
  });
}

function withCliDeckGuide(parts, presetId) {
  const next = [...parts];
  const idx = commandStart(next);

  if (presetId === 'claude-code') {
    if (next.includes('--system-prompt') || next.includes('--append-system-prompt')) return next;
    next.splice(idx + 1, 0, '--append-system-prompt', GUIDE);
  } else if (presetId === 'codex') {
    if (hasCodexDeveloperInstructions(next)) return next;
    next.splice(idx + 1, 0, '-c', `developer_instructions=${JSON.stringify(GUIDE)}`);
  }

  return next;
}

module.exports = { withCliDeckGuide, GUIDE };
