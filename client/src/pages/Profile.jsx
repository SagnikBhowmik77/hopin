import AppSettings from '../components/AppSettings.jsx';
import ProfileAside from '../components/ProfileAside.jsx';
import { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck, Briefcase, Camera, Car, Ear, Gift, KeyRound, Lock, LogOut, MapPin, Plus, ShieldPlus, Smartphone, Star, UserRound, Wallet, X,
} from 'lucide-react';
import { api, post } from '../api.js';
import { useSession } from '../session.jsx';
import { TestModeNote, payWithRazorpay, useFeatures } from '../components/RideBits.jsx';
import DriverSheet from '../components/DriverSheet.jsx';
import { SavedPlacesManager } from '../components/Planning.jsx';
import { BusinessCard, LoyaltyCard, ReferralCard } from '../components/Growth.jsx';
import { Avatar, ErrorNote, Stars, toast, useAction } from '../components/ui.jsx';
import { Badge, Button, Chip, Input, Notice, Page, Section, Switch } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { PAYMENT_META, VEHICLE_META, resizeImage, rupees, when } from '../util.js';
import { t as tr } from '../i18n/index.js';

const ROLE = { rider: 'Rider', driver: 'Driver', admin: 'Admin' };

export default function Profile() {
  const { user, setUser, signOut } = useSession();

  return (
    <Page aside={<ProfileAside user={user} />}>
      <Personal user={user} setUser={setUser} />
      <PhoneVerify user={user} setUser={setUser} />
      {user.role === 'rider' && <Payments user={user} setUser={setUser} />}
      {user.role === 'driver' && <Vehicle user={user} setUser={setUser} />}
      {user.role === 'driver' && <MyReviews user={user} />}
      {user.role === 'rider' && <TripPin user={user} setUser={setUser} />}
      {user.role !== 'admin' && <EmergencyContacts user={user} setUser={setUser} />}
      {user.role === 'rider' && (
        <Section id="places" title={tr('Saved places')} icon={MapPin} description="Home, Work and your own places for one-tap booking.">
          <SavedPlacesManager />
        </Section>
      )}
      {user.role === 'rider' && (
        <Section id="rewards" title={tr('Hopin Rewards')} icon={Star} description="Points for every trip you pay for, turned into wallet credit.">
          <LoyaltyCard />
        </Section>
      )}
      {user.role !== 'admin' && (
        <Section id="refer" title={tr('Refer & earn')} icon={Gift} description="Share your code. Rewards are paid into your Hopin wallet.">
          <ReferralCard />
        </Section>
      )}
      {user.role === 'rider' && (
        <Section id="business" title={tr('Business')} icon={Briefcase} description="Rides paid by your company’s Hopin wallet.">
          <BusinessCard />
        </Section>
      )}
      {user.role === 'driver' && <DriverHearing user={user} setUser={setUser} />}
      <Section id="settings" title={tr('App & settings')} icon={Smartphone} description="Theme, language, install Hopin and get ride updates with the app closed.">
        <AppSettings />
      </Section>
      <Password />
      <Button variant="outline" size="lg" block icon={LogOut} className="md:hidden" onClick={signOut}>
        {tr('Sign out')}
      </Button>
    </Page>
  );
}

function Personal({ user, setUser }) {
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone?.replace(/^\+91/, '') ?? '');
  const [busy, run] = useAction();
  const fileRef = useRef(null);

  const save = (body, msg = 'Saved') =>
    run(async () => {
      const res = await api('/profile', { method: 'PATCH', body });
      setUser(res.user);
      toast(msg, 'ok');
    });

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      save({ avatar: await resizeImage(file) }, 'Photo updated');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <Avatar src={user.avatar} name={user.name} size={80} />
          <button
            type="button"
            className="absolute -bottom-1 -right-1 grid size-10 place-items-center rounded-full bg-fg text-ground ring-4 ring-ground transition-transform duration-[var(--dur-fast)] active:scale-95"
            aria-label={user.avatar ? 'Change photo' : 'Upload photo'}
            title={user.avatar ? 'Change photo' : 'Upload photo'}
            onClick={() => fileRef.current.click()}
            disabled={busy}
          >
            <Camera aria-hidden className="size-[18px]" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate font-display text-title font-bold sm:text-[2rem]">{user.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-small text-fg-2">
            <Badge tone="accent" icon={UserRound}>
              {ROLE[user.role]}
            </Badge>
            since {new Date(user.createdAt).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </p>
          {user.avatar && (
            <button type="button" className="mt-1 min-h-9 text-caption font-semibold text-fg-2 underline underline-offset-2" onClick={() => save({ avatar: null }, 'Photo removed')} disabled={busy}>
              Remove photo
            </button>
          )}
        </div>
      </div>
      <Section id="personal" title={tr('Personal info')} icon={UserRound}>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save({ name, phone });
          }}
        >
          <Input id="p-name" label={tr('Name')} value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            id="p-phone"
            label={tr('Mobile')}
            prefix="+91"
            inputMode="numeric"
            maxLength={10}
            value={phone}
            hint={user.phoneVerified ? undefined : 'Not verified yet'}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div className="space-y-1 sm:col-span-2">
            <p className="ds-label">{tr('Email')}</p>
            <p className="text-small text-fg-2">{user.email}</p>
          </div>
          <Button type="submit" variant="secondary" loading={busy} className="sm:col-span-2 sm:justify-self-start">
            {tr('Save changes')}
          </Button>
        </form>
      </Section>
    </section>
  );
}

