import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, BedDouble, CreditCard, House, LocateFixed, TrainFront, Wallet } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import PlaceInput from './PlaceInput.jsx';
import { payWithRazorpay, useFeatures } from './RideBits.jsx';
import { toast, useAction } from './ui.jsx';
import { Badge, Button, Notice, Switch } from '../ds/index.js';
import { DEFAULT_CENTER, getBrowserLocation, rupees } from '../util.js';
import { t as tr } from '../i18n/index.js';

const hm = (min) => `${Math.floor(min / 60)} h ${min % 60} min`;

/** Today's pass: keep 100% of fares on rides accepted today. */
export function PassCard({ onChange }) {
  const { setUser } = useSession();
  const features = useFeatures();
  const [data, setData] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/driver/pass').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data?.price) return null;
  const done = async () => {
    toast(`Pass bought. You keep 100% of today's fares.`, 'ok');
    load();
    const { user } = await api('/auth/me');
    setUser(user);
    onChange?.();
  };
  if (data.today) {
    return (
      <Notice icon={BadgeCheck} tone="success" title="Today’s pass is active">
        <p>You keep 100% of fares on rides you accept today, until midnight.</p>
      </Notice>
    );
  }
  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-heading font-bold">Daily pass</p>
          <p className="text-small text-fg-2">Keep 100% of every fare you accept today instead of 80%.</p>
        </div>
        <p className="font-display text-title font-bold tabular-nums">{rupees(data.price)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={Wallet} loading={busy} disabled={data.walletBalance < data.price} onClick={() => run(async () => (await post('/driver/pass'), done()))}>
          From wallet ({rupees(data.walletBalance)})
        </Button>
        {features?.onlinePayments && (
          <Button size="sm" variant="outline" icon={CreditCard} disabled={busy} onClick={() => run(async () => (await payWithRazorpay({ kind: 'driver_pass' }), done()))}>
            Pay online
          </Button>
        )}
      </div>
    </div>
  );
}

/** Heading home: set home once; switch on to get only rides that bring you closer (twice a day). */
export function HeadingHome({ online, me }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [place, setPlace] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/driver/home').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load, online]);
  useSocketEvent(
    'driver:home-reached',
    useCallback(() => {
      toast("You're home. \"Heading home\" is off.", 'ok');
      load();
    }, [load]),
  );
  if (!data) return null;

  const saveHome = (p) =>
    run(async () => {
      await api('/driver/home', { method: 'PUT', body: { home: p } });
      setEditing(false);
      setPlace(null);
      load();
    });
  const useHere = async () => {
    const loc = me ?? (await getBrowserLocation());
    if (!loc) return toast('Location is off.', 'error');
    const { address } = await api(`/geo/reverse?lat=${loc.lat}&lng=${loc.lng}`).catch(() => ({ address: null }));
    saveHome({ lat: loc.lat, lng: loc.lng, address: address ?? undefined });
  };

  if (!data.home || editing) {
    return (
      <div className="space-y-3 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
        <p className="flex items-center gap-2 font-semibold">
          <House aria-hidden className="size-[18px]" /> Set your home for “Heading home”
        </p>
        <div className="rounded-[var(--radius-md)] bg-raised p-1">
          <PlaceInput kind="drop" label="Home address" value={place} onChange={setPlace} near={me ?? DEFAULT_CENTER} active onFocus={() => {}} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!place} loading={busy} onClick={() => saveHome(place)}>
            Save home
          </Button>
          <Button size="sm" variant="outline" icon={LocateFixed} disabled={busy} onClick={useHere}>
            Use where I am
          </Button>
          {data.home && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    );
  }
  const toggle = (on) =>
    run(async () => {
      const r = await post('/driver/heading-home', { on });
      setData((d) => ({ ...d, headingHome: r.headingHome, usesLeft: r.usesLeft }));
    });
  return (
    <div className="space-y-2 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-raised" aria-hidden>
            <House className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">Heading home</p>
            <p className="text-caption text-fg-2">
              <span className="truncate">{data.home.address.split(',')[0]}</span> · {data.usesLeft} of 2 left today ·{' '}
              <button type="button" className="font-semibold text-fg underline underline-offset-2" onClick={() => setEditing(true)}>
                Change
              </button>
            </p>
          </div>
        </div>
        <Switch label="Heading home" checked={data.headingHome} disabled={busy || !online || (!data.headingHome && data.usesLeft <= 0)} onChange={toggle} />
      </div>
      {data.headingHome && <p className="text-caption text-fg-2">Only rides whose drop brings you at least 1 km closer to home. Switches off within 1 km of home.</p>}
      {!online && <p className="text-caption text-fg-2">Go online to use it.</p>}
    </div>
  );
}

/** Driving time since the last 30-minute break; a break is required after 10 hours. */
export function FatigueNote({ online }) {
  const [f, setF] = useState(null);
  useEffect(() => {
    const load = () => api('/driver/fatigue').then(setF).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [online]);
  if (!f) return null;
  if (f.needsBreak) {
    return (
      <Notice icon={BedDouble} tone="danger" title="Time for a break">
        <p>{f.message}</p>
      </Notice>
    );
  }
  return (
    <p className="text-caption text-fg-2">
      {f.drivingMin > 0 ? `Driving ${hm(f.drivingMin)} since your last 30-minute break (limit 10 h).` : 'Rested: no driving since your last break.'}
      {f.rested && ' Riders see you as “Well rested”.'}
    </p>
  );
}

/** Your place in a station's driver queue (Howrah, Sealdah, airport). */
export function StationQueue({ online }) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    if (!online) return setQ(null);
    const load = () => api('/driver/station').then((d) => setQ(d.queue)).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [online]);
  if (!q) return null;
  return (
    <Notice icon={TrainFront} tone="accent" title={`${q.position > 0 ? `#${q.position}` : 'Busy'} in the ${q.station} queue`}>
      <p>
        {q.total} {q.total === 1 ? 'driver' : 'drivers'} waiting. Pickups here go to the front of the queue first.
      </p>
    </Notice>
  );
}

/** Rider waiting at a station: their place in line and drivers queued there. */
export function StationPlace({ ride }) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    const load = () => api(`/rides/${ride.id}/station`).then((d) => setQ(d.queue)).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [ride.id]);
  if (!q) return null;
  return (
    <Notice icon={TrainFront} title={`You’re #${q.place} at ${q.station}`}>
      <p>
        {q.waiting} waiting · {q.driversQueued} {q.driversQueued === 1 ? 'driver' : 'drivers'} in the queue
      </p>
    </Notice>
  );
}

/** Rider: how long the driver has been driving, and "Well rested". */
export function DriverRest({ driver }) {
  if (!driver || driver.drivingMin == null) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-caption text-fg-2">
      {driver.rested && (
        <Badge tone="success" icon={BedDouble}>
          {tr('Well rested')}
        </Badge>
      )}
      {tr('Driving {time} since their last break', { time: hm(driver.drivingMin) })}
    </p>
  );
}
