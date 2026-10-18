import { forwardRef } from 'react';
import { CarTaxiFront, Motorbike } from 'lucide-react';

/**
 * Hopin's vehicle icons. Bike and Cab come from lucide; lucide has no auto-rickshaw, so this one
 * is drawn on lucide's own grid (24px, 2px round strokes) to sit in the same set.
 */
export const AutoRickshaw = forwardRef(function AutoRickshaw({ size = 24, strokeWidth = 2, className = '', ...rest }, ref) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`lucide ${className}`}
      {...rest}
    >
      <path d="M4 15V8.5A3.5 3.5 0 0 1 7.5 5h7l4.5 5.5V15" />
      <path d="M14.5 5v5.5H19" />
      <path d="M2.5 15h19" />
      <circle cx="6.5" cy="17.5" r="2" />
      <circle cx="18" cy="17.5" r="2" />
      <path d="M8.5 17.5h7.5" />
    </svg>
  );
});

export const VEHICLE_ICON = { bike: Motorbike, auto: AutoRickshaw, car: CarTaxiFront };
