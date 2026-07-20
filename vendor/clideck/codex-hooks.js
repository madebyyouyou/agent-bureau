const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } = require('fs');
const { dirname, join } = require('path');

const EVENTS = {
  UserPromptSubmit: 'start',
  Stop: 'stop',
};

function commandFor(nodePath, helperPath, port, route) {
  return `"${nodePath}" "${helperPath}" ${port} ${route}`;
}

function isClideckHook(hook) {
  return typeof hook?.command === 'string' && hook.command.includes('codex-hook.js');
}

function readHooksFile(path) {
  if (!existsSync(path)) return { hooks: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Codex hooks.json shape');
  }
  if (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) parsed.hooks = {};
  return parsed;
}

function stripClideckHooks(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map(group => {
      const hooks = (Array.isArray(group?.hooks) ? group.hooks : []).filter(hook => !isClideckHook(hook));
      return { ...group, hooks };
    })
    .filter(group => group.hooks.length);
}

function installCodexHooks(codexHome, nodePath, helperPath, port) {
  const hooksPath = join(codexHome, 'hooks.json');
  const doc = readHooksFile(hooksPath);

  for (const [event, route] of Object.entries(EVENTS)) {
    const groups = stripClideckHooks(doc.hooks[event]);
    groups.push({
      hooks: [{
        type: 'command',
        command: commandFor(nodePath, helperPath, port, route),
        timeout: 5,
      }],
    });
    doc.hooks[event] = groups;
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n');
}

function removeCodexHooks(codexHome) {
  const hooksPath = join(codexHome, 'hooks.json');
  if (!existsSync(hooksPath)) return;
  const doc = readHooksFile(hooksPath);

  for (const event of Object.keys(EVENTS)) {
    const groups = stripClideckHooks(doc.hooks[event]);
    if (groups.length) doc.hooks[event] = groups;
    else delete doc.hooks[event];
  }

  if (Object.keys(doc.hooks || {}).length) {
    writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n');
  } else {
    delete doc.hooks;
    if (Object.keys(doc).length) writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n');
    else unlinkSync(hooksPath);
  }
}

function codexHooksHealthy(codexHome, helperPath, port) {
  try {
    const doc = readHooksFile(join(codexHome, 'hooks.json'));
    for (const [event, route] of Object.entries(EVENTS)) {
      const groups = Array.isArray(doc.hooks?.[event]) ? doc.hooks[event] : [];
      const expected = commandFor(process.execPath.replace(/\\/g, '/'), helperPath, port, route);
      const found = groups.some(group => (group.hooks || []).some(hook => {
        if (!isClideckHook(hook)) return false;
        return hook.command === expected || (hook.command.includes(helperPath) && hook.command.includes(` ${port} ${route}`));
      }));
      if (!found) return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { installCodexHooks, removeCodexHooks, codexHooksHealthy };
