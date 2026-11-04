import { X } from 'lucide-react';
import { create } from 'zustand';
import { cx } from './ui';

interface Toast { id: number; message: string; tone: 'ok' | 'bad' | 'neutral' }
interface ToastState { toasts: Toast[]; push: (message: string, tone?: Toast['tone']) => void; dismiss: (id: number) => void }

let seq = 0;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, tone = 'neutral') => {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-2), { id, message, tone }] });
    setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, tone?: Toast['tone']) => useToasts.getState().push(message, tone);

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-2 bottom-2 z-50 flex flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <div key={t.id} className={cx('pointer-events-auto flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 text-xs shadow-sm bg-bg',
          t.tone === 'ok' && 'border-ok/40', t.tone === 'bad' && 'border-bad/40 text-bad', t.tone === 'neutral' && 'border-border')}>
          <span className="min-w-0 flex-1">{t.message}</span>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-fg"><X className="size-3" /></button>
        </div>
      ))}
    </div>
  );
}
