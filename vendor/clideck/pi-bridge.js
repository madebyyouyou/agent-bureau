// Pi bridge — receives lifecycle events from the CliDeck Pi extension.

let broadcastFn = null;
let sessionsFn = null;

function init(broadcast, getSessions) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
}

function findByToken(token) {
  if (!token) return null;
  for (const [id, session] of sessionsFn?.() || []) {
    if (session.sessionToken === token) return id;
  }
  return null;
}

function capture(id) {
  setTimeout(() => broadcastFn?.({ type: 'terminal.capture', id }), 500);
}

function handleEvent(payload) {
  if (!payload || !payload.event) return;
  const sessions = sessionsFn?.();
  if (!sessions) return;

  const clideckId = payload.clideck_id && sessions.has(payload.clideck_id)
    ? payload.clideck_id
    : findByToken(payload.session_id);
  if (!clideckId) return;

  const session = sessions.get(clideckId);
  if (session && payload.session_id && payload.event !== 'session_shutdown') {
    session.sessionToken = payload.session_id;
  }

  if (payload.event === 'agent_start') {
    broadcastFn?.({ type: 'session.status', id: clideckId, working: true, source: 'hook' });
    return;
  }

  if (payload.event === 'agent_end' || payload.event === 'session_start' || payload.event === 'session_shutdown') {
    broadcastFn?.({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
    capture(clideckId);
  }
}

function clear() {}

module.exports = { init, handleEvent, clear };
