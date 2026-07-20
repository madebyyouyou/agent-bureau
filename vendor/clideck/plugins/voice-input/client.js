let settings = { enabled: false, backend: 'openai', hotkey: 'F4' };
let recordingState = null; // { startTime, mediaRecorder, stream, cancelled, sessionId }
let transcribing = false;
let activeToast = null;
let micControl = null;
let _api = null;
const MIC_ICON = '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';

function toast(message, type, persistent) {
  if (activeToast) activeToast.dismiss();
  activeToast = _api.toast(message, { type, duration: persistent ? 0 : 2000, id: 'voice-input' });
  return activeToast;
}

// --- Audio: decode to 16kHz mono Float32 PCM (no ffmpeg needed) ---

async function decodeToPcm16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);
  const numSamples = Math.round(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, numSamples, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const resampled = await offline.startRendering();
  ctx.close();
  return resampled.getChannelData(0); // Float32Array, 16kHz mono
}

function float32ToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

// --- Button state ---

function updateButton() {
  if (!micControl) return;
  const hotkey = settings.hotkey || 'F4';
  micControl.setVisible(!!settings.enabled);
  micControl.setActive(!!recordingState);
  micControl.setBusy(!!transcribing);
  micControl.setTitle(recordingState
    ? `Stop recording (${hotkey})`
    : transcribing ? 'Transcribing...'
      : `Voice Input (${hotkey})`);
}

// --- Recording ---

async function startRecording() {
  if (!_api || recordingState || transcribing) return;
  if (!settings.enabled) { toast('Voice Input is disabled', 'error'); return; }
  const sessionId = _api.getActiveSessionId();
  if (!sessionId) { toast('No active terminal', 'error'); return; }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

    const chunks = [];
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const state = recordingState;
      recordingState = null;
      updateButton();
      if (activeToast) activeToast.dismiss();

      if (!state || state.cancelled) {
        toast('CANCELLED', 'error');
        return;
      }

      const duration = (Date.now() - state.startTime) / 1000;
      if (duration < 0.4) {
        toast('Too short', 'error');
        return;
      }

      transcribing = true;
      updateButton();
      toast('Transcribing...', 'info', true);

      try {
        const blob = new Blob(chunks, { type: mr.mimeType });
        const pcm = await decodeToPcm16k(blob);
        const b64 = float32ToBase64(pcm);
        _api.send('transcribe', { audio: b64, sessionId: state.sessionId });
      } catch (e) {
        transcribing = false;
        updateButton();
        toast('Audio decode failed', 'error');
      }
    };

    mr.start(100);
    recordingState = { startTime: Date.now(), mediaRecorder: mr, stream, cancelled: false, sessionId };
    updateButton();
  } catch (e) {
    toast('Mic: ' + e.message, 'error');
  }
}

function stopRecording() {
  if (recordingState) recordingState.mediaRecorder.stop();
}

function cancelRecording() {
  if (!recordingState) return;
  recordingState.cancelled = true;
  recordingState.mediaRecorder.stop();
}

// --- Hotkey ---

let currentHotkey = null;

function bindHotkey() {
  const code = settings.hotkey || 'F4';
  if (code === currentHotkey) return;
  const cb = () => {
    if (!settings.enabled) return;
    if (!recordingState) startRecording();
    else stopRecording();
  };
  const prev = currentHotkey;
  if (prev) _api.unregisterHotkey(prev);
  if (_api.registerHotkey(code, cb)) {
    currentHotkey = code;
  } else if (prev) {
    _api.registerHotkey(prev, cb);
    toast(`Hotkey "${code}" is taken, keeping "${prev}"`, 'warn');
  } else {
    toast(`Hotkey "${code}" is unavailable`, 'warn');
  }
}

// Escape to cancel recording — handled separately since it's conditional
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recordingState) {
    e.preventDefault();
    e.stopPropagation();
    cancelRecording();
  }
}, true);

// --- Init ---

export function init(api) {
  _api = api;

  api.onMessage('settings', msg => {
    settings = { ...settings, ...msg };
    updateButton();
    bindHotkey();
  });

  api.onMessage('status', msg => {
    if (msg.setup) toast(msg.setup, 'info', true);
    else if (msg.workerReady) toast('Voice Input ready', 'success');
  });

  api.onMessage('result', msg => {
    transcribing = false;
    updateButton();
    if (activeToast) { activeToast.dismiss(); activeToast = null; }
    if (msg.skipped || !msg.text) return;
    const sid = msg.sessionId || _api.getActiveSessionId();
    if (!sid) return;
    api.writeToSession(sid, msg.text + ' ');
    document.querySelector('.term-wrap.active textarea')?.focus();
  });

  api.onMessage('error', msg => {
    transcribing = false;
    updateButton();
    toast(msg.error || 'Error', 'error');
  });

  api.send('getSettings');

  micControl = api.addTerminalInputButton({
    id: 'voice-input',
    title: 'Voice Input (F4)',
    icon: MIC_ICON,
    onClick() {
      if (!recordingState) startRecording();
      else stopRecording();
    },
  });
  updateButton();
  bindHotkey();
}
