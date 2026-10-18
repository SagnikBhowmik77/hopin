import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Flag, MessageSquarePlus, MessagesSquare, Phone, SendHorizontal, ShieldCheck, Siren, X } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession } from '../session.jsx';
import { Empty, ErrorNote, Pill, toast, useAction } from '../components/ui.jsx';
import { Button, EmptyState, Illustration, Input, ListSkeleton, Notice, Page } from '../ds/index.js';
import { ago, rupees, shortPlace, when } from '../util.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { t as tr } from '../i18n/index.js';

export const CATEGORIES = {
  fare_dispute: 'Fare dispute (ask for a refund)',
  payment: 'Payment problem',
  lost_item: 'Lost item',
  driver: 'Driver behaviour',
  safety: 'Safety concern',
  app: 'App problem',
  other: 'Something else',
};

const FAQ = [
  ['How is my fare calculated?', 'Fares are fixed before you book: a base fare plus per-km and per-minute rates for the vehicle, ₹10 for each extra stop, and a demand multiplier when many people are booking near you and few drivers are free. Promo codes come off the total.'],
  ['When do I pay a cancellation fee?', 'Cancelling is free while we look for a driver and for 2 minutes after one accepts. After that, or once the driver has arrived, a small fee applies (₹15 bike, ₹25 auto, ₹40 cab) — most of it goes to the driver for their time.'],
  ['Why do I share a start code?', 'It proves you got into the right vehicle. Your driver cannot start the trip until they enter the 4-digit code shown on your screen.'],
  ['What happens when I press SOS?', 'Our safety team is alerted immediately with your live location. You also get one-tap buttons to call 112 and to text a live-tracking link to your emergency contacts (add them in Profile).'],
  ['I left something in the vehicle', 'Raise a ticket below with the category “Lost item” and pick the trip. We will connect you with the driver.'],
  ['How do drivers get paid?', 'Drivers keep 80% of every fare. Cash stays with them; online payments are credited to their Hopin wallet.'],
];

