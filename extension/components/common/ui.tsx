/** Small accessible UI primitives (native elements + Tailwind). */
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, Loader2, Lock, MinusCircle, XCircle } from 'lucide-react';
import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { DiagStatus } from '@/types/api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }>(
  ({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none shrink-0',
        size === 'sm' && 'h-7 px-2 text-xs',
        size === 'md' && 'h-8 px-3 text-[0.9rem]',
        size === 'icon' && 'h-7 w-7',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-bg hover:bg-subtle',
        variant === 'ghost' && 'text-muted hover:bg-subtle hover:text-fg',
        variant === 'danger' && 'border border-bad/40 text-bad hover:bg-bad/10',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cx('h-8 w-full rounded-md border border-border bg-bg px-2 text-[0.9rem] placeholder:text-muted', className)} {...rest} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cx('w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[0.9rem] placeholder:text-muted', className)} {...rest} />
));
Textarea.displayName = 'Textarea';

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('h-8 w-full rounded-md border border-border bg-bg px-1.5 text-[0.9rem]', className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[0.9rem]">{label}</label>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-border')}
      >
        <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-border bg-card', className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="flex-1 text-[0.9rem] font-semibold">{title}</h3>
        {actions}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7rem] font-medium leading-none',
        tone === 'neutral' && 'bg-subtle text-muted',
        tone === 'ok' && 'bg-ok/12 text-ok',
        tone === 'warn' && 'bg-warn/12 text-warn',
        tone === 'bad' && 'bg-bad/12 text-bad',
        tone === 'accent' && 'bg-accent/12 text-accent',
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS: Record<DiagStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'; Icon: typeof CheckCircle2 }> = {
  healthy: { label: 'Healthy', tone: 'ok', Icon: CheckCircle2 },
  warning: { label: 'Warning', tone: 'warn', Icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'bad', Icon: XCircle },
  not_configured: { label: 'Not configured', tone: 'warn', Icon: CircleDashed },
  permission_required: { label: 'Permission required', tone: 'warn', Icon: Lock },
  not_verifiable: { label: 'Not directly verifiable', tone: 'neutral', Icon: HelpCircle },
  skipped: { label: 'Skipped', tone: 'neutral', Icon: MinusCircle },
  testing: { label: 'Testing', tone: 'accent', Icon: Loader2 },
};

export function StatusBadge({ status }: { status: DiagStatus }) {
  const s = STATUS[status] ?? STATUS.skipped;
  return (
    <Badge tone={s.tone}>
      <s.Icon className={cx('size-3', status === 'testing' && 'animate-spin')} aria-hidden />
      {s.label}
    </Badge>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
      {icon}
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="text-xs">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: { message: string; hint?: string | null } | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-bad/30 bg-bad/8 px-2.5 py-2 text-xs text-bad">
      <p className="font-medium">{error.message}</p>
      {error.hint && <p className="mt-0.5 text-fg/80">{error.hint}</p>}
      {onRetry && <button className="mt-1 underline" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** Modal confirmation using the native <dialog> (focus trap + Esc for free). */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onCancel(); }} className="m-auto w-[min(92vw,380px)] rounded-lg border border-border bg-bg p-0 text-fg backdrop:bg-black/40">
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">{title}</h2>
        <div className="text-[0.9rem] text-muted">{children}</div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>{confirmLabel}</Button>
        </div>
      </div>
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-md border border-border p-0.5">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cx('rounded px-2 py-0.5 text-xs', value === it.id ? 'bg-subtle font-medium text-fg' : 'text-muted hover:text-fg')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
