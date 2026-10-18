import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CircleMarker, Popup } from 'react-leaflet';
import { Loader, LocateFixed, LocateOff, Waves } from 'lucide-react';
import { Button, Input, ListSkeleton, Notice, Section } from '../ds/index.js';
import { api, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { Empty, Modal, Pill, Spinner, toast, useAction } from './ui.jsx';
import { ago, when } from '../util.js';

/**
 * Monsoon waterlogging (step 8b batch G): crowd reports from riders' and drivers' GPS, shown on
 * the map. Spots on a route add expected minutes to the ETA; the fare never changes.
 */

const SEVERITIES = [
  ['ankle', 'Ankle deep', 'Slow but passable'],
  ['knee', 'Knee deep', 'Bikes and autos struggle'],
  ['impassable', 'Not passable', 'Vehicles should go around'],
];
const COLOR = { ankle: '#38bdf8', knee: '#2563eb', impassable: '#1e1b4b' };
const REFRESH_MS = 60_000;

// One shared list for the map markers and the report button, refreshed while anything shows it.
let spots = [];
let timer = null;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
export function reloadSpots() {
  return api('/waterlogging')
    .then((d) => {
      spots = d.spots;
      emit();
    })
    .catch(() => {});
}
function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    reloadSpots();
    timer = setInterval(reloadSpots, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearInterval(timer);
  };
}
export const useSpots = () => useSyncExternalStore(subscribe, () => spots);

/** A fresh, precise GPS fix (reports must come from where the person actually is). */
function gpsFix() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share your location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? 'Allow location access for this site to report waterlogging.' : 'Could not get your location. Try again outdoors.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

function SpotPopup({ spot }) {
  const [busy, run] = useAction();
  const send = (vote) =>
    run(async () => {
      const fix = await gpsFix();
      const { spot: s } = await post(`/waterlogging/${spot.id}/vote`, { ...fix, vote, severity: vote === 'still' ? spot.severity : undefined });
      toast(s.status === 'cleared' ? 'Marked as cleared. Thanks!' : vote === 'cleared' ? 'Noted. It clears when one more person agrees.' : 'Thanks, confirmed.', 'ok');
      reloadSpots();
    });
  return (
    <div className="min-w-48 space-y-1 text-small">
      <p className="flex items-center gap-1.5 font-bold">
        <Waves aria-hidden className="size-4" /> {spot.label}
      </p>
      {spot.note && <p>“{spot.note}”</p>}
      <p className="text-caption text-fg-2">
        Reported {ago(spot.reportedAt)} · confirmed by {spot.confirmations} {spot.confirmations === 1 ? 'person' : 'people'} · ends {when(spot.expiresAt)} unless confirmed
      </p>
      <div className="flex gap-1.5 pt-1">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => send('still')}>
          Still flooded
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send('cleared')}>
          Cleared
        </Button>
      </div>
    </div>
  );
}

/** Rendered inside MapView's MapContainer. */
export function WaterlogMarkers() {
  const list = useSpots();
  return list.map((s) => (
    <CircleMarker
      key={s.id}
      center={[s.lat, s.lng]}
      radius={s.severity === 'impassable' ? 11 : 9}
      pathOptions={{ color: '#fff', weight: 2, fillColor: COLOR[s.severity], fillOpacity: 0.9 }}
    >
      <Popup>
        <SpotPopup spot={s} />
      </Popup>
    </CircleMarker>
  ));
}