function Vehicle({ user, setUser }) {
  const [v, setV] = useState(user.vehicle ?? { type: 'car', model: '', plate: '' });
  const [busy, run] = useAction();
  return (
    <Section id="vehicle" title="Vehicle" icon={Car} description="Changes apply the next time you go online.">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Vehicle type">
        {Object.entries(VEHICLE_META).map(([type, m]) => {
          const Icon = VEHICLE_ICON[type];
          const on = v.type === type;
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setV({ ...v, type })}
              className={`flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] transition-colors duration-[var(--dur-fast)] ${on ? 'bg-accent-soft ring-2 ring-fg' : 'ring-1 ring-line hover:bg-raised'}`}
            >
              <Icon aria-hidden className="size-6" />
              <span className="text-small font-semibold">{m.label}</span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Model" placeholder="Maruti Dzire" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} />
        <Input label="Number plate" placeholder="WB 04 K 2211" value={v.plate} onChange={(e) => setV({ ...v, plate: e.target.value.toUpperCase() })} />
      </div>
      <Button
        variant="secondary"
        loading={busy}
        onClick={() =>
          run(async () => {
            setUser((await api('/profile/vehicle', { method: 'PUT', body: v })).user);
            toast('Vehicle updated', 'ok');
          })
        }
      >
        Save vehicle
      </Button>
    </Section>
  );
}

function MyReviews({ user }) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      id="rating"
      title="Your rating"
      icon={Star}
      action={
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          See reviews
        </Button>
      }
    >
      <p className="flex items-center gap-2">
        <Stars value={user.rating} size={22} /> <span className="text-small text-fg-2">from {user.ratingCount} reviews</span>
      </p>
      <DriverSheet driverId={open ? user.id : null} onClose={() => setOpen(false)} />
    </Section>
  );
}

/** Drivers who are deaf or hard of hearing can tell riders, who are then asked to use chat. */
function DriverHearing({ user, setUser }) {
  const [busy, run] = useAction();
  const set = (deaf) =>
    run(async () => {
      const { user: fresh } = await api('/profile/driver-deaf', { method: 'PUT', body: { deaf } });
      setUser(fresh);
    });
  return (
    <Section id="hearing" title="Hearing" icon={Ear}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-small text-fg-2">
          If you are deaf or hard of hearing, riders see a note asking them to use chat instead of calling. You also get message cards to show on the ride screen.
        </p>
        <Switch label="I am deaf or hard of hearing" checked={user.driverDeaf} disabled={busy} onChange={set} />
      </div>
    </Section>
  );
}

/** The rider's own trip PIN: the code drivers must enter to start a trip. */
function TripPin({ user, setUser }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const save = (value) =>
    run(async () => {
      setError('');
      try {
        const { user: fresh } = await api('/profile/trip-pin', { method: 'PUT', body: { pin: value } });
        setUser(fresh);
        setPin('');
        toast(value ? 'Trip PIN saved. Use it to start every ride.' : 'Back to a new random code for each ride.', 'ok');
      } catch (err) {
        setError(err.message);
      }
    });
  return (
    <Section id="trip-pin" title={tr('Trip PIN')} icon={KeyRound} description="The code you tell your driver to start a trip. Set your own, or get a new random one for each ride.">
      <p className="text-small">
        {user.tripPin ? (
          <>
            Your PIN is <strong className="font-mono text-heading tracking-[0.3em]">{user.tripPin}</strong>
          </>
        ) : (
          'You get a new random code for each ride.'
        )}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save(pin);
        }}
      >
        <Input
          id="trip-pin"
          className="w-36"
          label="New PIN"
          inputMode="numeric"
          maxLength={4}
          placeholder="4 digits"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <Button type="submit" variant="secondary" loading={busy} disabled={pin.length !== 4}>
          {user.tripPin ? 'Change' : 'Set PIN'}
        </Button>
        {user.tripPin && (
          <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
            Use random codes
          </Button>
        )}
      </form>
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}

