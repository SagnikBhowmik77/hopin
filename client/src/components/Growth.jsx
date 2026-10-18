import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Briefcase, Building2, Copy, Download, Gift, Plus, Star, UserPlus } from 'lucide-react';
import { api, apiUrl, currentToken, post } from '../api.js';
import { useSession } from '../session.jsx';
import { payWithRazorpay, useFeatures } from './RideBits.jsx';
import { Empty, ErrorNote, Pill, toast, useAction } from './ui.jsx';
import { Badge, Button, Input, ListSkeleton, Page, Section, Switch } from '../ds/index.js';
import { rupees, when } from '../util.js';

const copy = (text) =>
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied', 'ok'),
    () => toast(`Your code is ${text}`, 'info'),
  );

// --- referrals ----------------------------------------------------------------------------

/** Profile: your code, what it earns, and entering someone else's code if you're new. */
export function ReferralCard() {
  const { user, setUser } = useSession();
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/growth/referral').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <ListSkeleton rows={1} label="Loading your referral code" />;
  const newEnough = Date.now() - new Date(user.createdAt).getTime() < 7 * 86_400_000;
  const apply = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        const r = await post('/growth/referral/apply', { code });
        toast(`Code from ${r.referrerName} added.`, 'ok');
        load();
        const { user: fresh } = await api('/auth/me');
        setUser(fresh);
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <div className="space-y-3 text-small">
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border-2 border-dashed border-line-strong px-4 py-3">
        <span className="font-mono text-[1.375rem] font-bold tracking-[0.2em]">{data.code}</span>
        <Button size="sm" variant="outline" icon={Copy} onClick={() => copy(data.code)}>
          Copy
        </Button>
      </div>
      <p className="text-fg-2">
        {user.role === 'driver'
          ? `You get ${rupees(data.rules.reward)} ${data.rules.when}.`
          : `You and your friend each get ${rupees(data.rules.reward)} ${data.rules.when} (up to ${data.rules.max} friends).`}{' '}
        So far: {data.invited} joined, {data.rewarded} rewarded, {rupees(data.earned)} earned.
      </p>
      {data.usedCode ? (
        <p className="text-caption text-fg-2">
          You joined with {data.usedCode.referrerName}’s code{data.usedCode.status === 'rewarded' ? ' (reward paid).' : user.role === 'rider' ? ': your reward comes after your first paid trip.' : '.'}
        </p>
      ) : (
        newEnough && (
          <form className="flex items-end gap-2" onSubmit={apply}>
            <Input id="ref-code" className="w-44" label="Friend’s code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <Button type="submit" variant="outline" loading={busy} disabled={code.length !== 8}>
              Use code
            </Button>
          </form>
        )
      )}
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}

// --- loyalty -----------------------------------------------------------------------------