/** Floating map button + form: report waterlogging where you are standing. */
export function ReportWaterlogButton({ className = '' }) {
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState(null);
  const [fixError, setFixError] = useState('');
  const [severity, setSeverity] = useState('');
  const [note, setNote] = useState('');
  const [busy, run] = useAction();

  const locate = useCallback(() => {
    setFix(null);
    setFixError('');
    gpsFix().then(setFix, (e) => setFixError(e.message));
  }, []);
  useEffect(() => {
    if (open) locate();
  }, [open, locate]);

  const submit = () =>
    run(async () => {
      const res = await post('/waterlogging', { ...fix, severity, note: note.trim() || undefined });
      toast(res.merged ? 'Someone already reported this spot. Your report confirmed it.' : 'Thanks! Others on the road will see it for 6 hours unless confirmed.', 'ok');
      setOpen(false);
      setSeverity('');
      setNote('');
      reloadSpots();
    });
  const vague = fix && fix.accuracy > 200;

  return (
    <>
      <button type="button" className={`ds-btn ds-btn--float ds-btn--sm ${className}`} onClick={() => setOpen(true)} aria-label="Report waterlogging" title="Report waterlogging">
        <Waves aria-hidden />
        <span className="ds-btn__label hidden sm:inline">Report waterlogging</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Report waterlogging here">
        <div className="space-y-4 text-small">
          <p className="text-fg-2">Report only where you are now. Your phone’s location is used, so stand at the flooded spot.</p>
          <Notice
            icon={fixError || vague ? LocateOff : fix ? LocateFixed : Loader}
            tone={fixError || vague ? 'danger' : fix ? 'success' : 'neutral'}
            action={
              (fixError || vague) && (
                <Button size="sm" variant="outline" onClick={locate}>
                  Try again
                </Button>
              )
            }
          >
            <p>
              {fix ? (
                <>
                  Location found, accurate to about {fix.accuracy} m.{vague && <strong> Too vague to report (needs 200 m or better).</strong>}
                </>
              ) : (
                fixError || 'Finding your location…'
              )}
            </p>
          </Notice>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">How deep is it?</legend>
            {SEVERITIES.map(([value, label, hint]) => (
              <label
                key={value}
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] p-3 ring-1 transition-colors duration-[var(--dur-fast)] ${severity === value ? 'bg-accent-soft ring-2 ring-fg' : 'ring-line hover:bg-raised'}`}
              >
                <input type="radio" className="size-5 accent-[var(--fg)]" name="waterlog-severity" value={value} checked={severity === value} onChange={() => setSeverity(value)} />
                <span>
                  <span className="block font-semibold">{label}</span>
                  <span className="block text-caption text-fg-2">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Input label="Landmark" optional maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Under the flyover, near the petrol pump" />
          <Button variant="primary" size="lg" block loading={busy} disabled={!fix || vague || !severity} onClick={submit}>
            Report
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** Under the quote: reported spots on this route and what they add to the trip time. */
export function WaterlogRouteNotice({ waterlog }) {
  if (!waterlog?.spots?.length) return null;
  const n = waterlog.spots.length;
  return (
    <Notice icon={Waves} tone={waterlog.impassable ? 'warning' : 'neutral'} title={n === 1 ? '1 waterlogged spot on this route' : `${n} waterlogged spots on this route`}>
      <p>
        Trip times include about {waterlog.delayMin} extra min. The fare is not affected.
        {waterlog.impassable && ' One is reported as not passable; your driver may take another way.'}
      </p>
    </Notice>
  );
}

/** Admin: recent reports, with a way to take down false ones. */
export function AdminWaterlog() {
  const [list, setList] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(
    () =>
      api('/admin/waterlogging')
        .then((d) => setList(d.spots))
        .catch(() => setList([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const remove = (id) =>
    run(async () => {
      if (!window.confirm('Take this spot off the map?')) return;
      await api(`/admin/waterlogging/${id}`, { method: 'DELETE' });
      load();
      reloadSpots();
    });
  const active = list?.filter((s) => s.status === 'active') ?? [];

  return (
    <Section
      title="Waterlogging reports"
      icon={Waves}
      description="Reported by riders and drivers from their GPS in the last 3 days. Remove spots that are false."
      action={active.length > 0 && <Pill tone="open">{active.length} on the map</Pill>}
    >
      {!list ? (
        <ListSkeleton rows={2} label="Loading reports" />
      ) : list.length === 0 ? (
        <Empty icon={Waves} title="No waterlogging reported" />
      ) : (
        <ul className="divide-y divide-line text-small">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{s.label}</span> · {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                {s.note && ` · “${s.note}”`}
                <span className="block text-caption text-fg-2">
                  {when(s.reportedAt)} · {s.confirmations} confirmed · {s.clearedVotes} said cleared · {s.status}
                </span>
              </span>
              {s.status === 'active' && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => remove(s.id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Live ride: how much of the ETA is reported waterlogging still ahead. */
export function WaterlogDelayLine({ ride }) {
  const [delay, setDelay] = useState(0);
  useSocketEvent(
    'ride:location',
    useCallback((p) => p.rideId === ride.id && setDelay(p.waterlogDelayMin ?? 0), [ride.id]),
  );
  if (ride.status !== 'ongoing' || !delay) return null;
  return (
    <Notice icon={Waves}>
      The time above includes about {delay} min for waterlogging reported ahead on your route. The fare is not affected.
    </Notice>
  );
}
