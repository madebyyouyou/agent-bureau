function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function sameProject(a, b) {
  return (a.projectId || null) === (b.projectId || null);
}

function projectName(projects, projectId) {
  if (!projectId) return 'No project';
  return projects.find(p => p.id === projectId)?.name || projectId;
}

module.exports = { sendJson, isLoopback, sameProject, projectName };