export function LoyaltyCard() {
  const { setUser } = useSession();
  const [data, setData] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/growth/loyalty').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <ListSkeleton rows={1} label="Loading your points" />;
  const redeemable = Math.floor(data.points / data.rules.redeemStep) * data.rules.redeemStep;
  return (
    <div className="space-y-3 text-small">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-baseline gap-2">
            <span className="font-display text-[2rem] font-bold leading-none tabular-nums">{data.points}</span>
            <span className="text-fg-2">points</span>
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-fg-2">
            <Badge tone={data.tier.name === 'Gold' ? 'accent' : 'neutral'} icon={Star}>
              {data.tier.name}
            </Badge>
            {data.tier.trips90} trips in 90 days{data.tier.next && ` · ${data.tier.next.tripsToGo} more for ${data.tier.next.name}`}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={Gift}
          loading={busy}
          disabled={redeemable === 0}
          onClick={() =>
            run(async () => {
              const { credited } = await post('/growth/loyalty/redeem', { points: redeemable });
              toast(`${rupees(credited)} added to your wallet`, 'ok');
              load();
              const { user } = await api('/auth/me');
              setUser(user);
            })
          }
        >
          {redeemable ? `Redeem ${redeemable} for ${rupees((redeemable / 100) * data.rules.rupeesPer100)}` : 'Redeem from 100 points'}
        </Button>
      </div>
      <p className="text-caption text-fg-2">
        1 point per {rupees(data.rules.rupeesPerPoint)} you pay for your own trips (business rides earn none). Silver (10+ trips in 90 days) earns 1.25×, Gold (30+) 1.5×. 100 points ={' '}
        {rupees(data.rules.rupeesPer100)}.
      </p>
      {data.history.length > 0 && (
        <ul className="divide-y divide-line text-caption">
          {data.history.slice(0, 5).map((h, i) => (
            <li key={i} className="flex justify-between gap-3 py-2">
              <span className="truncate">{h.kind === 'earned' ? h.trip ?? 'Points' : 'Redeemed'}</span>
              <span className={`tabular-nums ${h.points < 0 ? 'text-fg-2' : 'font-semibold text-success'}`}>{h.points > 0 ? `+${h.points}` : h.points}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- corporate: employee side ----------------------------------------------------------------

export function useBusiness() {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/company/me').then(setData).catch(() => setData({ membership: null, invite: null })), []);
  useEffect(() => {
    load();
  }, [load]);
  return [data, load];
}

/** Profile: company membership, invite to accept, link to the company page for admins. */
export function BusinessCard() {
  const [data, load] = useBusiness();
  const [busy, run] = useAction();
  if (!data) return <ListSkeleton rows={1} label="Loading business account" />;
  if (data.invite) {
    return (
      <div className="space-y-3 text-small">
        <p>
          <strong>{data.invite.company}</strong> invited you to book business rides paid by the company.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => (await post(`/company/invites/${data.invite.id}/answer`, { accept: true }), load()))}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await post(`/company/invites/${data.invite.id}/answer`, { accept: false }), load()))}>
            Decline
          </Button>
        </div>
      </div>
    );
  }
  const m = data.membership;
  if (!m) return <p className="text-small text-fg-2">Not part of a company account. Companies are set up by Hopin; your company admin can then invite you.</p>;
  return (
    <div className="space-y-2 text-small">
      <p className="flex items-center gap-2">
        <Briefcase aria-hidden className="size-[18px]" />
        <strong>{m.company}</strong> · {m.role === 'admin' ? 'company admin' : 'employee'}
      </p>
      <p className="text-fg-2">
        This month: {rupees(m.spentThisMonth)}
        {m.monthlyLimit ? ` of your ${rupees(m.monthlyLimit)} limit` : ' (no limit)'}. Turn on “Business ride” when booking.
      </p>
      {m.role === 'admin' && (
        <Button as={Link} to="/company" size="sm" variant="outline" iconRight={ArrowRight}>
          Manage company
        </Button>
      )}
    </div>
  );
}

/** Book: pay with the company, with an optional expense note. */
export function BusinessPayment({ membership, on, setOn, note, setNote }) {
  if (!membership?.active) return null;
  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] p-3.5 ring-1 ring-line">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2.5 text-small font-semibold">
          <Briefcase aria-hidden className="size-[18px] shrink-0" />
          <span>Business ride, paid by {membership.company}</span>
        </p>
        <Switch label="Business ride" checked={on} onChange={setOn} />
      </div>
      {on && (
        <>
          <Input id="biz-note" label="Expense note" optional maxLength={120} placeholder="Client visit" value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="text-caption text-fg-2">
            Company wallet {rupees(membership.companyBalance)} · you’ve used {rupees(membership.spentThisMonth)}
            {membership.monthlyLimit ? ` of ${rupees(membership.monthlyLimit)}` : ''} this month.
          </p>
        </>
      )}
    </div>
  );
}

// --- corporate: company admin page ---------------------------------------------------------------

/** One member row with an inline monthly-limit editor. */
function MemberRow({ m, busy, run, load }) {
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(m.monthlyLimit ?? '');
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <span className="min-w-0">
        <span className="font-semibold">{m.person.name}</span> <span className="text-fg-2">{m.person.phone}</span>
        <span className="block text-caption text-fg-2">
          {m.role === 'admin' ? 'Admin' : 'Employee'} · {m.status === 'invited' ? 'invite sent' : `${rupees(m.spentThisMonth)} this month`}
          {m.monthlyLimit ? ` · limit ${rupees(m.monthlyLimit)}` : ' · no limit'}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Pill tone={m.status === 'active' ? 'paid' : 'in_progress'}>{m.status}</Pill>
        {m.role !== 'admin' &&
          (editing ? (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api(`/company/members/${m.id}`, { method: 'PATCH', body: { monthlyLimit: limit === '' ? null : Number(limit) } });
                  setEditing(false);
                  load();
                });
              }}
            >
              <Input className="w-28" prefix="₹" inputMode="numeric" placeholder="None" aria-label="Monthly limit" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />
              <Button type="submit" size="sm" variant="secondary" loading={busy}>
                Save
              </Button>
            </form>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Limit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await api(`/company/members/${m.id}`, { method: 'DELETE' }), load()))}>
                Remove
              </Button>
            </>
          ))}
      </span>
    </li>
  );
}

