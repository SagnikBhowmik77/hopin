import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { ArrowRight, MailCheck, MapPinned, ShieldCheck, Smartphone } from 'lucide-react';
import { post } from '../api.js';
import { useSession } from '../session.jsx';
import { Logo } from '../components/Shell.jsx';
import { ErrorNote } from '../components/ui.jsx';
import Onboarding, { onboarded } from '../components/Onboarding.jsx';
import { Button, Input, Notice } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { VEHICLE_META } from '../util.js';
import media from '../media.json';
import { getLang, useT } from '../i18n/index.js';
import LanguageSwitch from '../components/LanguageSwitch.jsx';

const MIN_PASSWORD = 8;

/** Plays the Kolkata clip only when it's cheap to: not with reduced motion, Save-Data or a slow link. */
function useVideoAllowed() {
  const reduced = useReducedMotion();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const c = navigator.connection;
    const slow = c && (c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType));
    setOk(!reduced && !slow);
  }, [reduced]);
  return ok;
}

/** Background footage: graded 10-second loop, muted, with its poster shown first. */
function HeroMedia() {
  const play = useVideoAllowed();
  const v = media.video;
  return (
    <div className="absolute inset-0 bg-ink" aria-hidden>
      {play ? (
        <video className="size-full object-cover" autoPlay muted loop playsInline preload="auto" poster={v.poster}>
          <source src={v.webm} type="video/webm" />
          <source src={v.mp4} type="video/mp4" />
        </video>
      ) : (
        <img className="size-full object-cover" src={v.poster} alt="" decoding="async" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-[#17150f] via-[#17150f]/55 to-[#17150f]/30" />
    </div>
  );
}

const FEATURES = [
  ['auth.featureVehicles', VEHICLE_ICON.car],
  ['auth.featureTracking', MapPinned],
  ['auth.featureSafety', ShieldCheck],
];

function AuthLayout({ children }) {
  const t = useT();
  return (
    <div className="min-h-full bg-ground lg:grid lg:h-full lg:grid-cols-[1.1fr_1fr]">
      {/* Phones: a short hero band. Desktop: the whole left half. */}
      <aside className="relative flex h-[34svh] min-h-60 flex-col justify-between overflow-hidden px-5 pb-10 pt-[max(1rem,env(safe-area-inset-top))] text-[#f5f0e6] lg:h-auto lg:p-12">
        <HeroMedia />
        <div className="relative flex items-center justify-between">
          <Logo />
          <span className="lg:hidden">
            <LanguageSwitch className="!bg-[#17150f]/60 [&_button[aria-checked=false]]:!text-[#e8dfcc]" />
          </span>
        </div>
        <div className="relative">
          <p className="mb-2 text-caption font-semibold uppercase tracking-[0.08em] text-taxi">{t('auth.heroKicker')}</p>
          <h1 className="font-display text-[2rem] font-bold leading-[1.05] sm:text-[2.5rem] lg:text-[3.5rem]">
            {t('auth.heroTitle1')} <span className="text-taxi">{t('auth.heroTitle2')}</span>
          </h1>
          <p className="mt-4 hidden max-w-md text-body text-[#e8dfcc] lg:block">{t('auth.heroSub')}</p>
          <ul className="mt-8 hidden gap-3 lg:grid lg:grid-cols-3">
            {FEATURES.map(([k, Icon]) => (
              <li key={k} className="flex items-center gap-2 text-small font-medium text-[#e8dfcc]">
                <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-taxi text-ink">
                  <Icon aria-hidden className="size-[18px]" />
                </span>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="relative -mt-5 rounded-t-[var(--radius-xl)] bg-ground px-5 pb-10 pt-7 sm:px-10 lg:mt-0 lg:flex lg:items-center lg:justify-center lg:overflow-y-auto lg:rounded-none lg:py-12">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 hidden justify-end lg:flex">
            <LanguageSwitch />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function GoogleButton({ supabase }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    // On success the browser leaves for Google, so only failures land here.
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="outline" size="lg" block icon={busy ? undefined : GoogleMark} loading={busy} onClick={go}>
        {t('auth.google')}
      </Button>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}

function Heading({ title, children }) {
  return (
    <div className="mb-7">
      <h2 className="font-display text-[1.75rem] font-bold leading-tight sm:text-[2rem]">{title}</h2>
      {children && <p className="mt-1.5 text-fg-2">{children}</p>}
    </div>
  );
}

/** Sign in, sign up and "forgot password", all handled by Supabase Auth. */
export default function AuthPage({ mode }) {
  const { supabase, providers } = useSession();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [intro, setIntro] = useState(() => mode === 'login' && !onboarded()); // display only
  const origin = window.location.origin;

  const run = async (fn) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setUnconfirmed(/not confirmed/i.test(error.message));
          setError(/not confirmed/i.test(error.message) ? t('auth.errConfirm') : error.message);
        }
        // On success the session listener takes over.
      } else if (mode === 'register') {
        if (password.length < MIN_PASSWORD) return setError(t('auth.errPasswordShort', { min: MIN_PASSWORD }));
        if (password !== confirm) return setError(t('auth.errPasswordMismatch'));
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: origin } });
        if (error) return setError(error.message);
        // With email confirmation on, Supabase returns no session until the link is clicked.
        if (!data.session) setNotice(t('auth.noticeConfirm', { email }));
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin });
        if (error) return setError(error.message);
        setNotice(t('auth.noticeReset', { email }));
      }
    });
  };

  const resend = () =>
    run(async () => {
      const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: origin } });
      if (error) setError(error.message);
      else setNotice(t('auth.noticeResent', { email }));
    });

  if (intro) return <Onboarding onDone={() => setIntro(false)} />;

  const social = mode !== 'forgot' && providers?.google;
  return (
    <AuthLayout>
      <Heading title={t(`auth.title.${mode}`)}>
        {mode === 'login' ? t('auth.newHere') : t('auth.haveAccount')}
        <Link className="font-semibold text-fg underline underline-offset-4" to={mode === 'login' ? '/register' : '/login'}>
          {mode === 'login' ? t('auth.signUp') : t('auth.signIn')}
        </Link>
      </Heading>

      {notice ? (
        <Notice role="status" icon={MailCheck} tone="success">
          <p className="font-semibold">{notice}</p>
        </Notice>
      ) : (
        <>
          {social && (
            <div className="space-y-3">
              <GoogleButton supabase={supabase} />
              {mode === 'login' && providers?.phone && (
                <Button as={Link} to="/phone" variant="outline" size="lg" block icon={Smartphone}>
                  {t('auth.phoneSignIn')}
                </Button>
              )}
              <div className="flex items-center gap-3 py-1 text-caption text-fg-2">
                <span className="h-px flex-1 bg-line" /> {t('auth.orEmail')} <span className="h-px flex-1 bg-line" />
              </div>
            </div>
          )}
          <form className={`${social ? 'mt-3' : ''} space-y-4`} onSubmit={submit}>
            <Input id="email" type="email" label={t('auth.email')} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} required />
            {mode !== 'forgot' && (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label className="ds-label" htmlFor="password">
                    {t('auth.password')}
                  </label>
                  {mode === 'login' && (
                    <Link to="/forgot" className="inline-flex min-h-9 items-center text-small font-semibold text-fg-2 hover:text-fg">
                      {t('auth.forgot')}
                    </Link>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            )}
            {mode === 'register' && (
              <Input
                id="confirm"
                type="password"
                label={t('auth.repeatPassword')}
                hint={t('auth.passwordHint', { min: MIN_PASSWORD })}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            )}
            <ErrorNote>{error}</ErrorNote>
            {unconfirmed && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={resend}>
                {t('auth.resend')}
              </Button>
            )}
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!supabase} iconRight={ArrowRight}>
              {mode === 'login' ? t('auth.signIn') : mode === 'register' ? t('auth.createAccount') : t('auth.sendReset')}
            </Button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}

/**
 * Sign in with an SMS code. Only for numbers already verified on a Hopin account
 * (shouldCreateUser: false) - new accounts start with email or Google.
 */
export function PhoneSignIn() {
  const { supabase } = useSession();
  const t = useT();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const e164 = `+91${phone}`;

  const send = async (e) => {
    e?.preventDefault();
    setError('');
    if (!/^[6-9]\d{9}$/.test(phone)) return setError(t('auth.phone.errMobile'));
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ phone: e164, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) return setError(/signups not allowed|not found/i.test(error.message) ? t('auth.phone.errNoAccount') : error.message);
    setSent(true);
  };

  const verify = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ phone: e164, token: code, type: 'sms' });
    setBusy(false);
    if (error) setError(error.message);
    // On success the session listener signs you in.
  };

  return (
    <AuthLayout>
      <Heading title={t('auth.phone.title')}>
        {t('auth.phone.sub')}{' '}
        <Link className="font-semibold text-fg underline underline-offset-4" to="/login">
          {t('auth.phone.useEmail')}
        </Link>
      </Heading>
      {!sent ? (
        <form className="space-y-4" onSubmit={send}>
          <Input
            id="m-phone"
            label={t('auth.phone.mobile')}
            prefix="+91"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
            required
          />
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!supabase}>
            {t('auth.phone.sendCode')}
          </Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={verify}>
          <Input
            id="m-code"
            label={t('auth.phone.codeSentTo', { phone: e164 })}
            className="[&_input]:text-center [&_input]:font-display [&_input]:text-[1.5rem] [&_input]:font-bold [&_input]:tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length < 4}>
            {t('auth.signIn')}
          </Button>
          <button type="button" className="min-h-11 text-small font-semibold text-fg-2 underline underline-offset-2" onClick={send} disabled={busy}>
            {t('auth.phone.newCode')}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

/** First sign-in: the Hopin profile (name, mobile, rider/driver, vehicle). */
export function ProfileSetup() {
  const { identity, loadMe, signOut } = useSession();
  const t = useT();
  const [role, setRole] = useState('rider');
  const [form, setForm] = useState({ name: identity?.name ?? '', phone: '', vtype: 'car', model: '', plate: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await post('/auth/profile', {
        name: form.name,
        phone: form.phone,
        role,
        // The language chosen on the sign-in screens becomes the account's language.
        language: getLang(),
        vehicle: role === 'driver' ? { type: form.vtype, model: form.model, plate: form.plate } : undefined,
      });
      await loadMe();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <Heading title={t('auth.setup.title')}>
        {t('auth.setup.signedInAs')} <strong className="text-fg">{identity?.email}</strong>.{' '}
        <button type="button" className="font-semibold underline underline-offset-4" onClick={signOut}>
          {t('auth.setup.notYou')}
        </button>
      </Heading>
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('auth.setup.iWantTo')}>
          {[
            ['rider', t('auth.setup.ride'), t('auth.setup.rideSub')],
            ['driver', t('auth.setup.drive'), t('auth.setup.driveSub')],
          ].map(([value, title, sub]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={role === value}
              onClick={() => setRole(value)}
              className={`min-h-16 rounded-[var(--radius-md)] px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] ${role === value ? 'bg-accent-soft ring-2 ring-fg' : 'bg-surface ring-1 ring-line hover:bg-raised'}`}
            >
              <span className="block font-semibold">{title}</span>
              <span className="block text-caption text-fg-2">{sub}</span>
            </button>
          ))}
        </div>
        <Input id="name" label={t('auth.setup.fullName')} autoComplete="name" value={form.name} onChange={set('name')} required />
        <Input
          id="phone"
          label={t('auth.phone.mobile')}
          hint={t('auth.setup.mobileHint')}
          prefix="+91"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          value={form.phone}
          onChange={set('phone')}
          required
        />
        {role === 'driver' && (
          <fieldset className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line">
            <legend className="px-1 text-small font-semibold">{t('auth.setup.vehicle')}</legend>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('auth.setup.vehicle')}>
              {Object.entries(VEHICLE_META).map(([type, m]) => {
                const Icon = VEHICLE_ICON[type];
                const on = form.vtype === type;
                return (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setForm((f) => ({ ...f, vtype: type }))}
                    className={`flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] transition-colors duration-[var(--dur-fast)] ${on ? 'bg-accent-soft ring-2 ring-fg' : 'ring-1 ring-line hover:bg-raised'}`}
                  >
                    <Icon aria-hidden className="size-6" />
                    <span className="text-small font-semibold">{m.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={t('auth.setup.modelLabel')} placeholder={t('auth.setup.model')} value={form.model} onChange={set('model')} required />
              <Input label={t('auth.setup.plateLabel')} placeholder={t('auth.setup.plate')} value={form.plate} onChange={(e) => setForm((f) => ({ ...f, plate: e.target.value.toUpperCase() }))} required />
            </div>
          </fieldset>
        )}
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" variant="primary" size="lg" block loading={busy} iconRight={ArrowRight}>
          {role === 'driver' ? t('auth.setup.startDriving') : t('auth.setup.startRiding')}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** After the "reset password" email link: choose a new password (Supabase updateUser). */
export function ResetPassword() {
  const { supabase, finishRecovery } = useSession();
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) return setError(t('auth.errPasswordShort', { min: MIN_PASSWORD }));
    if (password !== confirm) return setError(t('auth.errPasswordMismatch'));
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    finishRecovery();
  };

  return (
    <AuthLayout>
      <Heading title={t('auth.reset.title')} />
      <form className="space-y-4" onSubmit={submit}>
        <Input id="new-password" type="password" label={t('auth.reset.new')} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Input id="confirm-password" type="password" label={t('auth.reset.repeat')} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {t('auth.reset.save')}
        </Button>
      </form>
    </AuthLayout>
  );
}
