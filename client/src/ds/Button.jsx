import { forwardRef } from 'react';

/**
 * Button. Variants: primary (the one taxi-yellow action per screen), secondary (solid ink),
 * outline, ghost, danger. Sizes: sm 44px, md 48px, lg 56px (all at least 44px to touch).
 * `loading` keeps the width, shows a spinner and blocks double taps. `state` forces a visual
 * state for the design preview only.
 */
export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', block = false, loading = false, disabled = false, icon: Icon, iconRight: IconRight, as: As = 'button', state, className = '', children, type, ...rest },
  ref,
) {
  const isButton = As === 'button';
  const classes = ['ds-btn', `ds-btn--${variant}`, size !== 'md' && `ds-btn--${size}`, block && 'ds-btn--block', className].filter(Boolean).join(' ');
  return (
    <As
      ref={ref}
      className={classes}
      data-state={state}
      aria-busy={loading || undefined}
      {...(isButton ? { type: type ?? 'button', disabled: disabled || loading } : { 'aria-disabled': disabled || loading || undefined })}
      {...rest}
    >
      {loading ? <span className="ds-spinner" aria-hidden /> : Icon ? <Icon aria-hidden /> : null}
      {children != null && <span className="ds-btn__label">{children}</span>}
      {IconRight && !loading ? <IconRight aria-hidden /> : null}
    </As>
  );
});

/** Square icon-only button. `label` is required: it becomes the accessible name and tooltip. */
export const IconButton = forwardRef(function IconButton({ icon: Icon, label, variant = 'ghost', size = 'md', className = '', state, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      data-state={state}
      className={['ds-btn', 'ds-iconbtn', `ds-btn--${variant}`, size === 'lg' && 'ds-btn--lg', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon aria-hidden />
    </button>
  );
});
