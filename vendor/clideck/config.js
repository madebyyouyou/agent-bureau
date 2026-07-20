const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const os = require('os');
const { DATA_DIR } = require('./paths');
const { defaultShell } = require('./utils');
const { presetForCommand } = require('./preset-utils');

const CONFIG_PATH = join(DATA_DIR, 'config.json');

const STARTER_PROMPTS = [
  {
    id: 'starter-prompt-update-documentation',
    name: 'Update documentation',
    text: 'Our docs needs to be updated based on the latest diff changes. Please review the latest changes and udpate the docs accordingly. List the changes you did in concise points in your response. Thanks.',
  },
  {
    id: 'starter-prompt-investigate-codebase',
    name: 'Investigate codebase',
    text: `Learn the codebase and investigate it for:
- Critical issues
- Serious logical issues
- Things you dont understand why they are there
- Redundent code
- Ugly workarounds / plasters / band-aids

list your fidings please.`,
  },
  {
    id: 'starter-prompt-reviewer-findings',
    name: 'Reviewer findings',
    text: 'Here are the reviewer findings, if you find that any are valid and relevant, please fix with pure solutions, simple approaches, never apply workarounds / plasters.\nWhen finish, list what you fix and how:',
  },
];

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
      env: {},
    },
  ],
  confirmClose: true,
  notifyIdle: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  notifyMinWork: 0,
  askDispatchSoundEnabled: true,
  askDispatchSound: 'agent-dispatch-ambient',
  defaultTheme: 'catppuccin-mocha',
  defaultShell,
  prompts: [],
  projects: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;
function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
const EXPOSED_PRESETS = PRESETS.filter(isPresetEnabled);

function matchPreset(cmd) { return presetForCommand(cmd, PRESETS, { usePresetId: false }); }

function firstCommandToken(command) {
  const raw = String(command || '').trim();
  const m = raw.match(/^(['"])(.*?)\1|^(\S+)/);
  return m ? (m[2] || m[3] || '') : '';
}

function commandPathMissing(command) {
  const token = firstCommandToken(command);
  return !token || (token.startsWith('/') && !existsSync(token));
}

function isShellCommand(cmd, preset) {
  return preset?.presetId === 'shell'
    || cmd.presetId === 'shell'
    || (!cmd.isAgent && !cmd.presetId && String(cmd.label || '').toLowerCase() === 'shell');
}

function migrate(cfg) {
  // Migrate profiles → defaultTheme
  if (cfg.profiles && !cfg.defaultTheme) {
    const defProfile = cfg.profiles.find(p => p.id === cfg.defaultProfile) || cfg.profiles[0];
    cfg.defaultTheme = defProfile?.themeId || 'default';
  }
  delete cfg.profiles;
  delete cfg.defaultProfile;
  if (!cfg.defaultTheme || cfg.defaultTheme === 'solarized-dark') cfg.defaultTheme = 'catppuccin-mocha';
  // Backfill and sync fields from presets
  for (const cmd of cfg.commands) {
    let preset = cmd.presetId ? PRESETS.find(p => p.presetId === cmd.presetId) : matchPreset(cmd);
    if (isShellCommand(cmd, preset)) {
      preset = PRESETS.find(p => p.presetId === 'shell') || preset;
      cmd.presetId = 'shell';
      cmd.label = cmd.label || 'Shell';
    }
    if (preset?.presetId === 'shell' && commandPathMissing(cmd.command)) {
      cmd.command = defaultShell;
    }
    // Stamp presetId for reliable lookup
    if (preset && !cmd.presetId) cmd.presetId = preset.presetId;
    // Icon always syncs from preset — the preset is the source of truth for logos
    if (preset) cmd.icon = preset.icon;
    else if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    if (!cmd.env || typeof cmd.env !== 'object' || Array.isArray(cmd.env)) cmd.env = {};
    // Claude Code telemetry is built-in, always on
    if (preset?.telemetryEnabled === true) cmd.telemetryEnabled = true;
    else if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
    // Codex: keep shipped default commands aligned with the current preset.
    // Only rewrite the known default strings so custom Codex commands stay intact.
    if (preset?.presetId === 'codex') {
      if (cmd.command === 'codex' || cmd.command === 'codex --no-alt-screen') cmd.command = preset.command;
      if (cmd.resumeCommand === 'codex resume {{sessionId}}' || cmd.resumeCommand === 'codex resume {{sessionId}} --no-alt-screen') {
        cmd.resumeCommand = preset.resumeCommand;
      }
    }
  }
  // Auto-add any shipped presets not yet in the commands list
  for (const preset of EXPOSED_PRESETS) {
    const exists = cfg.commands.some(c => c.presetId === preset.presetId || matchPreset(c)?.presetId === preset.presetId);
    if (!exists) {
      cfg.commands.push({
        id: crypto.randomUUID(), presetId: preset.presetId, label: preset.name, icon: preset.icon,
        command: preset.command, enabled: true, defaultPath: '',
        isAgent: preset.isAgent, canResume: preset.canResume,
        resumeCommand: preset.resumeCommand, sessionIdPattern: preset.sessionIdPattern,
        outputMarker: preset.outputMarker || null,
        env: {},
      });
    }
  }
  if (!cfg.projects) cfg.projects = [];
  return cfg;
}

function load() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      ...deepCopy(DEFAULTS),
      prompts: deepCopy(STARTER_PROMPTS),
    };
  }
  try {
    return migrate({ ...deepCopy(DEFAULTS), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) });
  } catch { return deepCopy(DEFAULTS); }
}

function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { load, save };
