let enabled = true;
let btnEl = null;
let apiRef = null;
let currentHotkey = null;

async function trimAndCopy() {
  if (!enabled) return;
  const text = apiRef.getTerminalSelection();
  if (!text || !text.trim()) { apiRef.toast('Select text to copy & trim', { type: 'warn' }); return; }
  const trimmed = text
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/^\n+/, '').replace(/\n+$/, '');
  try {
    await navigator.clipboard.writeText(trimmed);
    const saved = text.length - trimmed.length;
    apiRef.toast(saved ? `Copied & trimmed ${saved} char${saved !== 1 ? 's' : ''}` : 'Copied', { type: 'success' });
  } catch {
    apiRef.toast('Clipboard access denied — allow it in browser site settings', { type: 'error' });
  }
}

function bindHotkey(hotkey) {
  const next = hotkey || 'F8';
  if (next === currentHotkey) return;
  const prev = currentHotkey;
  if (prev) apiRef.unregisterHotkey(prev);
  if (apiRef.registerHotkey(next, trimAndCopy)) {
    currentHotkey = next;
  } else if (prev) {
    apiRef.registerHotkey(prev, trimAndCopy);
    apiRef.toast(`Hotkey "${next}" is taken, keeping "${prev}"`, { type: 'warn' });
  } else {
    apiRef.toast(`Hotkey "${next}" is unavailable`, { type: 'warn' });
  }
}

export function init(api) {
  apiRef = api;
  api.onMessage('settings', (msg) => {
    enabled = msg.enabled !== false;
    if (btnEl) btnEl.style.display = enabled ? '' : 'none';
    bindHotkey(msg.hotkey || 'F8');
  });
  api.send('getSettings');

  btnEl = api.addToolbarButton({
    title: 'Trim & Copy',
    icon: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
    onClick: trimAndCopy,
  });
}