export function CompanyPage() {
  const features = useFeatures();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [invite, setInvite] = useState({ phone: '', monthlyLimit: '' });
  const [amount, setAmount] = useState(1000);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/company').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (error) {
    return (
      <Page>
        <Empty icon={Briefcase} title={error} />
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Company">
        <ListSkeleton rows={4} label="Loading company" />
      </Page>
    );
  }

  const add = (e) => {
    e.preventDefault();
    run(async () => {
      await post('/company/members', { phone: invite.phone, monthlyLimit: invite.monthlyLimit || null });
      toast('Invite sent', 'ok');
      setInvite({ phone: '', monthlyLimit: '' });
      load();
    });
  };
  const download = () =>
    run(async () => {
      const res = await fetch(apiUrl('/company/rides.csv'), { headers: { authorization: `Bearer ${await currentToken()}` } });
      if (!res.ok) throw new Error('Could not download');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: 'hopin-business-rides.csv' });
      a.click();
      URL.revokeObjectURL(url);
    });

  return (
    <Page eyebrow="Business account" title={data.company.name} description="Business rides are paid from this company wallet.">
      <Section title="Company wallet" icon={Building2}>
        <p className="font-display text-[2.25rem] font-bold leading-none tabular-nums">{rupees(data.company.walletBalance)}</p>
        {features?.onlinePayments ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input id="co-amount" className="w-40" label="Top-up amount" prefix="₹" inputMode="numeric" value={amount} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')))} />
            <Button
              variant="primary"
              icon={Plus}
              loading={busy}
              disabled={amount < 500 || amount > 100000}
              onClick={() => run(async () => (await payWithRazorpay({ kind: 'company_topup', amount }), toast('Company wallet topped up', 'ok'), load()))}
            >
              Top up
            </Button>
          </div>
        ) : (
          <p className="text-caption text-fg-2">Online payments are not set up, so the wallet cannot be topped up yet.</p>
        )}
        <p className="text-caption text-fg-2">₹500 to ₹1,00,000 per top-up, through Razorpay.</p>
      </Section>

      <Section
        title="People"
        icon={UserPlus}
        action={
          <Button size="sm" variant="outline" icon={Download} disabled={busy} onClick={download}>
            This month (CSV)
          </Button>
        }
      >
        <ul className="divide-y divide-line text-small">
          {data.members.map((m) => (
            <MemberRow key={m.id} m={m} busy={busy} run={run} load={load} />
          ))}
        </ul>
        <form className="grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end" onSubmit={add}>
          <Input id="co-phone" label="Employee’s mobile" inputMode="tel" value={invite.phone} onChange={(e) => setInvite((v) => ({ ...v, phone: e.target.value }))} />
          <Input
            id="co-limit"
            label="Limit / month"
            optional
            prefix="₹"
            inputMode="numeric"
            value={invite.monthlyLimit}
            onChange={(e) => setInvite((v) => ({ ...v, monthlyLimit: e.target.value.replace(/\D/g, '') }))}
          />
          <Button type="submit" variant="secondary" loading={busy} disabled={!invite.phone.trim()}>
            Invite
          </Button>
        </form>
      </Section>

      <Section title="Wallet history">
        {data.txns.length === 0 ? (
          <p className="text-small text-fg-2">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-line text-small">
            {data.txns.map((t, i) => (
              <li key={i} className="flex justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  {t.kind === 'topup' ? 'Top-up' : t.kind === 'ride' ? 'Business ride' : 'Refund'} {t.who && <span className="text-fg-2">· {t.who}</span>}
                  <span className="block text-caption text-fg-2">{when(t.at)}</span>
                </span>
                <span className={`tabular-nums ${t.amount < 0 ? '' : 'font-semibold text-success'}`}>
                  {t.amount < 0 ? '−' : '+'}
                  {rupees(Math.abs(t.amount))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}

// --- Hopin admin: companies ----------------------------------------------------------------------

export function CompaniesAdmin() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: '', adminPhone: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/admin/companies').then((d) => setList(d.companies)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const create = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/admin/companies', form);
        toast('Company created', 'ok');
        setForm({ name: '', adminPhone: '' });
        load();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <Section title="Companies" icon={Building2} description="Business accounts whose employees ride on the company wallet.">
      {!list ? (
        <ListSkeleton rows={2} label="Loading companies" />
      ) : list.length === 0 ? (
        <Empty icon={Briefcase} title="No company accounts yet" />
      ) : (
        <ul className="divide-y divide-line text-small">
          {list.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="font-semibold">{c.name}</span> {!c.active && <Badge tone="warning">Paused</Badge>}
                <span className="block text-caption text-fg-2">
                  Admin {c.adminName ?? '—'} · {c.members} people · wallet {rupees(c.walletBalance)}
                </span>
              </span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => (await post(`/admin/companies/${c.id}/active`, { active: !c.active }), load()))}>
                {c.active ? 'Pause' : 'Resume'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-2 sm:grid-cols-[1fr_11rem_auto] sm:items-end" onSubmit={create}>
        <Input id="co-name" label="Company name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Input id="co-admin" label="Admin’s mobile" inputMode="tel" value={form.adminPhone} onChange={(e) => setForm((f) => ({ ...f, adminPhone: e.target.value }))} />
        <Button type="submit" variant="secondary" icon={Plus} loading={busy}>
          Create
        </Button>
      </form>
      <p className="text-caption text-fg-2">The company admin must already have a Hopin rider account with that number.</p>
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}
