export const state = {
  ws: null,
  terms: new Map(),
  active: null,
  cfg: { commands: [], defaultPath: '', defaultTheme: 'catppuccin-mocha' },
  themes: [],
  presets: [],
  resumable: [],
  filter: { query: '', tab: 'all' },
  pills: new Map(),
  activePill: null,
  transcriptCache: {},
  remoteVersion: null,
};

const queuedMessages = [];
const QUEUEABLE_TYPES = new Set([
  'checkAvailability',
  'close',
  'config.update',
  'create',
  'plugin.delete',
  'plugin.install',
  'project.delete',
  'project.openPath',
  'remote.install',
  'remote.pair',
  'remote.unpair',
  'session.mute',
  'session.restart',
  'session.resume',
  'session.setProject',
  'session.theme',
  'telemetry.autosetup',
  'telemetry.configure',
]);

function canSendNow() {
  return state.ws && state.ws.readyState === WebSocket.OPEN;
}

function enqueue(msg) {
  if (!QUEUEABLE_TYPES.has(msg?.type)) return false;
  if (msg.type === 'config.update') {
    const idx = queuedMessages.findIndex(item => item.type === 'config.update');
    if (idx >= 0) queuedMessages[idx] = msg;
    else queuedMessages.push(msg);
    return true;
  }
  queuedMessages.push(msg);
  return true;
}

export function send(msg) {
  if (!canSendNow()) return enqueue(msg);
  state.ws.send(JSON.stringify(msg));
  return true;
}

export function flushQueuedSends() {
  if (!canSendNow()) return;
  while (queuedMessages.length) {
    state.ws.send(JSON.stringify(queuedMessages.shift()));
  }
}
