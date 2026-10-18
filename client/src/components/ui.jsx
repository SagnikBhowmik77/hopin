import { useState } from 'react';
import { CircleAlert, Inbox, Star } from 'lucide-react';
import { Avatar as DsAvatar, Badge, EmptyState, Modal as DsModal, Toaster as DsToaster, toast as dsToast } from '../ds/index.js';

/**
 * The app's original shared pieces, now drawn by the design system (src/ds). Names and props
 * are unchanged so every screen keeps working while it is redesigned.
 */

export const toast = dsToast;
export const Toaster = DsToaster;

export function Avatar({ src, name = '', size = 40, className = '' }) {
  return <DsAvatar src={src} name={name} size={size} className={className} />;
}

export function Stars({ value, size = 14 }) {
  return (
    <span className="inline-flex items-center gap-1 font-semibold tabular-nums" style={{ fontSize: size }}>
      <Star aria-hidden className="fill-current text-fg" style={{ width: size, height: size }} />
      {Number(value ?? 5).toFixed(1)}
    </span>
  );
}

export function StarInput({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const labels = ['Terrible', 'Bad', 'Okay', 'Good', 'Excellent'];
  const shown = hover || value;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex gap-1" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            onMouseEnter={() => setHover(n)}
            onClick={() => onChange(n)}
            className="grid size-12 place-items-center rounded-[var(--radius-md)] transition-transform duration-[var(--dur-fast)] active:scale-95"
          >
            <Star aria-hidden className={`size-9 ${n <= shown ? 'fill-[var(--accent)] text-[var(--accent-press)]' : 'text-line-strong'}`} strokeWidth={1.5} />
          </button>
        ))}
      </div>
      <span className="h-5 text-small font-semibold text-fg-2">{labels[shown - 1] ?? ''}</span>
    </div>
  );
}

/** Inline spinner, only inside buttons and small inline actions. Content loading uses Skeleton. */
export function Spinner({ className = '' }) {
  return <span className={`ds-spinner ${className}`} aria-hidden />;
}

const PILL = {
  requested: 'accent',
  accepted: 'accent',
  arrived: 'accent',
  scheduled: 'neutral',
  ongoing: 'success',
  completed: 'success',
  cancelled: 'danger',
  paid: 'success',
  due: 'danger',
  open: 'danger',
  in_progress: 'accent',
  resolved: 'success',
};
export function Pill({ tone, children }) {
  return <Badge tone={PILL[tone] ?? 'neutral'}>{children}</Badge>;
}

export function Modal({ open, onClose, title, children, wide = false }) {
  return (
    <DsModal open={open} onClose={onClose} title={title} wide={wide}>
      {children}
    </DsModal>
  );
}

/** Empty state with a lucide icon (defaults to an inbox). */
export function Empty({ icon, title, children }) {
  return (
    <EmptyState icon={icon ?? Inbox} title={title}>
      {children}
    </EmptyState>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-[var(--radius-md)] bg-danger-soft px-3 py-2.5 text-small font-medium text-danger">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Wraps an async click handler with a busy flag and error toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      dsToast(err.message, 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}
