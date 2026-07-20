export function randomUUID() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40;
  arr[8] = (arr[8] & 0x3f) | 0x80;
  const h = [...arr].map(b => b.toString(16).padStart(2, '0'));
  return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
}

export function binName(command) {
  const m = command.match(/^(['"])(.*?)\1/);
  const exec = m ? m[2] : command;
  return exec.split(/[\\/]/).pop().split(/\s/)[0].replace(/\.(exe|cmd)$/i, '');
}

export function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export function miniMarkdown(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 rounded bg-slate-700/60 text-slate-300 text-[11px]">$1</code>')
    .replace(/^[-•]\s+(.+)$/gm, '<li class="ml-3">$1</li>')
    .replace(/(<li.*<\/li>\n?)+/g, '<ul class="list-disc pl-2 space-y-0.5">$&</ul>')
    .replace(/\n/g, '<br>');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const TERMINAL_SVG = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

const ICON_VARIANTS = {
  '/img/claude-code.png': { all: '/img/claude-all.png' },
  '/img/codex.png': { dark: '/img/codex-dark.png', light: '/img/codex-light.png' },
  '/img/gemini.png': { all: '/img/gemini-all.png' },
  '/img/opencode.png': { all: '/img/opencode-all.png' },
  '/img/clideck-agent.svg': { dark: '/img/clideck-agent-dark.svg', light: '/img/clideck-agent-light.svg' },
};

export function resolveIconPath(icon) {
  if (!icon || !icon.startsWith('/')) return icon;
  const canonical = icon.replace(/-(light|dark|all)(?=\.[a-z]+$)/, '');
  const variants = ICON_VARIANTS[canonical];
  if (!variants) return icon;
  const isLight = document.documentElement.classList.contains('light');
  return (isLight ? variants.light : variants.dark) || variants.all || icon;
}

export function agentIcon(icon, px = 32) {
  const s = `width:${px}px;height:${px}px`;
  if (icon && icon.startsWith('/')) {
    return `<img src="${esc(resolveIconPath(icon))}" style="${s}" class="rounded object-cover flex-shrink-0" alt="">`;
  }
  if (icon === 'terminal') {
    return `<div style="${s}" class="rounded bg-slate-700 flex items-center justify-center text-slate-400 flex-shrink-0">${TERMINAL_SVG}</div>`;
  }
  return `<div style="${s}" class="rounded bg-slate-700 flex items-center justify-center text-lg flex-shrink-0">${icon || '?'}</div>`;
}
