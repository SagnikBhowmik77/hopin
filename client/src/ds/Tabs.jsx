import { useId, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Segmented tabs. `items`: [{ id, label, icon, disabled }]. Arrow keys move between tabs
 * (roving tabindex); the selected background slides between them.
 */
export function Tabs({ items, value, onChange, label, className = '', state }) {
  const group = useId();
  const reduced = useReducedMotion();
  const refs = useRef([]);
  const enabled = items.filter((t) => !t.disabled);
  const move = (dir) => {
    const i = enabled.findIndex((t) => t.id === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    onChange(next.id);
    refs.current[items.indexOf(next)]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={`ds-tabs ${className}`}>
      {items.map((t, i) => {
        const selected = t.id === value;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            ref={(el) => (refs.current[i] = el)}
            role="tab"
            type="button"
            id={`${group}-${t.id}`}
            aria-selected={selected}
            aria-controls={t.panel}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            data-state={selected ? state : undefined}
            className="ds-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(1);
              else if (e.key === 'ArrowLeft') move(-1);
              else return;
              e.preventDefault();
            }}
          >
            {selected && <motion.span layoutId={`${group}-ind`} className="ds-tab__indicator" transition={{ duration: reduced ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }} />}
            <span className="ds-tab__label">
              {Icon && <Icon aria-hidden className="size-4" />}
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** On/off control with a 44px hit area. */
export function Switch({ checked, onChange, label, disabled = false, className = '' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`ds-switch-hit ${className}`}>
      <span className="ds-switch" data-on={checked} aria-hidden />
    </button>
  );
}
