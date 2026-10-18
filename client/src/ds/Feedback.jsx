import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

// ---- Toast ------------------------------------------------------------------------------
// toast('Driver assigned', 'success' | 'error' | 'info') from anywhere; <Toaster /> shows them.

const listeners = new Set();
export function toast(message, tone = 'info') {
  const item = { id: Math.random().toString(36).slice(2), message, tone: tone === 'ok' ? 'success' : tone };
  listeners.forEach((fn) => fn(item));
}

const TOAST_ICON = { success: CircleCheck, error: CircleAlert, info: Info };

export function ToastView({ tone = 'info', message, onClose }) {
  const Icon = TOAST_ICON[tone] ?? Info;
  return (
    <div className={`ds-toast ds-toast--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden className={`ds-toast__icon--${tone}`} />
      <p className="flex-1">{message}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="-my-2 -mr-2 grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)] opacity-80 hover:opacity-100">
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = useState([]);
  const reduced = useReducedMotion();
  useEffect(() => {
    const add = (t) => {
      setItems((list) => [...list.slice(-2), t]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), t.tone === 'error' ? 6500 : 4500);
    };
    listeners.add(add);
    return () => listeners.delete(add);
  }, []);
  const dismiss = (id) => setItems((list) => list.filter((x) => x.id !== id));
  return (
    <div className="ds-toast-region" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout={!reduced}
            initial={reduced ? false : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <ToastView tone={t.tone} message={t.message} onClose={() => dismiss(t.id)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---- Skeleton ------------------------------------------------------------------------------
// Placeholders shaped like the content that is coming. Use these instead of spinners.

export function Skeleton({ width, height = 16, radius, className = '', style }) {
  return <span aria-hidden className={`ds-skeleton ${className}`} style={{ width, height, borderRadius: radius, ...style }} />;
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <span aria-hidden className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}

/** Wrap skeletons in this so screen readers hear "Loading" once instead of nothing. */
export function Loading({ label = 'Loading', children }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

// ---- Notice ---------------------------------------------------------------------------------

const NOTICE_TONE = {
  neutral: 'bg-raised text-fg',
  accent: 'bg-accent-soft text-fg',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** An inline note inside a screen: one lucide icon, then text. Tones as Badge. */
export function Notice({ icon: Icon, tone = 'neutral', title, children, action, className = '', ...rest }) {
  return (
    <div className={`flex items-start gap-3 rounded-[var(--radius-md)] px-3.5 py-3 text-small ${NOTICE_TONE[tone]} ${className}`} {...rest}>
      {Icon && <Icon aria-hidden className="mt-0.5 size-[18px] shrink-0" />}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children}
        {action && <div className="flex flex-wrap gap-2 pt-1.5">{action}</div>}
      </div>
    </div>
  );
}

// ---- Empty / error state ----------------------------------------------------------------

/** `icon` is a lucide icon; `art` can be an illustration instead. Tones: neutral, warning, danger. */
export function EmptyState({ icon: Icon, art, tone = 'neutral', title, children, action, className = '' }) {
  return (
    <div className={`ds-empty ${className}`}>
      {art ? <div className="mb-2">{art}</div> : Icon && <div className={`ds-empty__art ${tone !== 'neutral' ? `ds-empty__art--${tone}` : ''}`}>{<Icon aria-hidden />}</div>}
      <h3 className="ds-empty__title">{title}</h3>
      {children && <div className="ds-empty__body">{children}</div>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
