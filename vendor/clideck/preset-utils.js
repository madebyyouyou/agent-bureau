const { binName } = require('./utils');

function presetForCommand(cmd, presets, options = {}) {
  const usePresetId = options.usePresetId !== false;
  if (usePresetId && cmd?.presetId) {
    const preset = presets.find(p => p.presetId === cmd.presetId);
    if (preset) return preset;
  }
  const bin = binName(cmd?.command);
  return presets.find(p => binName(p.command) === bin);
}

module.exports = { presetForCommand };
