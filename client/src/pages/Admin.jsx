import { useCallback, useEffect, useState } from 'react';
import {
  CircleCheck, ExternalLink, FileText, HardHat, IdCard, Inbox, LifeBuoy, MoonStar, Navigation, Phone, Plus, ReceiptIndianRupee, RefreshCw, Settings2, ShieldAlert, Siren, Tag, Users,
} from 'lucide-react';
import { api, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { Empty, ErrorNote, Modal, Pill, toast, useAction } from '../components/ui.jsx';
import { CATEGORIES, Thread } from './Help.jsx';
import { ClosuresAdmin, PassPricesAdmin, RentalPackagesAdmin } from '../components/AdminRentals.jsx';
import { CompaniesAdmin } from '../components/Growth.jsx';
import { AdminRecordings } from '../components/TripRecorder.jsx';
import { AdminWaterlog } from '../components/Waterlog.jsx';
import { AdminPayouts } from '../components/Payouts.jsx';
import RoutingStatus from '../components/RoutingStatus.jsx';
import AdminInsights from '../components/AdminInsights.jsx';
import { Badge, Button, Input, ListSkeleton, Notice, Page, Section, Skeleton, Tabs } from '../ds/index.js';
import { ago, rupees, when } from '../util.js';

const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const RESOLUTION = { back_on_route: 'back on route', moving_again: 'moving again', rider_ok: 'rider said OK', trip_ended: 'trip ended' };
const KIND = { off_route: 'off route', long_stop: 'long stop' };

/** An alert row: red edge while it still needs someone. */
function AlertItem({ open, children }) {
  return <li className={`rounded-[var(--radius-md)] p-3.5 text-small ${open ? 'bg-danger-soft ring-1 ring-danger/40' : 'ring-1 ring-line'}`}>{children}</li>;
}

const smsLine = (list) => list.map((s) => `${s.name}: ${s.status === 'failed' ? `failed (${s.error})` : 'sent to Twilio'}`).join(' · ');

/** Route-deviation alerts (step 7): drivers who stay off the planned route during a trip. */
function RouteAlerts({ onChange }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/admin/deviations').then((d) => setList(d.deviations)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent(
    'deviation',
    useCallback(
      (d) => {
        if (d.status === 'open') {
          toast(d.kind === 'long_stop' ? 'A ride has stopped for a long time. See Route alerts.' : `A driver left the planned route by ${metres(d.distanceM)}. See Route alerts.`, 'error');
        }
        load();
        onChange?.();
      },
      [load, onChange],
    ),
  );
  const check = async (id) => {
    try {
      await post(`/admin/deviations/${id}/check`);
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const open = list?.filter((d) => d.status === 'open') ?? [];

  return (
    <Section title="Route alerts" icon={Navigation} action={open.length > 0 && <Badge tone="danger">{open.length} open</Badge>}>
      {!list ? (
        <ListSkeleton rows={2} label="Loading route alerts" />
      ) : list.length === 0 ? (
        <Empty icon={Navigation} title="No route alerts yet">
          Drivers leaving the planned route or stopping for a long time show up here.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list.map((d) => (
            <AlertItem key={d.id} open={d.status === 'open'}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-semibold">
                    {d.driver.name} {d.driver.plate && <span className="font-normal text-fg-2">· {d.driver.plate}</span>}
                  </p>
                  <p>
                    Rider {d.rider.name} ·{' '}
                    {d.kind === 'long_stop'
                      ? `stopped since ${new Date(d.startedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
                      : `${metres(d.distanceM)} off when alerted, furthest ${metres(d.maxDistanceM)}`}
                  </p>
                  <p className="text-caption text-fg-2">
                    {when(d.alertedAt)}
                    {d.resolvedAt && ` · closed ${ago(d.resolvedAt)} (${RESOLUTION[d.resolution]})`}
                    {d.checkedAt && ' · checked'}
                  </p>
                </div>
                <Pill tone={d.status === 'open' ? 'open' : 'resolved'}>{d.status === 'open' ? KIND[d.kind] : 'closed'}</Pill>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.trackPath && (
                  <Button as="a" size="sm" variant="outline" iconRight={ExternalLink} href={d.trackPath} target="_blank" rel="noreferrer">
                    Live map
                  </Button>
                )}
                {!d.checkedAt && (
                  <Button size="sm" variant="secondary" icon={CircleCheck} onClick={() => check(d.id)}>
                    Mark checked
                  </Button>
                )}
              </div>
            </AlertItem>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Daily helmet selfies from bike drivers, waiting for a person to look at them. */
function HelmetReviews({ onChange }) {
  const [list, setList] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/admin/helmet-checks').then((d) => setList(d.checks)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent('helmet-check', load);
  const review = (id, body) =>
    run(async () => {
      await post(`/admin/helmet-checks/${id}/review`, body);
      setRejecting(null);
      setReason('');
      load();
      onChange?.();
    });
  const pending = list?.filter((c) => c.status === 'pending') ?? [];

  return (
    <Section title="Helmet selfies" icon={HardHat} action={pending.length > 0 && <Badge tone="danger">{pending.length} to review</Badge>}>
      {!list ? (
        <ListSkeleton rows={2} label="Loading helmet selfies" />
      ) : list.length === 0 ? (
        <Empty icon={HardHat} title="No helmet selfies yet">
          Bike drivers send one each day before going online.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <li key={c.id} className="flex gap-3 rounded-[var(--radius-md)] p-3 text-small ring-1 ring-line">
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0">
                  <img src={c.url} alt={`Helmet selfie from ${c.driver.name}`} className="size-20 rounded-[var(--radius-sm)] object-cover" />
                </a>
              ) : (
                <div className="grid size-20 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-raised" aria-hidden>
                  <HardHat className="size-7 text-fg-2" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">
                    {c.driver.name} {c.driver.plate && <span className="font-normal text-fg-2">· {c.driver.plate}</span>}
                  </p>
                  <Pill tone={c.status === 'pending' ? 'open' : c.status === 'approved' ? 'paid' : 'cancelled'}>{c.status}</Pill>
                </div>
                <p className="text-caption text-fg-2">
                  {c.takenOn} · sent {ago(c.createdAt)}
                  {c.rejectReason && ` · ${c.rejectReason}`}
                </p>
                {c.status === 'pending' &&
                  (rejecting === c.id ? (
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        review(c.id, { approve: false, reason });
                      }}
                    >
                      <Input className="min-w-0 flex-1" aria-label="Reject reason" placeholder="No helmet visible" value={reason} onChange={(e) => setReason(e.target.value)} />
                      <Button type="submit" size="sm" variant="danger" loading={busy} disabled={!reason.trim()}>
                        Reject
                      </Button>
                    </form>
                  ) : (
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => review(c.id, { approve: true })}>
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(c.id)}>
                        Reject…
                      </Button>
                    </div>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Night rides where the rider did not confirm reaching safely in time. */
function NightChecks({ onChange }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api('/admin/safety-checks').then((d) => setList(d.checks)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent(
    'safety-check',
    useCallback(
      (c) => {
        if (!c.confirmedAt) toast('A rider has not confirmed reaching home safely. See Night ride checks.', 'error');
        load();
        onChange?.();
      },
      [load, onChange],
    ),
  );
  return (
    <Section title="Night ride checks" icon={MoonStar}>
      {!list ? (
        <ListSkeleton rows={2} label="Loading night checks" />
      ) : list.length === 0 ? (
        <Empty icon={MoonStar} title="Nothing to follow up">
          Riders who don’t confirm reaching safely after a night ride show up here.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {list.map((c) => (
            <AlertItem key={c.id} open={!c.confirmedAt}>
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{c.rider.name}</p>
                <Pill tone={c.confirmedAt ? 'resolved' : 'open'}>{c.confirmedAt ? 'safe' : 'not confirmed'}</Pill>
              </div>
              <a className="inline-flex min-h-9 items-center gap-1.5 font-semibold underline underline-offset-2" href={`tel:${c.rider.phone}`}>
                <Phone aria-hidden className="size-4" />
                {c.rider.phone}
              </a>
              <p className="text-caption text-fg-2">
                Drop: {c.drop?.split(',')[0]} · alerted {ago(c.escalatedAt)}
                {c.confirmedAt && ` · confirmed safe ${ago(c.confirmedAt)}`}
              </p>
              {c.smsResults.length > 0 && <p className="mt-1 text-caption">Texts: {smsLine(c.smsResults)}</p>}
            </AlertItem>
          ))}
        </ul>
      )}
    </Section>
  );
}

const TABS = [
  { id: 'safety', label: 'Safety', icon: ShieldAlert },
  { id: 'support', label: 'Support', icon: LifeBuoy },
  { id: 'drivers', label: 'Drivers', icon: Users },
  { id: 'setup', label: 'Setup', icon: Settings2 },
];

export default function Admin() {
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [ticketFilter, setTicketFilter] = useState('');
  const [openTicket, setOpenTicket] = useState(null);
  const [tab, setTab] = useState('safety'); // display only

  const loadOverview = useCallback(() => api('/admin/overview').then(setOverview).catch(() => {}), []);
  const loadAlerts = useCallback(() => api('/admin/sos').then((d) => setAlerts(d.alerts)).catch(() => {}), []);
  const loadTickets = useCallback(
    () =>
      api(`/admin/tickets${ticketFilter ? `?status=${ticketFilter}` : ''}`)
        .then((d) => setTickets(d.tickets))
        .catch(() => {}),
    [ticketFilter],
  );

  useEffect(() => {
    loadOverview();
    loadAlerts();
    const t = setInterval(loadOverview, 15_000);
    return () => clearInterval(t);
  }, [loadOverview, loadAlerts]);
  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useSocketEvent(
    'sos',
    useCallback(
      (a) => {
        toast(`SOS from ${a.user.name} — check the alerts panel`, 'error');
        loadAlerts();
        loadOverview();
      },
      [loadAlerts, loadOverview],
    ),
  );
  useSocketEvent(
    'ticket',
    useCallback(() => {
      loadTickets();
      loadOverview();
    }, [loadTickets, loadOverview]),
  );

  const resolve = async (id) => {
    try {
      await post(`/admin/sos/${id}/resolve`);
      loadAlerts();
      loadOverview();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const open = alerts.filter((a) => a.status === 'open');
  const o = overview;
  const safetyCount = o ? o.open_sos + o.open_deviations + o.unconfirmed_night_rides + o.pending_helmets : 0;
  const tabItems = TABS.map((x) => ({
    ...x,
    label: x.id === 'safety' && safetyCount ? `Safety · ${safetyCount}` : x.id === 'support' && o?.open_tickets ? `Support · ${o.open_tickets}` : x.label,
  }));
  // `hidden` (not unmounting) keeps each panel's socket listeners alive; the class must not set display.
  const panel = (id) => ({ role: 'tabpanel', 'aria-label': TABS.find((x) => x.id === id).label, hidden: tab !== id, className: tab === id ? 'gap-5 lg:columns-2 [&>*]:mb-5 [&>*]:break-inside-avoid' : '' });

  return (
    <Page width="wide" eyebrow="Hopin Kolkata" title="Operations" description="Live safety alerts first. Everything here updates in real time.">
      {o && (o.open_sos > 0 || o.open_deviations > 0 || o.unconfirmed_night_rides > 0) && (
        <Notice role="alert" icon={Siren} tone="danger" title="Needs attention now" action={tab !== 'safety' && <Button size="sm" variant="danger" onClick={() => setTab('safety')}>Open Safety</Button>}>
          <p>
            {[o.open_sos > 0 && `${o.open_sos} open SOS`, o.open_deviations > 0 && `${o.open_deviations} route alerts`, o.unconfirmed_night_rides > 0 && `${o.unconfirmed_night_rides} riders not home yet`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Notice>
      )}
      {o ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Online drivers', o.online_drivers],
            ['Live rides', o.active_rides],
            ['Trips today', o.completed_today],
            ['Paid today', rupees(o.gmv_today)],
            ['Riders', o.riders],
            ['Drivers', o.drivers],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-[var(--radius-md)] bg-surface px-3.5 py-3 ring-1 ring-line">
              <p className="truncate text-caption font-semibold text-fg-2">{label}</p>
              <p className="truncate font-display text-heading font-bold tabular-nums sm:text-title">{value}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={78} radius="var(--radius-md)" />
          ))}
        </div>
      )}

      <AdminInsights overview={o} alerts={alerts} tickets={tickets} onOpen={(t) => (setTab(t), document.getElementById('ops-tabs')?.scrollIntoView({ block: 'start' }))} />

      <div id="ops-tabs" className="-mx-4 scroll-mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Tabs label="Operations sections" value={tab} onChange={setTab} items={tabItems} className="min-w-max sm:min-w-0" />
      </div>

      {/* Every panel stays mounted so its live alerts (toasts, counts) keep working on any tab. */}
      <div {...panel('safety')}>
        <Section title="SOS alerts" icon={Siren} action={open.length > 0 && <Badge tone="danger">{open.length} open</Badge>}>
          {alerts.length === 0 ? (
            <Empty icon={ShieldAlert} title="No alerts" />
          ) : (
            <ul className="space-y-2">
              {alerts.map((a) => (
                <AlertItem key={a.id} open={a.status === 'open'}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-semibold">
                        {a.user.name} <span className="font-normal text-fg-2">({a.user.role})</span>
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2">
                        <a className="inline-flex min-h-9 items-center gap-1.5 font-semibold underline underline-offset-2" href={`tel:${a.user.phone}`}>
                          <Phone aria-hidden className="size-4" />
                          {a.user.phone}
                        </a>
                        {a.driver && (
                          <span>
                            Driver {a.driver.name} {a.driver.plate} ·{' '}
                            <a className="underline" href={`tel:${a.driver.phone}`}>
                              {a.driver.phone}
                            </a>
                          </span>
                        )}
                      </p>
                      <p className="text-caption text-fg-2">
                        {ago(a.createdAt)}
                        {a.location && ` · ${a.location.lat.toFixed(5)}, ${a.location.lng.toFixed(5)}`}
                      </p>
                      {a.smsResults?.length > 0 && <p className="text-caption">SOS texts: {smsLine(a.smsResults)}</p>}
                    </div>
                    <Pill tone={a.status}>{a.status}</Pill>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button as="a" size="sm" variant="outline" iconRight={ExternalLink} href={a.trackPath} target="_blank" rel="noreferrer">
                      Live map
                    </Button>
                    {a.status === 'open' && (
                      <Button size="sm" variant="danger" icon={CircleCheck} onClick={() => resolve(a.id)}>
                        Mark resolved
                      </Button>
                    )}
                  </div>
                </AlertItem>
              ))}
            </ul>
          )}
        </Section>
        <RouteAlerts onChange={loadOverview} />
        <NightChecks onChange={loadOverview} />
        <HelmetReviews onChange={loadOverview} />
        <AdminRecordings />
      </div>

      <div {...panel('support')}>
        <Section
          title="Support tickets"
          icon={Inbox}
          action={
            <select className="input !min-h-11 !w-32 text-small" aria-label="Filter tickets" value={ticketFilter} onChange={(e) => setTicketFilter(e.target.value)}>
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
            </select>
          }
        >
          {tickets.length === 0 ? (
            <Empty icon={Inbox} title="Inbox zero" />
          ) : (
            <ul className="-mx-2 divide-y divide-line">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-sm)] px-2 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-raised"
                    onClick={() => setOpenTicket(t)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{t.subject}</p>
                      <p className="text-caption text-fg-2">
                        {t.user.name} · {CATEGORIES[t.category]} · {t.messageCount} msg · {ago(t.updatedAt)}
                      </p>
                    </div>
                    <Pill tone={t.status}>{t.status.replace('_', ' ')}</Pill>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Refunds />
      </div>

      <div {...panel('drivers')}>
        <DriverReview />
        <AdminPayouts />
      </div>

      <div {...panel('setup')}>
        <RoutingStatus />
        <AdminWaterlog />
        <RentalPackagesAdmin />
        <ClosuresAdmin />
        <PassPricesAdmin />
        <CompaniesAdmin />
        <div className="[column-span:all]">
          <Promos />
        </div>
      </div>

      <Modal open={Boolean(openTicket)} onClose={() => setOpenTicket(null)} title="Ticket" wide>
        {openTicket && (
          <div className="space-y-3">
            <Thread id={openTicket.id} onChange={loadTickets} />
            {openTicket.rideId && <RefundForm rideId={openTicket.rideId} ticketId={openTicket.id} onDone={loadTickets} />}
            <div className="flex flex-wrap gap-2">
              {['in_progress', 'resolved'].map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await post(`/admin/tickets/${openTicket.id}/status`, { status: s }).catch((e) => toast(e.message, 'error'));
                    loadTickets();
                    setOpenTicket(null);
                  }}
                >
                  Mark {s.replace('_', ' ')}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </Page>
  );
}

/**
 * Issue a refund for a ride (or a duplicate payment). Shows what was paid and what
 * is left; the server enforces the limits and where the money can go.
 */
function RefundForm({ rideId, paymentOrderId, ticketId, defaultReason = '', onDone }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('original');
  const [reason, setReason] = useState(defaultReason);
  const [busy, run] = useAction();
  const qs = rideId ? `rideId=${rideId}` : `paymentOrderId=${paymentOrderId}`;
  const load = useCallback(() => {
    api(`/admin/refundable?${qs}`)
      .then((d) => {
        setInfo(d);
        if (!d.original) setDestination('wallet');
      })
      .catch((e) => setError(e.message));
  }, [qs]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-small text-fg-2">Refund: {error}</p>;
  if (!info) return <Skeleton height={96} radius="var(--radius-md)" />;
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const { refund } = await post('/admin/refunds', { rideId, paymentOrderId, ticketId, amount: Number(amount), destination, reason });
      toast(`Refund of ${rupees(refund.amount)}: ${refund.status}`, refund.status === 'failed' ? 'error' : 'ok');
      setAmount('');
      load();
      onDone?.();
    });
  };
  return (
    <form className="space-y-3 rounded-[var(--radius-md)] bg-surface p-4 ring-1 ring-line" onSubmit={submit}>
      <p className="flex items-center gap-2 text-small font-semibold">
        <ReceiptIndianRupee aria-hidden className="size-[18px]" /> Issue refund
      </p>
      <p className="text-caption text-fg-2">
        Paid {rupees(info.paid)} · refunded {rupees(info.refunded)} · <strong className="text-fg">{rupees(info.remaining)} left</strong>
      </p>
      {info.remaining > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Input className="w-32" label="Amount" prefix="₹" type="number" min="1" max={info.remaining} value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <Button type="button" variant="ghost" onClick={() => setAmount(String(info.remaining))}>
              Full
            </Button>
            <div className="space-y-1.5">
              <label className="ds-label" htmlFor="refund-to">
                Refund to
              </label>
              <select id="refund-to" className="input !w-auto" value={destination} onChange={(e) => setDestination(e.target.value)}>
                {info.original && <option value="original">{info.original === 'razorpay' ? 'Original method (Razorpay)' : 'Original method (wallet)'}</option>}
                <option value="wallet">Hopin wallet</option>
              </select>
            </div>
          </div>
          <Input label="Reason" hint="The rider sees this." value={reason} onChange={(e) => setReason(e.target.value)} required />
          <Button type="submit" variant="secondary" loading={busy} disabled={!amount || reason.trim().length < 5}>
            Refund
          </Button>
        </>
      )}
    </form>
  );
}

const REFUND_TONE = { processed: 'paid', pending: 'in_progress', failed: 'cancelled' };

function Refunds() {
  const [data, setData] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/admin/refunds').then(setData).catch((e) => toast(e.message, 'error')), []);
  useEffect(() => {
    load();
  }, [load]);
  const refresh = (id) =>
    run(async () => {
      const { refund } = await post(`/admin/refunds/${id}/refresh`);
      toast(`Razorpay says: ${refund.status}`, 'ok');
      load();
    });

  return (
    <Section title="Refunds" icon={ReceiptIndianRupee}>
      {!data ? (
        <ListSkeleton rows={2} label="Loading refunds" />
      ) : (
        <>
          {data.duplicates.length > 0 && (
            <div className="space-y-2">
              <p className="text-small font-semibold text-danger">Paid twice — refund these</p>
              {data.duplicates.map((d) => (
                <div key={d.id} className="space-y-2 rounded-[var(--radius-md)] bg-danger-soft p-3">
                  <p className="text-small">
                    {d.riderName} paid {rupees(d.amount)} online ({d.paymentId}) for a ride that was already paid.
                  </p>
                  <RefundForm paymentOrderId={d.id} defaultReason="Paid twice for the same ride" onDone={load} />
                </div>
              ))}
            </div>
          )}
          {data.refunds.length === 0 ? (
            <p className="text-small text-fg-2">No refunds yet. Refunds are issued from fare-dispute tickets or the list above.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.refunds.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5 text-small">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <span className="tabular-nums">{rupees(f.amount)}</span> to {f.riderName} · {f.destination === 'wallet' ? 'wallet' : 'original method'}
                    </p>
                    <p className="truncate text-caption text-fg-2">
                      {f.reason}
                      {f.driverAdjustment > 0 && ` · driver −${rupees(f.driverAdjustment)}`}
                      {f.failureReason && ` · ${f.failureReason}`} · {when(f.createdAt)}
                    </p>
                  </div>
                  <Pill tone={REFUND_TONE[f.status]}>{f.status}</Pill>
                  {f.status === 'pending' && f.razorpayRefundId && (
                    <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy} onClick={() => refresh(f.id)}>
                      Refresh
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

const DOC_STATE = {
  missing: ['Missing', 'due'],
  pending: ['To review', 'in_progress'],
  approved: ['Approved', 'paid'],
  rejected: ['Rejected', 'cancelled'],
  expired: ['Expired', 'cancelled'],
  wrong_vehicle: ['Old vehicle', 'cancelled'],
};

/** Driver documents: open a driver, look at each file, approve or reject with a reason. */
function DriverReview() {
  const [drivers, setDrivers] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(() => api('/admin/drivers').then((d) => setDrivers(d.drivers)).catch((e) => toast(e.message, 'error')), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent('driver-docs', load);
  const toReview = drivers?.reduce((n, d) => n + d.pendingDocs, 0) ?? 0;

  return (
    <Section title="Driver verification" icon={IdCard} action={toReview > 0 && <Badge tone="danger">{toReview} to review</Badge>}>
      {!drivers ? (
        <ListSkeleton rows={3} label="Loading drivers" />
      ) : drivers.length === 0 ? (
        <Empty icon={IdCard} title="No drivers yet" />
      ) : (
        <ul className="-mx-2 divide-y divide-line">
          {drivers.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-sm)] px-2 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-raised"
                onClick={() => setOpenId(d.id)}
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-semibold">
                    {d.name} <span className="text-small font-normal text-fg-2">{d.vehicle ? `· ${d.vehicle.model} ${d.vehicle.plate}` : '· no vehicle'}</span>
                  </p>
                  <p className="truncate text-caption text-fg-2">
                    {d.email} · {d.phone} {d.phoneVerified ? '(verified)' : '(unverified)'}
                  </p>
                </div>
                <span className="flex gap-1.5">
                  {d.pendingDocs > 0 && <Pill tone="in_progress">{d.pendingDocs} to review</Pill>}
                  <Pill tone={d.canDrive ? 'paid' : 'due'}>{d.canDrive ? 'Can drive' : 'Blocked'}</Pill>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <DriverDocsModal driverId={openId} onClose={() => setOpenId(null)} onChanged={load} />
    </Section>
  );
}

function DriverDocsModal({ driverId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [reasons, setReasons] = useState({});
  const [busy, run] = useAction();
  const load = useCallback(() => {
    if (!driverId) return;
    api(`/admin/drivers/${driverId}`)
      .then(setData)
      .catch((e) => toast(e.message, 'error'));
  }, [driverId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const review = (docId, decision) =>
    run(async () => {
      await post(`/admin/documents/${docId}/review`, { decision, reason: reasons[docId] });
      toast(decision === 'approve' ? 'Approved' : 'Rejected — the driver has been told why', 'ok');
      load();
      onChanged();
    });

  return (
    <Modal open={Boolean(driverId)} onClose={onClose} title={data ? `${data.driver.name}'s documents` : 'Documents'} wide>
      {!data ? (
        <ListSkeleton rows={3} label="Loading documents" />
      ) : (
        <div className="space-y-4">
          {data.verification.canDrive ? (
            <Notice icon={CircleCheck} tone="success">
              <p className="font-semibold">Approved to drive</p>
            </Notice>
          ) : (
            <Notice icon={ShieldAlert} tone="warning">
              <p>{data.verification.message}</p>
            </Notice>
          )}
          <p className="text-small text-fg-2">
            {data.driver.vehicle ? `${data.driver.vehicle.model} · ${data.driver.vehicle.plate}` : 'No vehicle'} · links expire in 5 minutes (reopen to refresh)
          </p>
          {data.verification.items.map((item) => {
            const [label, tone] = DOC_STATE[item.state];
            const d = item.doc;
            return (
              <div key={item.type} className="space-y-2 rounded-[var(--radius-md)] p-4 ring-1 ring-line">
                <div className="flex justify-between gap-2">
                  <p className="font-semibold">{item.label}</p>
                  <Pill tone={tone}>{label}</Pill>
                </div>
                {!d ? (
                  <p className="text-small text-fg-2">Not uploaded yet.</p>
                ) : (
                  <>
                    <p className="text-small text-fg-2">
                      {d.number && <>No. {d.number} · </>}
                      {d.expiresOn && <>valid until {d.expiresOn} · </>}
                      {d.vehiclePlate && <>for {d.vehiclePlate} · </>}uploaded {when(d.uploadedAt)}
                    </p>
                    {d.urlError ? (
                      <p className="text-small text-danger">{d.urlError}</p>
                    ) : d.mimeType === 'application/pdf' ? (
                      <Button as="a" size="sm" variant="outline" icon={FileText} iconRight={ExternalLink} href={d.url} target="_blank" rel="noreferrer">
                        Open PDF
                      </Button>
                    ) : (
                      <a href={d.url} target="_blank" rel="noreferrer" className="inline-block">
                        <img src={d.url} alt={item.label} className="max-h-64 rounded-[var(--radius-sm)] ring-1 ring-line" />
                      </a>
                    )}
                    {item.state === 'rejected' && <p className="text-small text-danger">Rejected: {d.rejectReason}</p>}
                    {d.status === 'pending' && (
                      <div className="flex flex-wrap items-end gap-2 pt-1">
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => review(d.id, 'approve')}>
                          Approve
                        </Button>
                        <Input
                          className="min-w-48 flex-1"
                          aria-label="Rejection reason"
                          placeholder="Reason, if rejecting"
                          value={reasons[d.id] ?? ''}
                          onChange={(e) => setReasons((r) => ({ ...r, [d.id]: e.target.value }))}
                        />
                        <Button size="sm" variant="danger" disabled={busy || (reasons[d.id] ?? '').trim().length < 5} onClick={() => review(d.id, 'reject')}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function Promos() {
  const [promos, setPromos] = useState(null);
  const [form, setForm] = useState({ code: '', kind: 'percent', value: 10, maxDiscount: '', minFare: '', usageLimit: '', perUserLimit: 1, firstRideOnly: false, expiresAt: '', description: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = () =>
    api('/admin/promos')
      .then((d) => setPromos(d.promos))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/admin/promos', { ...form, value: Number(form.value) });
        toast(`${form.code.toUpperCase()} created`, 'ok');
        setForm((f) => ({ ...f, code: '', description: '' }));
        load();
      } catch (err) {
        setError(err.message);
      }
    });
  };

  return (
    <Section title="Promo codes" icon={Tag}>
      {!promos ? (
        <ListSkeleton rows={3} label="Loading promo codes" />
      ) : promos.length === 0 ? (
        <Empty icon={Tag} title="No promo codes yet" />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[36rem] text-small">
            <thead className="text-left text-caption text-fg-2">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-semibold">Code</th>
                <th className="pr-3 font-semibold">Discount</th>
                <th className="pr-3 font-semibold">Rules</th>
                <th className="pr-3 font-semibold">Used</th>
                <th className="pr-3 font-semibold">Expires</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {promos.map((p) => (
                <tr key={p.code} className={p.active ? '' : 'text-fg-2'}>
                  <td className="py-2 pr-3 font-mono font-bold">{p.code}</td>
                  <td className="pr-3 tabular-nums">
                    {p.kind === 'percent' ? `${p.value}%` : rupees(p.value)}
                    {p.max_discount ? ` (max ${rupees(p.max_discount)})` : ''}
                  </td>
                  <td className="pr-3 text-fg-2">{[p.min_fare ? `min ${rupees(p.min_fare)}` : null, p.first_ride_only ? 'first ride' : null, `${p.per_user_limit}/user`].filter(Boolean).join(' · ')}</td>
                  <td className="pr-3 tabular-nums">
                    {p.used}
                    {p.usage_limit ? ` / ${p.usage_limit}` : ''}
                  </td>
                  <td className="pr-3 text-fg-2">{p.expires_at ? when(p.expires_at) : '—'}</td>
                  <td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await post(`/admin/promos/${p.code}/toggle`).catch((e) => toast(e.message, 'error'));
                        load();
                      }}
                    >
                      {p.active ? 'Disable' : 'Enable'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={create}>
        <Input label="Code" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} required />
        <div className="space-y-1.5">
          <label className="ds-label" htmlFor="promo-kind">
            Kind
          </label>
          <select id="promo-kind" className="input" value={form.kind} onChange={set('kind')}>
            <option value="percent">% off</option>
            <option value="flat">₹ off</option>
          </select>
        </div>
        <Input label="Value" type="number" min="1" value={form.value} onChange={set('value')} required />
        <Input label="Max discount" optional prefix="₹" type="number" min="0" value={form.maxDiscount} onChange={set('maxDiscount')} />
        <Input label="Minimum fare" optional prefix="₹" type="number" min="0" value={form.minFare} onChange={set('minFare')} />
        <Input label="Total uses" optional type="number" min="1" value={form.usageLimit} onChange={set('usageLimit')} />
        <Input label="Uses per rider" type="number" min="1" value={form.perUserLimit} onChange={set('perUserLimit')} />
        <Input label="Expires" optional type="date" value={form.expiresAt} onChange={set('expiresAt')} />
        <Input className="sm:col-span-2 lg:col-span-3" label="Description shown to riders" value={form.description} onChange={set('description')} />
        <label className="flex min-h-11 cursor-pointer items-center gap-3 self-end text-small">
          <input type="checkbox" className="size-5 accent-[var(--fg)]" checked={form.firstRideOnly} onChange={set('firstRideOnly')} /> First ride only
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
        <Button type="submit" variant="secondary" icon={Plus} loading={busy} className="justify-self-start">
          Create promo
        </Button>
      </form>
    </Section>
  );
}
