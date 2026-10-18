import { forwardRef } from 'react';

/** Surface for grouped content. No shadow at rest; `interactive` adds hover/focus/selected states. */
export const Card = forwardRef(function Card({ as: As = 'div', interactive = false, flat = false, state, className = '', ...rest }, ref) {
  const classes = ['ds-card', flat && 'ds-card--flat', interactive && 'ds-card--interactive', className].filter(Boolean).join(' ');
  return <As ref={ref} className={classes} data-state={state} {...(interactive && As === 'button' ? { type: 'button' } : {})} {...rest} />;
});

/** Status label. Tones: neutral, accent, success, warning, danger. Square-cornered, not a pill. */
export function Badge({ tone = 'neutral', icon: Icon, className = '', children }) {
  return (
    <span className={`ds-badge ${tone !== 'neutral' ? `ds-badge--${tone}` : ''} ${className}`}>
      {Icon && <Icon aria-hidden />}
      {children}
    </span>
  );
}

/** Selectable choice (filters, quick replies, tip amounts). 44px tall. */
export function Chip({ selected = false, icon: Icon, state, className = '', children, ...rest }) {
  return (
    <button type="button" className={`ds-chip ${className}`} aria-pressed={selected} data-state={state} {...rest}>
      {Icon && <Icon aria-hidden />}
      {children}
    </button>
  );
}

const initialsOf = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

/** Person or driver picture; falls back to initials on the accent tint. Squircle shape. */
export function Avatar({ src, name = '', size = 44, className = '' }) {
  return (
    <span className={`ds-avatar ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden={!src}>
      {src ? <img src={src} alt={name} loading="lazy" decoding="async" /> : initialsOf(name)}
    </span>
  );
}
