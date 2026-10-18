import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { ChevronRight, CloudOff, HardHat, Inbox, LifeBuoy, MoonStar, Navigation, Radio, Siren } from 'lucide-react';
import { api } from '../api.js';
import { Button, Notice, Skeleton } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { DEFAULT_CENTER, VEHICLE_META, ago, rupees } from '../util.js';

/** Re-frames the live map whenever the set of points changes. */
function Fit({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join('|');
  useEffect(() => {
    if (points.length === 1) map.setView([points[0].lat, points[0].lng], 14);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 15 });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Rides by state; distinct from online drivers (taxi yellow with an ink ring).
const RIDE_TONE = { requested: 'var(--danger)', accepted: 'var(--fg)', arrived: 'var(--fg-2)', ongoing: 'var(--success)' };
const RIDE_LABEL = { requested: 'Looking for a driver', accepted: 'Driver on the way', arrived: 'Driver at pickup', ongoing: 'On the trip' };

/** Everything live right now: online drivers and rides in progress, from GET /admin/insights. */
function LiveMap({ live }) {
  const points = live ? [...live.drivers, ...live.rides.map((r) => r.pickup)] : [];
  const counts = live ? Object.keys(RIDE_LABEL).map((s) => [s, live.rides.filter((r) => r.status === s).length]) : [];
  return (
    <section className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] bg-surface ring-1 ring-line" aria-labelledby="live-title">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
        <div>
          <h2 id="live-title" className="flex items-center gap-2 font-display text-heading font-bold">
            <Radio aria-hidden className="size-5 text-success" /> Live now
          </h2>
          <p className="text-small text-fg-2">Online drivers and every ride in progress. Refreshes every 20 seconds.</p>
        </div>
        {live && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-2" aria-label="Legend">
            <li className="flex items-center gap-1.5">
              <span className="size-3 rounded-full border-2 border-ink bg-taxi" aria-hidden /> Driver online · {live.drivers.length}
            </li>
            {counts.map(([s, n]) => (
              <li key={s} className="flex items-center gap-1.5">
                <span className="size-3 rounded-full ring-2 ring-surface" style={{ background: RIDE_TONE[s] }} aria-hidden /> {RIDE_LABEL[s]} · {n}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="relative h-72 flex-[1_0_auto] border-t border-line sm:h-80 lg:min-h-80">
        {!live ? (
          <Skeleton height="100%" radius="0" className="absolute inset-0" />
        ) : (
          <MapContainer center={[DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]} zoom={12} zoomControl={false} className="h-full w-full">
            <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' maxZoom={19} />
            <Fit points={points} />
            {live.rides.map((r) => (
              <CircleMarker key={r.id} center={[r.pickup.lat, r.pickup.lng]} radius={8} pathOptions={{ color: '#fffdf8', weight: 2, fillColor: RIDE_TONE[r.status], fillOpacity: 1 }}>
                <Tooltip direction="top" offset={[0, -6]}>
                  {RIDE_LABEL[r.status]} · {VEHICLE_META[r.vehicleType]?.label}
                  <br />
                  {r.pickup.address?.split(',')[0]}
                  {r.dropoff?.address ? ` to ${r.dropoff.address.split(',')[0]}` : ''}
                </Tooltip>
              </CircleMarker>
            ))}
            {live.drivers.map((d, i) => (
              <CircleMarker key={`d${i}`} center={[d.lat, d.lng]} radius={7} pathOptions={{ color: '#17150f', weight: 2, fillColor: '#ffc21a', fillOpacity: 1 }}>
                <Tooltip direction="top" offset={[0, -6]}>
                  {VEHICLE_META[d.vehicleType]?.label ?? 'Driver'} online
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
        )}
        {live && points.length === 0 && (
          <p
            className="pointer-events-none absolute inset-x-4 bottom-4 rounded-[var(--radius-sm)] bg-surface px-3 py-2 text-center text-small font-medium"
            style={{ zIndex: 500, boxShadow: 'var(--shadow-float)' }}
          >
            No drivers online and no rides in progress right now.
          </p>
        )}
      </div>
    </section>
  );
}

/** What needs a person, from /admin/overview; each row opens the tab where it's handled. */
function Attention({ overview, live, onOpen }) {
  const rows = overview
    ? [
        [Siren, 'Open SOS alerts', overview.open_sos, 'safety', 'danger'],
        [Navigation, 'Route alerts', overview.open_deviations, 'safety', 'danger'],
        [MoonStar, 'Riders not home yet', overview.unconfirmed_night_rides, 'safety', 'danger'],
        [HardHat, 'Helmet selfies to review', overview.pending_helmets, 'safety', 'warning'],
        [Inbox, 'Open support tickets', overview.open_tickets, 'support', 'warning'],
      ]
    : [];
  const total = rows.reduce((s, r) => s + r[2], 0);
  return (
    <section className="rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="attention-title">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="attention-title" className="font-display text-heading font-bold">
          Needs a person
        </h2>
        {overview && <span className={`text-small font-semibold ${total ? 'text-danger' : 'text-success'}`}>{total ? `${total} waiting` : 'All clear'}</span>}
      </div>
      {!overview ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={44} radius="var(--radius-sm)" />
          ))}
        </div>
      ) : (
        <ul className="-mx-2">
          {rows.map(([Icon, label, n, tab, tone]) => (
            <li key={label}>
              <button type="button" onClick={() => onOpen(tab)} className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-sm)] px-2 text-left hover:bg-raised">
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] ${n ? (tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning') : 'bg-raised text-fg-2'}`}
                  aria-hidden
                >
                  <Icon className="size-[18px]" />
                </span>
                <span className={`flex-1 text-small ${n ? 'font-semibold' : 'text-fg-2'}`}>{label}</span>
                <span className={`font-display text-heading font-bold tabular-nums ${n ? '' : 'text-fg-2'}`}>{n}</span>
                <ChevronRight aria-hidden className="size-4 text-fg-2" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {live && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="mb-2 text-caption font-semibold uppercase tracking-[0.08em] text-fg-2">Drivers online by vehicle</p>
          <div className="grid grid-cols-3 gap-2">
            {Object.keys(VEHICLE_META).map((type) => {
              const Icon = VEHICLE_ICON[type];
              return (
                <div key={type} className="rounded-[var(--radius-md)] bg-raised p-3">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-fg-2">
                    <Icon aria-hidden className="size-4" /> {VEHICLE_META[type].label}
                  </p>
                  <p className="font-display text-title font-bold tabular-nums">{live.drivers.filter((d) => d.vehicleType === type).length}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

const dayLabel = (iso) => new Date(`${iso}T00:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' });

/** Completed trips per day for the last 7 days (IST); one series, so no legend. */
function WeekChart({ days }) {
  const [hover, setHover] = useState(null);
  if (!days) return <Skeleton height={232} radius="var(--radius-lg)" />;
  const max = Math.max(1, ...days.map((d) => d.completed));
  const totals = days.reduce((t, d) => ({ completed: t.completed + d.completed, cancelled: t.cancelled + d.cancelled, paid: t.paid + d.paid }), { completed: 0, cancelled: 0, paid: 0 });
  const shown = hover != null ? days[hover] : null;
  return (
    <section className="rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="week-title">
      <div className="mb-4">
        <h2 id="week-title" className="font-display text-heading font-bold">
          Completed trips, last 7 days
        </h2>
        <p className="text-small text-fg-2" aria-live="polite">
          {shown ? (
            <>
              {dayLabel(shown.day)}: <span className="font-semibold text-fg">{shown.completed} completed</span> · {shown.cancelled} cancelled · {rupees(shown.paid)} paid
            </>
          ) : (
            <>
              {totals.completed} completed · {totals.cancelled} cancelled · {rupees(totals.paid)} paid
            </>
          )}
        </p>
      </div>
      <div className="flex h-40 items-end gap-2">
        {days.map((d, i) => {
          const today = i === days.length - 1;
          return (
            <button
              key={d.day}
              type="button"
              className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${dayLabel(d.day)}: ${d.completed} completed, ${d.cancelled} cancelled, ${rupees(d.paid)} paid`}
            >
              <span className="text-caption font-semibold tabular-nums text-fg-2">{d.completed || ''}</span>
              <span
                className={`w-full max-w-12 rounded-t-[4px] transition-opacity duration-[var(--dur-fast)] ${today ? 'bg-accent' : 'bg-fg'} ${hover != null && hover !== i ? 'opacity-40' : ''}`}
                style={{ height: `${d.completed ? Math.max(4, (d.completed / max) * 100) : 0}%`, minHeight: 2 }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 border-t border-line pt-2" aria-hidden>
        {days.map((d, i) => (
          <span key={d.day} className={`flex-1 text-center text-caption ${i === days.length - 1 ? 'font-semibold text-fg' : 'text-fg-2'}`}>
            {i === days.length - 1 ? 'Today' : dayLabel(d.day)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Trips per day, last 7 days</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Completed</th>
            <th>Cancelled</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.completed}</td>
              <td>{d.cancelled}</td>
              <td>{rupees(d.paid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Completed trips by vehicle over 30 days. */
function VehicleMix({ vehicles }) {
  if (!vehicles) return <Skeleton height={232} radius="var(--radius-lg)" />;
  const total = vehicles.reduce((s, v) => s + v.trips, 0);
  return (
    <section className="rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="mix-title">
      <h2 id="mix-title" className="font-display text-heading font-bold">
        Vehicle mix
      </h2>
      <p className="mb-4 text-small text-fg-2">Completed trips, last 30 days · {total}</p>
      <ul className="space-y-4">
        {Object.keys(VEHICLE_META).map((type) => {
          const n = vehicles.find((v) => v.type === type)?.trips ?? 0;
          const pct = total ? Math.round((n / total) * 100) : 0;
          const Icon = VEHICLE_ICON[type];
          return (
            <li key={type} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-small">
                <span className="flex items-center gap-2 font-semibold">
                  <Icon aria-hidden className="size-[18px]" /> {VEHICLE_META[type].label}
                </span>
                <span className="tabular-nums text-fg-2">
                  {n} · {pct}%
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-raised" aria-hidden>
                <div className="h-full rounded-full bg-fg" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The latest SOS alerts and support tickets, newest first (data the dashboard already loads). */
function Activity({ alerts, tickets, onOpen }) {
  const items = [
    ...alerts.map((a) => ({ id: `s${a.id}`, at: a.createdAt, icon: Siren, open: a.status === 'open', text: `SOS from ${a.user.name}`, sub: a.status === 'open' ? 'Open' : 'Resolved', tab: 'safety' })),
    ...tickets.map((t) => ({ id: `t${t.id}`, at: t.updatedAt, icon: LifeBuoy, open: t.status !== 'resolved', text: t.subject, sub: `${t.user.name} · ${t.status.replace('_', ' ')}`, tab: 'support' })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6);
  return (
    <section className="rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="activity-title">
      <h2 id="activity-title" className="mb-2 font-display text-heading font-bold">
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="py-6 text-center text-small text-fg-2">No SOS alerts or tickets yet.</p>
      ) : (
        <ol className="-mx-2">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <li key={it.id}>
                <button type="button" onClick={() => onOpen(it.tab)} className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-raised">
                  <span className={`grid size-9 shrink-0 place-items-center rounded-full ${it.open ? 'bg-danger-soft text-danger' : 'bg-raised text-fg-2'}`} aria-hidden>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small font-semibold">{it.text}</span>
                    <span className="block truncate text-caption text-fg-2">{it.sub}</span>
                  </span>
                  <span className="shrink-0 text-caption text-fg-2">{ago(it.at)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The top of the operations console: live map, what needs a person, the week and recent activity. */
export default function AdminInsights({ overview, alerts, tickets, onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () =>
    api('/admin/insights')
      .then((d) => (setData(d), setError('')))
      .catch((e) => setError(e?.message || 'Could not load live data'));
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-5">
      {error && (
        <Notice role="alert" icon={CloudOff} tone="danger" title="Live map and charts did not load" action={<Button size="sm" onClick={load}>Try again</Button>}>
          <p>{error}{data ? '. Showing the last figures that loaded.' : ''}</p>
        </Notice>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <LiveMap live={data?.live} />
        <Attention overview={overview} live={data?.live} onOpen={onOpen} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <WeekChart days={data?.days} />
        <VehicleMix vehicles={data?.vehicles} />
        <div className="md:col-span-2 xl:col-span-1">
          <Activity alerts={alerts} tickets={tickets} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}
