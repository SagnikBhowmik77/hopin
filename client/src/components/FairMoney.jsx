import { useCallback, useEffect, useState } from 'react';
import { BellRing, CircleCheck, CreditCard, HandCoins, Split, Wallet } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import { payWithRazorpay, useFeatures } from './RideBits.jsx';
import { ErrorNote, Pill, toast, useAction } from './ui.jsx';
import { Button, Card, Chip, Input, Notice } from '../ds/index.js';
import { rupees } from '../util.js';

/** Who got what for a paid ride, straight from the ledger. */
export function FareShare({ ride, role }) {
  const b = ride.breakdown;
  if (!b) return null;
  const rows = [
    [`${role === 'driver' ? 'You' : 'Driver'} (${b.driverSharePct}%)`, b.driverFare],
    ['Hopin', b.hopinFare],
    b.tip > 0 && ['Tip (100% to the driver)', b.tip],
  ].filter(Boolean);
  return (
    <div className="space-y-1.5 rounded-[var(--radius-md)] bg-raised p-3.5 text-small">
      <p className="font-semibold">Where the money went</p>
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <span className="text-fg-2">{label}</span>
          <span className="tabular-nums">{rupees(value)}</span>
        </div>
      ))}
      {b.cash && <p className="pt-1 text-caption text-fg-2">Paid in cash to the driver. Hopin’s share is taken from the driver’s Hopin wallet.</p>}
    </div>
  );
}

const TIP_CHOICES = [20, 50, 100];

/** Tip after a completed, paid trip: from the wallet or online. */
export function TipBox({ ride, onDone }) {
  const { user } = useSession();
  const features = useFeatures();
  const [amount, setAmount] = useState(50);
  const [busy, run] = useAction();
  if (ride.status !== 'completed' || ride.payment.status !== 'paid' || !ride.driver) return null;
  if (ride.tip > 0) {
    return (
      <p className="flex items-center gap-2 text-small font-semibold text-success">
        <CircleCheck aria-hidden className="size-4" /> You tipped {rupees(ride.tip)}. Thank you!
      </p>
    );
  }
  const valid = Number.isInteger(amount) && amount >= 10 && amount <= 500;
  const first = ride.driver.name.split(' ')[0];
  const done = () => {
    toast(`Tipped ${rupees(amount)}. All of it goes to ${first}.`, 'ok');
    onDone();
  };
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-small font-semibold">
        <HandCoins aria-hidden className="size-[18px]" /> Tip {first}? All of it goes to them.
      </p>
      <div className="flex flex-wrap items-end gap-2" role="radiogroup" aria-label="Tip amount">
        {TIP_CHOICES.map((a) => (
          <Chip key={a} role="radio" aria-checked={amount === a} selected={amount === a} onClick={() => setAmount(a)}>
            {rupees(a)}
          </Chip>
        ))}
        <Input
          id="tip-amount"
          className="w-28"
          inputMode="numeric"
          aria-label="Other tip amount"
          placeholder="Other"
          prefix="₹"
          value={TIP_CHOICES.includes(amount) ? '' : amount || ''}
          onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')))}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon={Wallet}
          loading={busy}
          disabled={!valid || user.walletBalance < amount}
          onClick={() =>
            run(async () => {
              await post(`/rides/${ride.id}/tip`, { amount });
              done();
            })
          }
        >
          From wallet ({rupees(user.walletBalance)})
        </Button>
        {features?.onlinePayments && (
          <Button
            size="sm"
            variant="outline"
            icon={CreditCard}
            disabled={busy || !valid}
            onClick={() =>
              run(async () => {
                await payWithRazorpay({ kind: 'tip', rideId: ride.id, amount });
                done();
              })
            }
          >
            Pay online
          </Button>
        )}
      </div>
      {!valid && <p className="text-caption text-fg-2">Tips are from ₹10 to ₹500.</p>}
    </div>
  );
}

const SPLIT_TONE = { pending: 'in_progress', paid: 'paid', declined: 'cancelled', cancelled: 'cancelled' };

