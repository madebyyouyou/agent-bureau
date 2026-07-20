const overlay = document.getElementById('confirm-close');
const messageEl = document.getElementById('cc-message');
const confirmBtn = document.getElementById('cc-confirm');
const cancelBtn = document.getElementById('cc-cancel');
let pendingResolve = null;

const DEFAULT_MSG = 'Close this session? The terminal process will be killed.';

export function confirmClose(message, confirmLabel) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    messageEl.textContent = message || DEFAULT_MSG;
    confirmBtn.textContent = confirmLabel || 'Delete';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  });
}

function close(result) {
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  if (pendingResolve) { pendingResolve(result); pendingResolve = null; }
}

confirmBtn.addEventListener('click', () => close(true));
cancelBtn.addEventListener('click', () => close(false));
overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
