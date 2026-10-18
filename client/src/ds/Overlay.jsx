import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { IconButton } from './Button.jsx';

const EASE = [0.16, 1, 0.3, 1];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Matches a CSS media query and updates when it changes. */
export function useMedia(query) {
  const subscribe = useCallback(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Height of an element, kept up to date. */
function useHeight(ref, active = true) {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return undefined;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return h;
}

// ---- Modal ------------------------------------------------------------------------------
/**
 * Dialog. Slides up from the bottom on phones (thumb reach), centred on wider screens.
 * Focus moves in, Tab stays inside, Esc / scrim / close button dismiss, focus returns after.
 */
export function Modal({ open, onClose, title, description, children, footer, wide = false }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const titleId = useId();
  const descId = useId();
  const phone = !useMedia('(min-width: 640px)');

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement;
    const t = setTimeout(() => {
      const first = ref.current?.querySelector('[data-autofocus]') ?? ref.current?.querySelector(FOCUSABLE);
      (first ?? ref.current)?.focus();
    }, 10);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open, onClose]);

  const from = reduced ? { opacity: 0 } : phone ? { y: 48, opacity: 1 } : { y: 8, scale: 0.98, opacity: 0 };
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 flex items-end justify-center sm:items-center sm:p-6" style={{ zIndex: 'var(--z-dialog)' }}>
          <motion.div className="ds-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={`ds-dialog ${wide ? 'ds-dialog--wide' : ''}`}
            initial={from}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={from}
            transition={{ duration: reduced ? 0 : 0.22, ease: EASE }}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id={titleId} className="font-display text-heading font-bold">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="mt-1 text-small text-fg-2">
                    {description}
                  </p>
                )}
              </div>
              <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2 -mt-2" />
            </div>
            {children}
            {footer && <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---- BottomSheet ------------------------------------------------------------------------
/**
 * Persistent sheet over a map (the booking flow). Drag the handle between snap heights;
 * heights <= 1 are fractions of the parent, larger numbers are pixels. The handle is also a
 * button: arrow keys and Enter change the height. `footer` (fare + main button) is pinned to
 * the bottom of the visible part at every height, so it is always within thumb reach.
 * On desktop (`panelFrom` and up) the sheet becomes a side panel. Parent must be `position: relative`.
 */
export function BottomSheet({ snaps = [0.24, 0.55, 0.9], snap: snapProp, onSnapChange, initialSnap = 1, header, footer, children, label = 'Trip details', panelFrom = '(min-width: 1024px)', className = '' }) {
  const desktop = useMedia(panelFrom);
  const reduced = useReducedMotion();
  const sheetRef = useRef(null);
  const footerRef = useRef(null);
  const headerRef = useRef(null);
  const [parentH, setParentH] = useState(0);
  const [inner, setInner] = useState(initialSnap);
  const snap = snapProp ?? inner;
  const y = useMotionValue(0);
  const drag = useDragControls();
  const footerH = useHeight(footerRef, !desktop && Boolean(footer));
  const headerH = useHeight(headerRef, !desktop && Boolean(header));

  const setSnap = useCallback(
    (i) => {
      const next = Math.max(0, Math.min(snaps.length - 1, i));
      if (snapProp == null) setInner(next);
      onSnapChange?.(next);
    },
    [snaps.length, snapProp, onSnapChange],
  );

  useLayoutEffect(() => {
    const parent = sheetRef.current?.parentElement;
    if (!parent) return undefined;
    const measure = () => setParentH(parent.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [desktop]);

  const heights = snaps.map((s) => (s <= 1 ? s * parentH : s));
  const maxH = Math.max(...heights, 0);
  const yFor = (i) => maxH - heights[i];

  useEffect(() => {
    if (desktop || !parentH) return undefined;
    const controls = animate(y, yFor(snap), { duration: reduced ? 0 : 0.24, ease: EASE });
    return () => controls.stop();
  }, [snap, parentH, desktop]); // eslint-disable-line react-hooks/exhaustive-deps

  if (desktop) {
    return (
      <aside ref={sheetRef} aria-label={label} className={`ds-panel ${className}`}>
        {header && <div className="ds-panel__header">{header}</div>}
        <div className="ds-panel__body">{children}</div>
        {footer && <div className="ds-panel__footer">{footer}</div>}
      </aside>
    );
  }

  const onDragEnd = (_e, info) => {
    const projected = y.get() + info.velocity.y * 0.12;
    let best = 0;
    heights.forEach((_, i) => {
      if (Math.abs(yFor(i) - projected) < Math.abs(yFor(best) - projected)) best = i;
    });
    if (best === snap) animate(y, yFor(best), { duration: reduced ? 0 : 0.2, ease: EASE });
    else setSnap(best);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowUp') setSnap(snap + 1);
    else if (e.key === 'ArrowDown') setSnap(snap - 1);
    else if (e.key === 'Enter' || e.key === ' ') setSnap(snap === snaps.length - 1 ? 0 : snap + 1);
    else return;
    e.preventDefault();
  };
  const visible = heights[snap] || 0;
  const HANDLE = 28;

  return (
    <motion.section
      ref={sheetRef}
      aria-label={label}
      className={`ds-sheet ${className}`}
      style={{ height: maxH || '50%', y, zIndex: 'var(--z-sheet)' }}
      drag="y"
      dragControls={drag}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: Math.max(0, maxH - Math.min(...heights)) }}
      dragElastic={0.06}
      dragMomentum={false}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="ds-sheet__handle" aria-label={`${label}: drag or use arrow keys to resize`} onPointerDown={(e) => drag.start(e)} onKeyDown={onKey} />
      {header && (
        <div ref={headerRef} className="px-5 pb-3">
          {header}
        </div>
      )}
      {/* Only the visible part scrolls, so nothing hides under the pinned footer. */}
      <div className="ds-sheet__body" style={{ maxHeight: visible ? Math.max(0, visible - HANDLE - headerH - footerH) : undefined }}>
        {children}
      </div>
      {footer && (
        <div ref={footerRef} className="ds-sheet__footer" style={{ top: visible ? visible - footerH : undefined }}>
          {footer}
        </div>
      )}
    </motion.section>
  );
}
