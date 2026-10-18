import { useEffect, useId, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '../api.js';

const DOT = { pickup: 'rounded-full bg-success', stop: 'rounded-full bg-accent ring-2 ring-fg/70', drop: 'rounded-[3px] bg-fg' };

/**
 * Address box with search-as-you-type. `value` is a place ({address, lat, lng})
 * or null; typing clears it until a suggestion is picked.
 */
export default function PlaceInput({ kind, label, value, onChange, near, active, onFocus, trailing }) {
  const [text, setText] = useState(value?.address ?? '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const nearRef = useRef(near);
  nearRef.current = near;

  // Picking on the map or "use my location" changes the value from outside.
  useEffect(() => setText(value?.address ?? ''), [value?.address]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 3 || q === value?.address) return setResults([]);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const n = nearRef.current;
        const qs = new URLSearchParams({ q, ...(n ? { lat: n.lat, lng: n.lng } : {}) });
        const { results } = await api(`/geo/search?${qs}`, { signal: ctrl.signal });
        setResults(results);
        setHighlight(0);
      } catch (err) {
        if (err.name !== 'AbortError') setResults([]);
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, open, value?.address]);

  const choose = (r) => {
    onChange({ address: r.label, lat: r.lat, lng: r.lng });
    setText(r.label);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') setHighlight((h) => (h + 1) % results.length);
    else if (e.key === 'ArrowUp') setHighlight((h) => (h - 1 + results.length) % results.length);
    else if (e.key === 'Enter') choose(results[highlight]);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative">
      <div
        className={`flex min-h-12 items-center gap-3 rounded-[var(--radius-md)] pl-3.5 pr-1 transition-colors duration-[var(--dur-fast)] ${
          active ? 'bg-surface ring-2 ring-fg' : ''
        }`}
      >
        <span className={`size-2.5 shrink-0 ${DOT[kind]}`} aria-hidden />
        <input
          className="min-w-0 flex-1 bg-transparent py-3 text-body outline-none placeholder:text-fg-2 focus-visible:outline-none"
          aria-label={label}
          placeholder={label}
          value={text}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={(e) => {
            setOpen(true);
            onFocus?.();
            e.target.select();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
          onKeyDown={onKeyDown}
        />
        {busy && <span className="ds-spinner mr-2 shrink-0" aria-hidden />}
        {trailing}
      </div>
      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 mt-1.5 overflow-hidden rounded-[var(--radius-md)] bg-surface py-1"
          style={{ zIndex: 1200, boxShadow: 'var(--shadow-dialog)' }}
        >
          {results.map((r, i) => {
            const [head, ...rest] = r.label.split(', ');
            return (
              <li
                key={`${r.lat},${r.lng},${i}`}
                role="option"
                aria-selected={i === highlight}
                className={`flex min-h-12 cursor-pointer items-center gap-3 px-3.5 py-2 ${i === highlight ? 'bg-raised' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
              >
                <MapPin aria-hidden className="size-[18px] shrink-0 text-fg-2" />
                <span className="min-w-0">
                  <span className="block truncate text-small font-semibold">{head}</span>
                  <span className="block truncate text-caption text-fg-2">{rest.join(', ')}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
