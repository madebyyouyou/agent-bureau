const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_RE, '');
}

module.exports = { ANSI_RE, stripAnsi };