function Payments({ user, setUser }) {
  const features = useFeatures();
  const online = Boolean(features?.onlinePayments);
  const [wallet, setWallet] = useState(null);
  const [amount, setAmount] = useState(500);
  const [busy, run] = useAction();

  const loadWallet = () =>
    api('/profile/wallet')
      .then(setWallet)
      .catch(() => {});
  useEffect(() => {
    loadWallet();
  }, []);

  /** Wallet top-up through Razorpay; the balance changes only after the server confirms it. */
  const topUp = () =>
    run(async () => {
      const res = await payWithRazorpay({ kind: 'topup', amount });
      setUser({ ...user, walletBalance: res.walletBalance });
      loadWallet();
      toast(`${rupees(amount)} added to your wallet${features?.onlinePaymentsTestMode ? ' (Razorpay test mode)' : ''}.`, 'ok');
    });

  const setDefault = (m) =>
    run(async () => {
      setUser((await api('/profile', { method: 'PATCH', body: { defaultPayment: m } })).user);
    });

  return (
    <Section id="wallet" title={tr('Wallet & payments')} icon={Wallet}>
      {/* The wallet card: the one place the brand yellow carries a big number. */}
      <div className="space-y-4 rounded-[var(--radius-lg)] bg-ink p-5 text-[#f5f0e6] ring-1 ring-line-strong/40">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-small text-[#cfc6b4]">Hopin Wallet</p>
            <p className="font-display text-[2.25rem] font-bold leading-none tabular-nums">{rupees(user.walletBalance)}</p>
          </div>
          <Wallet aria-hidden className="size-7 text-taxi" />
        </div>
        {online ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Top-up amount">
              {[100, 200, 500, 1000, 2000].map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={amount === a}
                  onClick={() => setAmount(a)}
                  className={`min-h-11 rounded-[var(--radius-sm)] px-3.5 text-small font-semibold tabular-nums transition-colors duration-[var(--dur-fast)] ${amount === a ? 'bg-taxi text-ink' : 'bg-white/10 text-[#f5f0e6] hover:bg-white/15'}`}
                >
                  {rupees(a)}
                </button>
              ))}
            </div>
            <Button variant="primary" block icon={Plus} loading={busy} onClick={topUp}>
              Add {rupees(amount)}
            </Button>
          </div>
        ) : (
          features && <p className="text-caption text-[#cfc6b4]">Adding money needs online payments. {features.onlinePaymentsMessage}</p>
        )}
      </div>
      {online && <TestModeNote />}
      {wallet?.txns.length > 0 && (
        <ul className="divide-y divide-line text-small">
          {wallet.txns.slice(0, 5).map((t) => (
            <li key={t.id} className="flex justify-between gap-3 py-2.5">
              <span className="text-fg-2">
                {t.kind === 'topup' ? 'Top-up' : t.kind === 'ride' ? 'Ride payment' : t.kind} · {when(t.created_at)}
              </span>
              <span className={`tabular-nums ${t.amount > 0 ? 'font-semibold text-success' : ''}`}>
                {t.amount > 0 ? '+' : '−'}
                {rupees(Math.abs(t.amount))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-small font-semibold">{tr('Default payment')}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Default payment">
          {Object.entries(PAYMENT_META).map(([m, meta]) => (
            <Chip
              key={m}
              role="radio"
              aria-checked={user.defaultPayment === m}
              selected={user.defaultPayment === m}
              icon={meta.icon}
              disabled={(m === 'card' || m === 'upi') && !online}
              onClick={() => setDefault(m)}
            >
              {meta.label}
            </Chip>
          ))}
        </div>
        <p className="text-caption text-fg-2">{tr('You can switch for any ride.')}</p>
      </div>
    </Section>
  );
}

function EmergencyContacts({ user, setUser }) {
  const [list, setList] = useState(user.emergencyContacts.map((c) => ({ ...c, phone: c.phone.replace(/^\+91/, '') })));
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const setAt = (i, k, v) => setList((l) => l.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const save = () =>
    run(async () => {
      setError('');
      try {
        setUser((await api('/profile/emergency-contacts', { method: 'PUT', body: { contacts: list } })).user);
        toast('Emergency contacts saved', 'ok');
      } catch (err) {
        setError(err.message);
      }
    });
  return (
    <Section id="emergency" title={tr('Emergency contacts')} icon={ShieldPlus} description="SOS lets you text these people your live location in one tap. Up to 3.">
      {list.length === 0 && (
        <Notice icon={ShieldPlus} tone="warning">
          <p>Add at least one person so SOS can reach them.</p>
        </Notice>
      )}
      {list.map((c, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Input label={i === 0 ? 'Name' : undefined} aria-label={`Contact ${i + 1} name`} placeholder="Name" value={c.name} onChange={(e) => setAt(i, 'name', e.target.value)} />
          <Input
            label={i === 0 ? 'Mobile' : undefined}
            aria-label={`Contact ${i + 1} mobile`}
            prefix="+91"
            inputMode="numeric"
            maxLength={10}
            value={c.phone}
            onChange={(e) => setAt(i, 'phone', e.target.value)}
          />
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-iconbtn"
            aria-label={`Remove contact ${i + 1}`}
            title="Remove"
            onClick={() => setList((l) => l.filter((_, j) => j !== i))}
          >
            <X aria-hidden />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {list.length < 3 && (
          <Button variant="ghost" icon={Plus} onClick={() => setList((l) => [...l, { name: '', phone: '' }])}>
            {tr('Add contact')}
          </Button>
        )}
        <Button variant="secondary" loading={busy} onClick={save}>
          {tr('Save contacts')}
        </Button>
      </div>
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}

/**
 * Phone verification. Supabase sends the SMS code (through Twilio) and checks it;
 * afterwards Hopin's server asks Supabase whether the number is confirmed before
 * marking it verified - the app's word alone is not enough.
 */
function PhoneVerify({ user, setUser }) {
  const { supabase, providers } = useSession();
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();

  const sync = async () => {
    const res = await post('/auth/phone/sync');
    setUser(res.user);
    setCodeSent(false);
    setCode('');
    toast('Mobile number verified', 'ok');
  };

  const send = () =>
    run(async () => {
      setError('');
      const { error } = await supabase.auth.updateUser({ phone: user.phone });
      if (error) {
        // Already confirmed on this account in Supabase: just bring Hopin up to date.
        if (/same|already/i.test(error.message)) return sync().catch((e) => setError(e.message));
        return setError(error.message);
      }
      setCodeSent(true);
    });

  const confirm = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      const { error } = await supabase.auth.verifyOtp({ phone: user.phone, token: code, type: 'phone_change' });
      if (error) return setError(error.message);
      try {
        await sync();
      } catch (err) {
        setError(err.message);
      }
    });
  };

  if (user.phoneVerified) {
    return (
      <Notice icon={BadgeCheck} tone="success">
        <p className="font-semibold">{user.phone} is verified</p>
      </Notice>
    );
  }
  return (
    <Section title="Verify your mobile" icon={Smartphone}>
      {!providers?.phone ? (
        <p className="text-small text-fg-2">SMS verification isn’t switched on yet, so {user.phone} can’t be verified for now.</p>
      ) : !codeSent ? (
        <div className="space-y-3">
          <p className="text-small text-fg-2">
            Verify {user.phone} to book rides{user.role === 'driver' ? ' and go online' : ''}.
          </p>
          <Button variant="primary" loading={busy} onClick={send}>
            Send code by SMS
          </Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={confirm}>
          <div className="flex items-end gap-2">
            <Input
              id="sms-code"
              className="min-w-0 flex-1"
              label={`Code sent to ${user.phone}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" variant="primary" loading={busy} disabled={code.length < 4}>
              Verify
            </Button>
          </div>
          <button type="button" className="min-h-9 text-caption font-semibold text-fg-2 underline underline-offset-2" onClick={send} disabled={busy}>
            Send a new code
          </button>
        </form>
      )}
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}

/** Sign-in passwords live in Supabase Auth, so a change goes straight to Supabase. */
function Password() {
  const { supabase } = useSession();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  return (
    <Section id="password" title={tr('Password')} icon={Lock} description="Signed in with Google? Setting a password also lets you sign in with your email.">
      <form
        className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            setError('');
            if (next !== confirm) return setError('Passwords do not match');
            const { error } = await supabase.auth.updateUser({ password: next });
            if (error) return setError(error.message);
            setNext('');
            setConfirm('');
            toast('Password changed', 'ok');
          });
        }}
      >
        <Input type="password" autoComplete="new-password" label="New password" hint="8 or more characters" value={next} onChange={(e) => setNext(e.target.value)} />
        <Input type="password" autoComplete="new-password" label="Repeat it" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button type="submit" variant="outline" loading={busy} disabled={next.length < 8}>
          Change
        </Button>
      </form>
      <ErrorNote>{error}</ErrorNote>
    </Section>
  );
}
