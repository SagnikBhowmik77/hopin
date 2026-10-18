import { forwardRef, useId } from 'react';
import { CircleAlert } from 'lucide-react';

/**
 * Text field with label, hint and error. The error is announced (role=alert) and linked to the
 * input (aria-describedby); `prefix` / `suffix` hold things like "+91", "₹" or an icon.
 */
export const Input = forwardRef(function Input(
  { label, hint, error, optional = false, prefix, suffix, multiline = false, disabled = false, state, className = '', id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const Control = multiline ? 'textarea' : 'input';
  return (
    <div className={`ds-field ${className}`}>
      {label && (
        <label className="ds-label" htmlFor={id}>
          {label} {optional && <span className="ds-label__optional">(optional)</span>}
        </label>
      )}
      <div className="ds-control" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined} data-state={state}>
        {prefix && <span className="ds-control__affix">{prefix}</span>}
        <Control
          ref={ref}
          id={id}
          className="ds-input"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
          {...rest}
        />
        {suffix && <span className="ds-control__affix ds-control__affix--end">{suffix}</span>}
      </div>
      {error ? (
        <p className="ds-error" id={errorId} role="alert">
          <CircleAlert aria-hidden />
          {error}
        </p>
      ) : (
        hint && (
          <p className="ds-hint" id={hintId}>
            {hint}
          </p>
        )
      )}
    </div>
  );
});