/** Ask other Hopin riders to pay part of a paid fare; their share lands in your wallet. */
export function SplitBox({ ride, onChange }) {
  const fare = ride.price.due;
  const asked = (ride.splits ?? []).filter((s) => ['pending', 'paid'].includes(s.status)).reduce((t, s) => t + s.amount, 0);
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(Math.floor(fare / 2));
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  if (ride.status !== 'completed' || ride.payment.status !== 'paid') return null;

  const ask = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post(`/rides/${ride.id}/splits`, { phone, amount });
        toast('Request sent. Their share goes to your Hopin wallet when they pay.', 'ok');
        setPhone('');
        onChange();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-small font-semibold">
        <Split aria-hidden className="size-[18px]" /> Split this fare
      </p>
      {(ride.splits ?? []).map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2 text-small">
          <span>
            {s.payer.name} · <span className="tabular-nums">{rupees(s.amount)}</span>
          </span>
          <span className="flex items-center gap-2">
            <Pill tone={SPLIT_TONE[s.status]}>{s.status}</Pill>
            {s.status === 'pending' && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await post(`/rides/splits/${s.id}/close`), onChange()))}>
                Cancel
              </Button>
            )}
          </span>
        </div>
      ))}
      {fare - asked > 1 && (
        <form className="grid grid-cols-[1fr_7rem] items-end gap-2" onSubmit={ask}>
          <Input id="split-phone" label="Their mobile" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <Input id="split-amount" label="Their share" prefix="₹" inputMode="numeric" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')))} />
          <Button type="submit" size="sm" variant="outline" className="col-span-2 justify-self-start" loading={busy} disabled={!phone || !amount}>
            Ask for {rupees(amount || 0)}
          </Button>
        </form>
      )}
      <ErrorNote>{error}</ErrorNote>
      <p className="text-caption text-fg-2">They need a Hopin account. You can ask for up to {rupees(Math.max(0, fare - asked - 1))} more.</p>
    </div>
  );
}

/** Requests from other riders to pay part of their fare. */
export function IncomingSplits() {
  const { setUser } = useSession();
  const features = useFeatures();
  const [list, setList] = useState(null);
  const [busy, run] = useAction();
  const load = useCallback(() => api('/rides/splits/incoming').then((d) => setList(d.splits)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent('split:request', load);
  useSocketEvent('split:update', load);
  if (!list?.length) return null;
  const settled = async (message) => {
    toast(message, 'ok');
    load();
    const { user } = await api('/auth/me');
    setUser(user);
  };
  return (
    <div className="mb-4 space-y-2">
      {list.map((s) => (
        <Card key={s.id} className="space-y-3">
          <p className="text-small">
            <strong>{s.requester.name}</strong> asked you to pay <strong className="tabular-nums">{rupees(s.amount)}</strong> of a Hopin trip you shared.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={Wallet} disabled={busy} onClick={() => run(async () => (await post(`/rides/splits/${s.id}/pay`), settled('Paid from your wallet.')))}>
              Pay from wallet
            </Button>
            {features?.onlinePayments && (
              <Button size="sm" variant="outline" icon={CreditCard} disabled={busy} onClick={() => run(async () => (await payWithRazorpay({ kind: 'split', splitId: s.id }), settled('Paid.')))}>
                Pay online
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await post(`/rides/splits/${s.id}/close`), load()))}>
              Decline
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Open surge: "tell me when prices are normal" for the chosen vehicle at this pickup (30 minutes). */
export function SurgeWatch({ pickup, vehicleType, surging }) {
  const [watch, setWatch] = useState(undefined);
  const [busy, run] = useAction();
  useEffect(() => {
    api('/rides/surge-watch')
      .then((d) => setWatch(d.watch))
      .catch(() => setWatch(null));
  }, []);
  if (watch === undefined) return null;
  if (watch) {
    return (
      <Notice
        icon={BellRing}
        action={
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => setWatch((await api('/rides/surge-watch', { method: 'DELETE' })).watch))}>
            Stop
          </Button>
        }
      >
        <p>
          We’ll tell you when {watch.vehicleType} prices are normal near {watch.pickup.address.split(',')[0]}, until{' '}
          {new Date(watch.expiresAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.
        </p>
      </Notice>
    );
  }
  if (!surging || !pickup) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      icon={BellRing}
      loading={busy}
      onClick={() =>
        run(async () => {
          setWatch((await post('/rides/surge-watch', { pickup, vehicleType })).watch);
          toast("We'll notify you when prices here are back to normal (for the next 30 minutes).", 'ok');
        })
      }
    >
      Tell me when prices are normal
    </Button>
  );
}
