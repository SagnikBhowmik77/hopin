import { useCallback, useEffect, useState } from 'react';
import { t as tr } from '../i18n/index.js';
import { BookmarkPlus, Briefcase, CalendarClock, House, MapPin, Zap } from 'lucide-react';
import { Button, Chip, Input, ListSkeleton } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { api, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { Empty, ErrorNote, Modal, Spinner, toast, useAction } from './ui.jsx';
import { VEHICLE_META, rupees, shortPlace } from '../util.js';

// --- saved places ----------------------------------------------------------------

const PLACE_ICON = { home: House, work: Briefcase, other: MapPin };

export function useSavedPlaces() {
  const [places, setPlaces] = useState(null);
  const load = useCallback(() => api('/places').then((d) => setPlaces(d.places)).catch(() => setPlaces([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return [places, load];
}

/** One-tap chips that fill the field being edited, plus "Save" for a chosen pickup/drop. */
export function SavedPlaceChips({ places, onPick, canSave, onSave }) {
  if (!places) return null;
  return (
    <div className="flex gap-2 overflow-x-auto">
      {places.map((p) => (
        <Chip key={p.id} icon={PLACE_ICON[p.kind] ?? MapPin} title={p.address} className="whitespace-nowrap" onClick={() => onPick(p)}>
          {['Home', 'Work'].includes(p.name) ? tr(p.name) : p.name}
        </Chip>
      ))}
      {canSave && (
        <Chip icon={BookmarkPlus} className="whitespace-nowrap" onClick={onSave}>
          {tr('Save place')}
        </Chip>
      )}
    </div>
  );
}

/** Saves the chosen pickup or drop as Home, Work or a named place. */
export function SavePlaceModal({ open, onClose, candidates, onSaved }) {
  const [which, setWhich] = useState(0);
  const [kind, setKind] = useState('home');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  useEffect(() => {
    if (open) {
      setWhich(0);
      setError('');
    }
  }, [open]);
  const place = candidates[which]?.place;
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/places', { kind, name: kind === 'other' ? name : undefined, lat: place.lat, lng: place.lng, address: place.address });
        toast(`Saved ${kind === 'other' ? name : kind === 'home' ? 'Home' : 'Work'}`, 'ok');
        onSaved();
        onClose();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <Modal open={open} onClose={onClose} title="Save a place">
      <form className="space-y-3" onSubmit={save}>
        {candidates.length > 1 && (
          <div className="flex gap-2" role="radiogroup" aria-label="Which place">
            {candidates.map((c, i) => (
              <Chip key={c.label} role="radio" aria-checked={which === i} selected={which === i} onClick={() => setWhich(i)}>
                {c.label}
              </Chip>
            ))}
          </div>
        )}
        <p className="flex items-start gap-2 rounded-[var(--radius-md)] bg-raised p-3 text-small">
          <MapPin aria-hidden className="mt-0.5 size-4 shrink-0" />
          {place?.address}
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Save as">
          {['home', 'work', 'other'].map((k) => (
            <Chip key={k} role="radio" aria-checked={kind === k} selected={kind === k} icon={PLACE_ICON[k]} onClick={() => setKind(k)}>
              {k === 'other' ? 'Other' : k === 'home' ? 'Home' : 'Work'}
            </Chip>
          ))}
        </div>
        {kind === 'other' && <Input label="Name" placeholder="Gym" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} required />}
        {kind !== 'other' && <p className="text-caption text-fg-2">This replaces your saved {kind === 'home' ? 'Home' : 'Work'} if you have one.</p>}
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!place}>
          Save
        </Button>
      </form>
    </Modal>
  );
}

/** Profile section: the user's saved places, with delete. */
export function SavedPlacesManager() {
  const [places, load] = useSavedPlaces();
  const [busy, run] = useAction();
  if (!places) return <ListSkeleton rows={2} label="Loading saved places" />;
  if (places.length === 0) return <Empty icon={MapPin} title="No saved places">Choose a pickup or drop on the Book page, then tap “Save a place”.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {places.map((p) => (
        <li key={p.id} className="flex items-center gap-3 py-2.5">
          {(() => {
            const Icon = PLACE_ICON[p.kind] ?? MapPin;
            return (
              <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-raised" aria-hidden>
                <Icon className="size-5" />
              </span>
            );
          })()}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{p.name}</p>
            <p className="truncate text-caption text-fg-2">{p.address}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Delete ${p.name}`}
            onClick={() =>
              run(async () => {
                await api(`/places/${p.id}`, { method: 'DELETE' });
                load();
              })
            }
          >
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

// --- scheduling ------------------------------------------------------------------

const MIN_AHEAD_MIN = 30;
const MAX_DAYS = 7;
/** A Date as the value a datetime-local input expects (local time, minutes). */
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** "Now" or a pickup time 30 minutes to 7 days ahead. Calls onChange with an ISO string or null. */
export function WhenPicker({ value, onChange }) {
  const [local, setLocal] = useState('');
  const min = localInput(new Date(Date.now() + (MIN_AHEAD_MIN + 1) * 60_000));
  const max = localInput(new Date(Date.now() + MAX_DAYS * 86_400_000));
  const scheduled = value !== null;
  return (
    <div className="space-y-2">
      <p className="text-small font-semibold">{tr('When')}</p>
      <div className="flex gap-2" role="radiogroup" aria-label="When">
        <Chip role="radio" aria-checked={!scheduled} selected={!scheduled} icon={Zap} onClick={() => onChange(null)}>
          {tr('Now')}
        </Chip>
        <Chip
          role="radio"
          aria-checked={scheduled}
          selected={scheduled}
          icon={CalendarClock}
          onClick={() => {
            const start = local || localInput(new Date(Date.now() + 60 * 60_000));
            setLocal(start);
            onChange(new Date(start).toISOString());
          }}
        >
          {tr('Schedule')}
        </Chip>
      </div>
      {scheduled && (
        <>
          <input
            type="datetime-local"
            className="input"
            aria-label="Pickup time"
            min={min}
            max={max}
            value={local}
            onChange={(e) => {
              setLocal(e.target.value);
              if (e.target.value) onChange(new Date(e.target.value).toISOString());
            }}
          />
          <p className="text-caption text-fg-2">
            From {MIN_AHEAD_MIN} minutes to {MAX_DAYS} days ahead. We start finding your driver 15 minutes before pickup. Scheduled fares are fixed now, with no surge.
          </p>
        </>
      )}
    </div>
  );
}

export const pickupTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** The rider's upcoming scheduled rides, with free cancellation. Refreshes on `reloadKey` and live updates. */
export function UpcomingRides({ reloadKey }) {
  const [rides, setRides] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/rides/scheduled').then((d) => setRides(d.rides)).catch(() => setRides([])), []);
  useEffect(() => {
    load();
  }, [load, reloadKey]);
  useSocketEvent(
    'ride:update',
    useCallback((r) => r.scheduledFor && load(), [load]),
  );
  if (!rides?.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-small font-semibold">{tr('Upcoming')}</p>
      {rides.map((r) => {
        const Icon = VEHICLE_ICON[r.vehicleType];
        return (
        <div key={r.id} className="flex items-center gap-3 rounded-[var(--radius-lg)] p-3 ring-1 ring-line">
          <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-raised" aria-hidden>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-small font-semibold">{pickupTime(r.scheduledFor)}</p>
            <p className="truncate text-caption text-fg-2">
              {shortPlace(r.pickup)} to {shortPlace(r.dropoff)} · {rupees(r.price.fare)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await post(`/rides/${r.id}/cancel`, { reason: 'Cancelled by rider before pickup' });
                toast('Scheduled ride cancelled. No charge.', 'ok');
                load();
              })
            }
          >
            {tr('Cancel')}
          </Button>
        </div>
        );
      })}
    </div>
  );
}
