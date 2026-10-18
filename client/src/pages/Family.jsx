import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CarTaxiFront, ExternalLink, Radio, UserPlus, Users } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import { Avatar, Empty, ErrorNote, Pill, toast, useAction } from '../components/ui.jsx';
import { Button, EmptyState, Illustration, Input, ListSkeleton, Notice, Page, Section, Switch } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { STATUS_TEXT } from '../util.js';
import { t as tr } from '../i18n/index.js';

// How Family works, step by step: each step is something the app does today.
const HOW = [
  [UserPlus, 'Invite by mobile number', 'They need a Hopin account with that number and accept your invite. Either of you can remove the link at any time.'],
  [CarTaxiFront, 'Book a ride for them', 'On the ride screen, open Trip options and pick them under “Who’s riding?”. They get the driver’s details and their own start code by SMS.'],
  [Radio, 'Follow trips live, if they choose', 'Each person decides whether to share their own trips. When they do, you see the driver, vehicle and live map, and you’re told when the trip starts and ends.'],
];

/** Beside the family list on wide screens: how it works, and a shortcut to book for someone. */
function FamilyAside({ data }) {
  return (
    <>
      <section className="space-y-4 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line" aria-labelledby="how-title">
        <h2 id="how-title" className="font-display text-heading font-bold">
          {tr('How Family works')}
        </h2>
        <ol className="space-y-4">
          {HOW.map(([Icon, title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="relative grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent-soft" aria-hidden>
                <Icon className="size-5" />
                <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-ink text-[0.6875rem] font-bold text-[#f5f0e6]">{i + 1}</span>
              </span>
              <div className="min-w-0">
                <p className="font-semibold">{tr(title)}</p>
                <p className="text-small text-fg-2">{tr(body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {data && (
        <section className="grid grid-cols-2 gap-2" aria-label={tr('Your family')}>
          <div className="rounded-[var(--radius-md)] bg-surface p-4 ring-1 ring-line">
            <p className="text-caption font-semibold text-fg-2">{tr('Members')}</p>
            <p className="font-display text-title font-bold tabular-nums">{data.members.length}</p>
          </div>
          <div className="rounded-[var(--radius-md)] bg-surface p-4 ring-1 ring-line">
            <p className="text-caption font-semibold text-fg-2">{tr('Your trips')}</p>
            <p className={`font-display text-heading font-bold ${data.sharing ? 'text-success' : ''}`}>{data.sharing ? tr('Shared') : tr('Private')}</p>
          </div>
        </section>
      )}
      <Button as={Link} to="/book" variant="secondary" size="lg" block icon={CarTaxiFront}>
        {tr('Book a ride for family')}
      </Button>
    </>
  );
}

/** Family: invite by phone number, choose whether to share your own live trips, follow members who share theirs. */
export default function Family() {
  const { setUser } = useSession();
  const [data, setData] = useState(null);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/family').then(setData).catch((e) => toast(e.message, 'error')), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent('family:update', load);

  const invite = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/family', { phone });
        toast('Invite sent. They need to accept it.', 'ok');
        setPhone('');
        load();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  const share = (on) =>
    run(async () => {
      await api('/family/sharing', { method: 'PUT', body: { share: on } });
      const { user } = await api('/auth/me');
      setUser(user);
      load();
    });

  return (
    <Page
      title={tr('Family')}
      description={tr('Book rides for each other in one tap and, if you choose, follow each other’s trips live.')}
      aside={<FamilyAside data={data} />}
    >
      {!data ? (
        <ListSkeleton rows={3} label="Loading family" />
      ) : (
        <>
          <Section>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold">{tr('Share my live trips with family')}</p>
                <p className="text-small text-fg-2">
                  {data.sharing
                    ? 'On: your family sees your trip in progress (driver, vehicle, live map) and is told when it starts and ends.'
                    : 'Off: nothing about your trips is shown to your family.'}
                </p>
              </div>
              <Switch label="Share my live trips with family" checked={data.sharing} disabled={busy} onChange={share} />
            </div>
          </Section>

          {data.incoming.map((i) => (
            <Notice
              key={i.linkId}
              icon={UserPlus}
              tone="accent"
              action={
                <>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => (await post(`/family/${i.linkId}/answer`, { accept: true }), load()))}>
                    {tr('Accept')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await post(`/family/${i.linkId}/answer`, { accept: false }), load()))}>
                    {tr('Decline')}
                  </Button>
                </>
              }
            >
              <p>
                <strong>{i.person.name}</strong> wants to add you to their family.
              </p>
            </Notice>
          ))}

          <Section title={tr('Members')} icon={Users}>
            {data.members.length === 0 ? (
              <EmptyState art={<Illustration name="quality-time" width={180} />} title={tr('No family members yet')}>
                Invite someone with their mobile number. They need a Hopin account.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {data.members.map((m) => {
                  const VIcon = m.liveTrip ? VEHICLE_ICON[m.liveTrip.vehicleType] : null;
                  return (
                    <li key={m.linkId} className="space-y-2 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar src={m.person.avatar} name={m.person.name} size={40} />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">{m.person.name}</p>
                          <p className="text-caption text-fg-2">{m.sharesTrips ? 'Shares their trips with family' : 'Doesn’t share their trips'}</p>
                        </div>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await api(`/family/${m.linkId}`, { method: 'DELETE' }), load()))}>
                          Remove
                        </Button>
                      </div>
                      {m.liveTrip && (
                        <div className="space-y-2 rounded-[var(--radius-md)] bg-raised p-3 text-small">
                          <p className="flex flex-wrap items-center gap-2">
                            <Pill tone="in_progress">{STATUS_TEXT[m.liveTrip.status]}</Pill>
                            <VIcon aria-hidden className="size-4" />
                            {m.liveTrip.driver.name} · {m.liveTrip.driver.plate}
                          </p>
                          <p className="text-caption text-fg-2">
                            {m.liveTrip.pickup.split(',')[0]}
                            {m.liveTrip.dropoff ? ` to ${m.liveTrip.dropoff.split(',')[0]}` : ' (rental)'}
                          </p>
                          <Button as="a" size="sm" variant="secondary" icon={Radio} iconRight={ExternalLink} href={m.liveTrip.trackPath} target="_blank" rel="noreferrer">
                            {tr('Follow live')}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {data.outgoing.length > 0 && <p className="text-caption text-fg-2">Waiting for: {data.outgoing.map((o) => o.person.name).join(', ')}</p>}
            <form className="flex items-end gap-2 border-t border-line pt-4" onSubmit={invite}>
              <Input id="family-phone" className="min-w-0 flex-1" label="Invite by mobile number" inputMode="tel" placeholder="98300 12345" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button type="submit" variant="secondary" icon={UserPlus} loading={busy} disabled={!phone.trim()}>
                {tr('Invite')}
              </Button>
            </form>
            <ErrorNote>{error}</ErrorNote>
          </Section>
        </>
      )}
    </Page>
  );
}
