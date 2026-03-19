import { esc } from '../utils/dom';

let toastWrap: HTMLDivElement;

const ensureToastWrap = () => {
  if (toastWrap) return;
  toastWrap = document.createElement('div');
  toastWrap.className = 'fixed top-4 right-4 flex flex-col gap-3 z-50';
  document.body.appendChild(toastWrap);
};

export const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'info'): void => {
  ensureToastWrap();

  const colors = {
    success: 'bg-emerald-600 border-emerald-500 shadow-emerald-900/10',
    error:   'bg-rose-600 border-rose-500 shadow-rose-900/10',
    info:    'bg-slate-800 border-slate-700 shadow-slate-900/10',
  };

  const icons = {
    success: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>`,
    error:   `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>`,
    info:    `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`,
  };

  const el = document.createElement('div');
  el.className = `toast-enter flex items-center gap-3 min-w-[280px] max-w-md px-4 py-3 rounded-2xl
                  text-white text-[13px] font-medium shadow-2xl border ${colors[kind]} backdrop-blur-md`;

  el.innerHTML = `
    <div class="shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
      ${icons[kind]}
    </div>
    <div class="flex-1 leading-tight">${esc(msg)}</div>
  `;

  toastWrap.appendChild(el);

  setTimeout(() => {
    el.classList.remove('toast-enter');
    el.classList.add('toast-leave');
    setTimeout(() => el.remove(), 300);
  }, 4000);
};
