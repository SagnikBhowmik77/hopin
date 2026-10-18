import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Banknote, ChevronRight, CircleCheck, Download, Flag, Mail, ReceiptText, Star, Wallet } from 'lucide-react';
import { api, download, post } from '../api.js';
import { useSession } from '../session.jsx';
import MapView from '../components/MapView.jsx';
import DriverSheet from '../components/DriverSheet.jsx';
import { ChatHistory } from '../components/RideChat.jsx';
import { FareShare, IncomingSplits, SplitBox, TipBox } from '../components/FairMoney.jsx';
import { RideRecordings } from '../components/TripRecorder.jsx';
import { FareBreakdown, PayDue, ReviewForm, TripRoute, useFeatures } from '../components/RideBits.jsx';
import { Avatar, Empty, Pill, Stars, toast, useAction } from '../components/ui.jsx';
import { Anim, Badge, Button, Chip, EmptyState, Illustration, ListSkeleton, Notice, Page, Skeleton } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { PAID_VIA, VEHICLE_META, rupees, shortPlace, when } from '../util.js';
import { t as tr } from '../i18n/index.js';

const FILTERS = [
  ['all', 'All'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
  ['due', 'Payment due'],
];

export default function Trips() {
  const { id } = useParams();
  const { user } = useSession();
  const [rides, setRides] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api('/rides/history?limit=100')
      .then(({ rides }) => setRides(rides))
      .catch((e) => toast(e.message, 'error'));
  }, [id]);

  const shown = (rides ?? []).filter((r) => filter === 'all' || (filter === 'due' ? r.payment.status === 'due' : r.status === filter));
  const spent = (rides ?? []).filter((r) => r.payment.status === 'paid').reduce((s, r) => s + r.price.due, 0);

  return (
    <Page width="wide" className="!pb-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className={id ? 'hidden lg:block' : ''} aria-label="Trips">
          <header className="mb-4">
            <h1 className="font-display text-title font-bold sm:text-[2rem]">{tr('Your trips')}</h1>
            {rides ? (
              <p className="text-small text-fg-2">
                {tr('{n} completed', { n: rides.filter((r) => r.status === 'completed').length })} · <span className="tabular-nums">{rupees(spent)}</span> {user.role === 'driver' ? 'collected' : 'paid'}
              </p>
            ) : (
              <Skeleton width={180} height={14} className="mt-2" />
            )}
          </header>
          {user.role === 'rider' && <IncomingSplits />}
          <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="radiogroup" aria-label="Filter trips">
            {FILTERS.map(([k, label]) => (
              <Chip key={k} role="radio" aria-checked={filter === k} selected={filter === k} onClick={() => setFilter(k)} className="whitespace-nowrap">
                {tr(label)}
              </Chip>
            ))}
          </div>
          {!rides ? (
            <ListSkeleton rows={5} label="Loading trips" />
          ) : shown.length === 0 ? (
            <EmptyState art={<Anim name="empty-trips" size={120} />} title={tr('No trips here yet')}>
              {user.role === 'rider' ? (
                <Link to="/book" className="font-semibold text-fg underline underline-offset-2">
                  {tr('Book your first ride')}
                </Link>
              ) : (
                'Go online to start receiving requests.'
              )}
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {shown.map((r) => {
                const Icon = VEHICLE_ICON[r.vehicleType];
                return (
                  <li key={r.id}>
                    <Link
                      to={`/trips/${r.id}`}
                      aria-current={r.id === id ? 'page' : undefined}
                      className={`flex min-h-16 items-center gap-3 rounded-[var(--radius-lg)] bg-surface p-3.5 ring-1 transition-colors duration-[var(--dur-fast)] hover:bg-raised ${r.id === id ? 'ring-2 ring-fg' : 'ring-line'}`}
                    >
                      <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-raised" aria-hidden>
                        <Icon className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">
                          {shortPlace(r.pickup)} to {shortPlace(r.dropoff)}
                        </p>
                        <p className="text-caption text-fg-2">{when(r.createdAt)}</p>
                      </div>
                      <div className="shrink-0 space-y-1 text-right">
                        <p className="font-display font-bold tabular-nums">{r.status === 'cancelled' && !r.price.cancellationFee ? '—' : rupees(r.price.due)}</p>
                        {r.payment.status === 'due' ? <Pill tone="due">{tr('Due')}</Pill> : <Pill tone={r.status}>{r.status === 'completed' ? tr('Done') : tr('Cancelled')}</Pill>}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={id ? '' : 'hidden lg:block'} aria-label="Trip receipt">
          {id ? (
            <TripDetail id={id} onChanged={(r) => setRides((list) => list?.map((x) => (x.id === r.id ? { ...r, route: undefined } : x)))} />
          ) : (
            <TripsOverview rides={rides} role={user.role} onShowDue={() => setFilter('due')} />
          )}
        </section>
      </div>
    </Page>
  );
}

/**
 * Beside the list on wide screens, before a trip is picked: a summary worked out from the
 * person's own trip history (the same rides the list shows). Nothing here is estimated or made up.
 */
function TripsOverview({ rides, role, onShowDue }) {
  if (!rides) {
    return (
      <div role="status" aria-busy="true" className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line">
        <span className="sr-only">{tr('Loading')}</span>
        <Skeleton width="50%" height={24} />
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={76} radius="var(--radius-md)" />
          ))}
        </div>
        <Skeleton height={120} radius="var(--radius-md)" />
      </div>
    );
  }
  const done = rides.filter((r) => r.status === 'completed');
  const cancelled = rides.filter((r) => r.status === 'cancelled').length;
  const due = rides.filter((r) => r.payment.status === 'due');
  const paid = rides.filter((r) => r.payment.status === 'paid').reduce((s, r) => s + r.price.due, 0);
  const km = done.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
  const byVehicle = Object.keys(VEHICLE_META)
    .map((type) => [type, done.filter((r) => r.vehicleType === type).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const places = Object.entries(
    done.reduce((acc, r) => {
      const p = r.dropoff && shortPlace(r.dropoff);
      if (p) acc[p] = (acc[p] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const latest = rides[0];

  if (rides.length === 0) {
    return (
      <div className="grid min-h-80 place-items-center rounded-[var(--radius-lg)] bg-surface ring-1 ring-line">
        <EmptyState art={<Illustration name="order-a-ride" width={200} />} title={tr('No trips yet')}>
          {role === 'rider' ? tr('Your first ride’s route, receipt and rating will show up here.') : tr('Go online to start receiving requests.')}
        </EmptyState>
      </div>
    );
  }

  const LatestIcon = VEHICLE_ICON[latest.vehicleType];
  return (
    <div className="space-y-4 lg:sticky lg:top-6">
      <section className="space-y-4 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line" aria-labelledby="overview-title">
        <div>
          <h2 id="overview-title" className="font-display text-heading font-bold">
            {tr('At a glance')}
          </h2>
          <p className="flex items-center gap-1.5 text-small text-fg-2">
            <ArrowLeft aria-hidden className="size-4" />
            {tr('Pick a trip to see its route, receipt and rating.')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            [tr('Completed'), done.length],
            [role === 'driver' ? tr('Collected') : tr('Paid'), rupees(paid)],
            [tr('Distance'), `${km.toLocaleString('en-IN', { maximumFractionDigits: 1 })} km`],
            [tr('Cancelled'), cancelled],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[var(--radius-md)] bg-raised p-3.5">
              <p className="text-caption font-semibold text-fg-2">{label}</p>
              <p className="font-display text-title font-bold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        {due.length > 0 && (
          <Notice icon={Wallet} tone="warning" action={<Button size="sm" variant="outline" onClick={onShowDue}>{tr('Show them')}</Button>}>
            <p className="font-semibold">{tr('{n} trips with payment due', { n: due.length })}</p>
          </Notice>
        )}
      </section>

      {byVehicle.length > 0 && (
        <section className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line" aria-labelledby="vehicles-title">
          <h2 id="vehicles-title" className="font-display text-heading font-bold">
            {tr('How you travel')}
          </h2>
          <ul className="space-y-3">
            {byVehicle.map(([type, n]) => {
              const Icon = VEHICLE_ICON[type];
              const pct = Math.round((n / done.length) * 100);
              return (
                <li key={type} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-small">
                    <span className="flex items-center gap-2 font-semibold">
                      <Icon aria-hidden className="size-[18px]" />
                      {VEHICLE_META[type].label}
                    </span>
                    <span className="tabular-nums text-fg-2">
                      {tr('{n} trips', { n })} · {pct}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {places.length > 0 && (
        <section className="space-y-2 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line" aria-labelledby="places-title">
          <h2 id="places-title" className="font-display text-heading font-bold">
            {tr('Where you go most')}
          </h2>
          <ol className="divide-y divide-line">
            {places.map(([place, n], i) => (
              <li key={place} className="flex items-center gap-3 py-2.5 text-small">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised font-display text-caption font-bold">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{place}</span>
                <span className="shrink-0 tabular-nums text-fg-2">{n}×</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Link
        to={`/trips/${latest.id}`}
        className="flex items-center gap-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line transition-colors duration-[var(--dur-fast)] hover:bg-raised"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent text-accent-fg" aria-hidden>
          <LatestIcon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-caption font-semibold text-fg-2">{tr('Latest trip')}</span>
          <span className="block truncate font-semibold">
            {shortPlace(latest.pickup)} {tr('to')} {shortPlace(latest.dropoff)}
          </span>
          <span className="block text-caption text-fg-2">{when(latest.createdAt)}</span>
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-fg-2" />
      </Link>
    </div>
  );
}

function TripDetail({ id, onChanged }) {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  const [ride, setRide] = useState(null);
  const [error, setError] = useState('');
  const [driverSheet, setDriverSheet] = useState(null);
  const [busy, run] = useAction();
  const features = useFeatures();

  // Reloads everything about the ride (breakdown, tip and splits come only from this endpoint).
  const reload = () =>
    api(`/rides/${id}`)
      .then(({ ride }) => setRide(ride))
      .catch((e) => setError(e.message));
  useEffect(() => {
    setRide(null);
    setError('');
    reload();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (r) => {
    setRide(r);
    onChanged(r);
  };

  const back = (
    <Button variant="ghost" size="sm" icon={ArrowLeft} className="lg:hidden" onClick={() => navigate('/trips')}>
      {tr('All trips')}
    </Button>
  );
  if (error) {
    return (
      <div className="space-y-3">
        {back}
        <Empty icon={ReceiptText} title={error} />
      </div>
    );
  }
  if (!ride) {
    return (
      <div className="overflow-hidden rounded-[var(--radius-lg)] bg-surface ring-1 ring-line" role="status" aria-busy="true">
        <span className="sr-only">Loading trip</span>
        <Skeleton height={224} radius="0" />
        <div className="space-y-3 p-5">
          <Skeleton width="45%" height={22} />
          <Skeleton height={64} radius="var(--radius-md)" />
          <Skeleton height={120} radius="var(--radius-md)" />
        </div>
      </div>
    );
  }

  const hasReceipt = ride.status === 'completed' || ride.price.cancellationFee > 0;
  const other = user.role === 'rider' ? ride.driver : ride.rider;
  const Icon = VEHICLE_ICON[ride.vehicleType];

  return (
    <div className="space-y-3">
      {back}
      <article className="overflow-hidden rounded-[var(--radius-lg)] bg-surface ring-1 ring-line">
        <div className="h-56 border-b border-line">
          <MapView pickup={ride.pickup} stops={ride.stops} dropoff={ride.dropoff} route={ride.route} />
        </div>
        <div className="space-y-5 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-small text-fg-2">{when(ride.createdAt)}</p>
              <h2 className="flex items-center gap-2 font-display text-title font-bold">
                <Icon aria-hidden className="size-6" />
                {VEHICLE_META[ride.vehicleType].label} · {ride.distanceKm} km
              </h2>
            </div>
            <Pill tone={ride.status}>{ride.status}</Pill>
          </div>

          {other && (
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-raised p-3">
              <Avatar src={other.avatar} name={other.name} size={44} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{other.name}</p>
                {user.role === 'rider' && ride.driver && (
                  <p className="truncate text-small text-fg-2">
                    <Stars value={ride.driver.rating} /> · {ride.driver.vehicle.model} · {ride.driver.vehicle.plate}
                  </p>
                )}
              </div>
              {user.role === 'rider' && ride.driver && (
                <Button size="sm" variant="ghost" onClick={() => setDriverSheet(ride.driver.id)}>
                  {tr('Reviews')}
                </Button>
              )}
            </div>
          )}

          <TripRoute ride={ride} />
          {ride.status === 'cancelled' && (
            <p className="text-small text-fg-2">
              Cancelled by {ride.cancelledBy}: {ride.cancelReason}
            </p>
          )}

          <RideRecordings rideId={ride.id} />

          {hasReceipt && (
            <div className="space-y-4 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
              <FareBreakdown ride={ride} />
              {ride.payment.status === 'paid' && (
                <div className="space-y-1">
                  <Badge tone="success" icon={CircleCheck}>
                    Paid by {PAID_VIA[ride.payment.method].label} · {when(ride.payment.paidAt)}
                  </Badge>
                  {ride.payment.ref && <p className="text-caption text-fg-2">Ref {ride.payment.ref}</p>}
                </div>
              )}
              <FareShare ride={ride} role={user.role} />
              {user.role === 'rider' && <PayDue ride={ride} walletBalance={user.walletBalance} onPaid={(r) => (update(r), reload())} />}
              {user.role === 'rider' && (
                <TipBox
                  ride={ride}
                  onDone={() => {
                    reload();
                    api('/auth/me')
                      .then(({ user: fresh }) => setUser(fresh))
                      .catch(() => {});
                  }}
                />
              )}
              {user.role === 'rider' && <SplitBox ride={ride} onChange={reload} />}
              {user.role === 'driver' && ride.payment.status === 'due' && ride.payment.method === 'cash' && (
                <Button variant="primary" size="lg" block icon={Banknote} loading={busy} onClick={() => run(async () => update((await post(`/rides/${ride.id}/collect-cash`)).ride))}>
                  Mark {rupees(ride.price.due)} cash as collected
                </Button>
              )}
              {ride.payment.status === 'paid' && (
                <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={Download}
                    onClick={() => download(`/rides/${ride.id}/receipt.pdf`, `hopin-receipt-${ride.id.slice(0, 8)}.pdf`).catch((e) => toast(e.message, 'error'))}
                  >
                    {tr('PDF receipt')}
                  </Button>
                  {user.role === 'rider' && features?.email && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={Mail}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await post(`/rides/${ride.id}/receipt/email`);
                          toast(`Receipt emailed to ${user.email}`, 'ok');
                        })
                      }
                    >
                      {tr('Email receipt')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {user.role === 'rider' && ride.status === 'completed' && ride.driver && (
            <div className="rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
              {ride.review ? (
                <div className="space-y-1 text-small">
                  <p className="flex items-center gap-1 font-semibold">
                    {tr('Your rating')}
                    {Array.from({ length: ride.review.stars }, (_, i) => (
                      <Star key={i} aria-hidden className="size-4 fill-[var(--accent)] text-[var(--accent-press)]" />
                    ))}
                    <span className="sr-only">{ride.review.stars} stars</span>
                  </p>
                  {ride.review.tags?.length > 0 && <p className="text-fg-2">{ride.review.tags.join(' · ')}</p>}
                  {ride.review.comment && <p>“{ride.review.comment}”</p>}
                </div>
              ) : (
                <ReviewForm ride={ride} onDone={update} />
              )}
            </div>
          )}

          {ride.driver && <ChatHistory rideId={ride.id} />}

          {ride.refunds?.length > 0 && (
            <div className="space-y-2 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
              <p className="text-small font-semibold">Refunds</p>
              {ride.refunds.map((f) => (
                <div key={f.id} className="flex justify-between gap-3 text-small">
                  <span>
                    <span className="tabular-nums">{rupees(f.amount)}</span> to {f.destination === 'wallet' ? 'your Hopin wallet' : 'original payment method'}
                    <span className="block text-caption text-fg-2">
                      {f.reason} · {when(f.createdAt)}
                    </span>
                  </span>
                  <Pill tone={f.status === 'processed' ? 'paid' : f.status === 'failed' ? 'cancelled' : 'in_progress'}>{f.status}</Pill>
                </div>
              ))}
            </div>
          )}

          <Button as={Link} to={`/help?ride=${ride.id}`} variant="outline" block icon={Flag}>
            {tr('Report an issue with this trip')}
          </Button>
        </div>
      </article>
      <DriverSheet driverId={driverSheet} onClose={() => setDriverSheet(null)} />
    </div>
  );
}
