import { ChevronRight, Circle, CircleCheck, Wallet } from 'lucide-react';
import { t as tr } from '../i18n/index.js';
import { PAYMENT_META, rupees } from '../util.js';

// Section ids on the Profile page, in order, for the "On this page" links.
const SECTIONS = {
  rider: [
    ['personal', 'Personal info'],
    ['wallet', 'Wallet & payments'],
    ['trip-pin', 'Trip PIN'],
    ['emergency', 'Emergency contacts'],
    ['places', 'Saved places'],
    ['rewards', 'Hopin Rewards'],
    ['refer', 'Refer & earn'],
    ['business', 'Business'],
    ['settings', 'App & settings'],
    ['password', 'Password'],
  ],
  driver: [
    ['personal', 'Personal info'],
    ['vehicle', 'Vehicle'],
    ['rating', 'Your rating'],
    ['emergency', 'Emergency contacts'],
    ['refer', 'Refer & earn'],
    ['hearing', 'Hearing'],
    ['settings', 'App & settings'],
    ['password', 'Password'],
  ],
  admin: [
    ['personal', 'Personal info'],
    ['settings', 'App & settings'],
    ['password', 'Password'],
  ],
};

const go = (id) => {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
};

/** Beside the profile on wide screens: what is set up on this account, and quick links to each part. */
export default function ProfileAside({ user }) {
  // Real account state only: each item is simply true or false on this profile right now.
  const checks = [
    [tr('Mobile number verified'), user.phoneVerified, 'personal'],
    user.role !== 'admin' && [tr('Emergency contact added'), user.emergencyContacts.length > 0, 'emergency'],
    [tr('Profile photo'), Boolean(user.avatar), 'personal'],
    user.role === 'rider' && [tr('Own trip PIN'), Boolean(user.tripPin), 'trip-pin'],
  ].filter(Boolean);
  const doneCount = checks.filter((c) => c[1]).length;
  const PayIcon = PAYMENT_META[user.defaultPayment]?.icon ?? Wallet;

  return (
    <>
      <section className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-5 ring-1 ring-line" aria-labelledby="setup-title">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="setup-title" className="font-display text-heading font-bold">
            {tr('Your account')}
          </h2>
          <span className="text-small font-semibold tabular-nums text-fg-2">
            {doneCount}/{checks.length}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
          <div className="h-full rounded-full bg-accent" style={{ width: `${(doneCount / checks.length) * 100}%` }} />
        </div>
        <ul className="space-y-0.5">
          {checks.map(([label, ok, target]) => (
            <li key={label}>
              <button type="button" onClick={() => go(target)} className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-sm)] px-2 text-left text-small hover:bg-raised">
                {ok ? <CircleCheck aria-hidden className="size-5 shrink-0 text-success" /> : <Circle aria-hidden className="size-5 shrink-0 text-line-strong" />}
                <span className={`flex-1 ${ok ? 'text-fg-2' : 'font-semibold'}`}>{label}</span>
                <span className="sr-only">{ok ? tr('Done') : tr('Not yet')}</span>
                {!ok && <ChevronRight aria-hidden className="size-4 text-fg-2" />}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {user.role !== 'admin' && (
        <button
          type="button"
          onClick={() => go(user.role === 'rider' ? 'wallet' : 'personal')}
          className="block w-full rounded-[var(--radius-lg)] bg-ink p-5 text-left text-[#f5f0e6] ring-1 ring-line-strong/40"
        >
          <span className="flex items-center justify-between">
            <span className="text-small text-[#cfc6b4]">{tr('Hopin Wallet')}</span>
            <Wallet aria-hidden className="size-5 text-taxi" />
          </span>
          <span className="mt-1 block font-display text-[2rem] font-bold leading-none tabular-nums">{rupees(user.walletBalance)}</span>
          {user.role === 'rider' && (
            <span className="mt-3 flex items-center gap-1.5 text-caption text-[#cfc6b4]">
              <PayIcon aria-hidden className="size-3.5" />
              {tr('Default payment')}: {PAYMENT_META[user.defaultPayment]?.label}
            </span>
          )}
        </button>
      )}

      <nav aria-label={tr('On this page')} className="hidden rounded-[var(--radius-lg)] bg-surface p-3 ring-1 ring-line lg:block">
        <p className="px-2 pb-1 pt-1 text-caption font-semibold uppercase tracking-[0.08em] text-fg-2">{tr('On this page')}</p>
        <ul>
          {SECTIONS[user.role].map(([id, label]) => (
            <li key={id}>
              <button type="button" onClick={() => go(id)} className="flex min-h-10 w-full items-center rounded-[var(--radius-sm)] px-2 text-left text-small font-medium text-fg-2 hover:bg-raised hover:text-fg">
                {tr(label)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