export default function Help() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [tickets, setTickets] = useState(null);
  const [openId, setOpenId] = useState(params.get('ticket'));
  const [showForm, setShowForm] = useState(Boolean(params.get('ride')));

  const load = () =>
    api('/support/tickets')
      .then(({ tickets }) => setTickets(tickets))
      .catch(() => setTickets([]));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => setOpenId(params.get('ticket')), [params]);

  return (
    <Page width="wide" title={tr('Help & support')} description={tr('Quick answers first — or talk to us.')}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
        <section className="space-y-4" aria-label="Common questions">
          <Notice icon={Siren} tone="danger" title={tr('In danger right now?')}>
            <p>{tr('Use the SOS button on the ride screen, or call:')}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button as="a" size="sm" variant="danger" icon={Phone} href="tel:112">
                112 police
              </Button>
              <Button as="a" size="sm" variant="outline" icon={Phone} href="tel:108">
                108 ambulance
              </Button>
            </div>
          </Notice>
          <div className="divide-y divide-line rounded-[var(--radius-lg)] bg-surface ring-1 ring-line">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
                  {q}
                  <ChevronDown aria-hidden className="size-5 shrink-0 text-fg-2 transition-transform duration-[var(--dur-fast)] group-open:rotate-180" />
                </summary>
                <p className="px-4 pb-4 text-small text-fg-2">{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="space-y-4" aria-label="Support tickets">
          {user.role !== 'admin' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-heading font-bold">{tr('Your tickets')}</h2>
                <Button size="sm" variant={showForm ? 'ghost' : 'secondary'} icon={showForm ? X : MessageSquarePlus} onClick={() => setShowForm((s) => !s)}>
                  {showForm ? tr('Close') : tr('New ticket')}
                </Button>
              </div>
              {showForm && (
                <NewTicket
                  key={params.get('ride') ?? 'new'}
                  rideId={params.get('ride')}
                  onCreated={(t) => {
                    setShowForm(false);
                    load();
                    setParams({ ticket: t.id });
                  }}
                />
              )}
              {!tickets ? (
                <ListSkeleton rows={3} label="Loading tickets" />
              ) : tickets.length === 0 && !showForm ? (
                <EmptyState
                  art={<Illustration name="empty-mailbox" width={160} />}
                  title={tr('No tickets')}
                  action={
                    <Button variant="secondary" icon={MessageSquarePlus} onClick={() => setShowForm(true)}>
                      {tr('New ticket')}
                    </Button>
                  }
                >
                  {tr('Raise one if something went wrong.')}
                </EmptyState>
              ) : (
                <ul className="space-y-2">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={`w-full rounded-[var(--radius-lg)] bg-surface p-4 text-left transition-colors duration-[var(--dur-fast)] hover:bg-raised ${openId === t.id ? 'ring-2 ring-fg' : 'ring-1 ring-line'}`}
                        onClick={() => setParams({ ticket: t.id })}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-semibold">{t.subject}</span>
                          <Pill tone={t.status}>{t.status.replace('_', ' ')}</Pill>
                        </div>
                        <p className="mt-1 text-caption text-fg-2">
                          {CATEGORIES[t.category]} · updated {ago(t.updatedAt)}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {openId && <Thread id={openId} onChange={load} />}
          {user.role !== 'admin' && (
            <RecentTrips
              onReport={(id) => {
                setParams({ ride: id });
                setShowForm(true);
              }}
            />
          )}
          {user.role !== 'admin' && <SafetyTools user={user} />}
        </section>
      </div>
    </Page>
  );
}

/** Your last few trips, each one tap from a ticket about it. */
function RecentTrips({ onReport }) {
  const [rides, setRides] = useState(null);
  useEffect(() => {
    api('/rides/history?limit=3')
      .then(({ rides }) => setRides(rides))
      .catch(() => setRides([]));
  }, []);
  if (rides && rides.length === 0) return null;
  return (
    <section className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="recent-title">
      <div>
        <h2 id="recent-title" className="font-display text-heading font-bold">
          {tr('Problem with a recent trip?')}
        </h2>
        <p className="text-small text-fg-2">{tr('Pick the trip and we’ll attach it to your ticket.')}</p>
      </div>
      {!rides ? (
        <ListSkeleton rows={3} label="Loading trips" />
      ) : (
        <ul className="divide-y divide-line">
          {rides.map((r) => {
            const Icon = VEHICLE_ICON[r.vehicleType];
            return (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-raised" aria-hidden>
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-semibold">
                    {shortPlace(r.pickup)} {tr('to')} {shortPlace(r.dropoff)}
                  </span>
                  <span className="block text-caption text-fg-2">
                    {when(r.createdAt)} · {r.status === 'cancelled' && !r.price.cancellationFee ? tr('Cancelled') : rupees(r.price.due)}
                  </span>
                </span>
                <Button size="sm" variant="outline" icon={Flag} onClick={() => onReport(r.id)}>
                  {tr('Report')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The safety set-up on this account, with a way to fix it. */
function SafetyTools({ user }) {
  const n = user.emergencyContacts.length;
  return (
    <section className="flex items-start gap-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5" aria-labelledby="safety-title">
      <span className={`grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] ${n ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`} aria-hidden>
        <ShieldCheck className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="safety-title" className="font-semibold">
          {n ? tr('{n} emergency contacts ready for SOS', { n }) : tr('No emergency contacts yet')}
        </h2>
        <p className="text-small text-fg-2">
          {n ? user.emergencyContacts.map((c) => c.name).join(', ') : tr('Add someone so SOS can text them your live location in one tap.')}
        </p>
        <Button as={Link} to="/profile" size="sm" variant={n ? 'ghost' : 'secondary'} iconRight={ChevronRight} className="!-ml-2 mt-1">
          {n ? tr('Manage') : tr('Add a contact')}
        </Button>
      </div>
    </section>
  );
}

function NewTicket({ rideId, onCreated }) {
  const [rides, setRides] = useState([]);
  const [form, setForm] = useState({ category: rideId ? 'lost_item' : 'payment', rideId: rideId ?? '', subject: '', message: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  useEffect(() => {
    api('/rides/history?limit=20')
      .then(({ rides }) => setRides(rides))
      .catch(() => {});
  }, []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        const { ticket } = await post('/support/tickets', { ...form, rideId: form.rideId || null });
        toast('Ticket raised — we usually reply within a few hours.', 'ok');
        onCreated(ticket);
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <form className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="ds-label" htmlFor="t-cat">
            What is it about?
          </label>
          <select id="t-cat" className="input" value={form.category} onChange={set('category')}>
            {Object.entries(CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="ds-label" htmlFor="t-ride">
            Trip <span className="ds-label__optional">(optional)</span>
          </label>
          <select id="t-ride" className="input" value={form.rideId} onChange={set('rideId')}>
            <option value="">Not about a trip</option>
            {rides.map((r) => (
              <option key={r.id} value={r.id}>
                {when(r.createdAt)} · {shortPlace(r.pickup)} to {shortPlace(r.dropoff)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Input id="t-subj" label="Subject" maxLength={120} value={form.subject} onChange={set('subject')} required />
      <Input id="t-msg" multiline rows={5} label="Tell us what happened" maxLength={4000} value={form.message} onChange={set('message')} required />
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" variant="primary" loading={busy}>
        {tr('Submit ticket')}
      </Button>
    </form>
  );
}

export function Thread({ id, onChange }) {
  const { user } = useSession();
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, run] = useAction();
  useEffect(() => {
    setData(null);
    api(`/support/tickets/${id}`)
      .then(setData)
      .catch((e) => toast(e.message, 'error'));
  }, [id]);
  if (!data) return <ListSkeleton rows={3} label="Loading conversation" />;
  const send = (e) => {
    e.preventDefault();
    run(async () => {
      setData(await post(`/support/tickets/${id}/messages`, { body: reply }));
      setReply('');
      onChange?.();
    });
  };
  return (
    <div className="space-y-4 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-heading font-bold">{data.ticket.subject}</p>
          <p className="text-caption text-fg-2">
            {CATEGORIES[data.ticket.category]} · opened {when(data.ticket.createdAt)}
            {user.role === 'admin' && ` · ${data.ticket.user.name} (${data.ticket.user.role})`}
          </p>
        </div>
        <Pill tone={data.ticket.status}>{data.ticket.status.replace('_', ' ')}</Pill>
      </div>
      <ul className="max-h-96 space-y-3 overflow-y-auto">
        {data.messages.map((m) => {
          const mine = m.author.id === user.id;
          return (
            <li key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
              <div className={`max-w-[85%] px-3.5 py-2.5 text-small ${mine ? 'rounded-[var(--radius-md)] rounded-br-[var(--radius-xs)] bg-fg text-ground' : 'rounded-[var(--radius-md)] rounded-bl-[var(--radius-xs)] bg-raised'}`}>
                <p className={`mb-0.5 text-[0.75rem] font-semibold ${mine ? 'opacity-75' : 'text-fg-2'}`}>
                  {m.author.role === 'admin' ? 'Hopin Support' : m.author.name} · {ago(m.createdAt)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <form className="flex items-end gap-2" onSubmit={send}>
        <Input className="min-w-0 flex-1" placeholder="Write a reply…" aria-label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
        <button type="submit" className="ds-btn ds-btn--primary ds-iconbtn" aria-label="Send reply" title="Send" disabled={busy || !reply.trim()}>
          <SendHorizontal aria-hidden />
        </button>
      </form>
    </div>
  );
}
