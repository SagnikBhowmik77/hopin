import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Bell as BellIcon, Car, FileText, History, LayoutDashboard, LifeBuoy, LogOut, Moon, Sun, UserRound, Users } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import { ago } from '../util.js';
import { Avatar, toast } from './ui.jsx';
import { t as tr, useT } from '../i18n/index.js';
import LanguageSwitch from './LanguageSwitch.jsx';
import { Anim, IconButton, Skeleton } from '../ds/index.js';
import { setTheme, useTheme } from '../ds/theme.js';

/** The Hopin mark: a yellow H on warm ink, like the roof light of a Kolkata taxi. */
export function Logo({ className = '', size = 32, wordmark = true }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <rect width="32" height="32" rx="9" fill="#17150f" />
        <path d="M10 8.5v15M22 8.5v15M10 16h12" stroke="#ffc21a" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      {wordmark && <span className="font-display text-[1.375rem] font-extrabold leading-none tracking-[-0.03em]">Hopin</span>}
    </span>
  );
}

// [path, i18n key, icon]
const NAV = {
  rider: [
    ['/book', 'nav.ride', Car],
    ['/trips', 'nav.trips', History],
    ['/family', 'nav.family', Users],
    ['/help', 'nav.help', LifeBuoy],
  ],
  driver: [
    ['/drive', 'nav.drive', Car],
    ['/documents', 'nav.documents', FileText],
    ['/trips', 'nav.trips', History],
    ['/help', 'nav.help', LifeBuoy],
  ],
  admin: [
    ['/admin', 'nav.dashboard', LayoutDashboard],
    ['/help', 'nav.help', LifeBuoy],
  ],
};

function Bell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    api('/profile/notifications')
      .then((d) => {
        setItems(d.notifications);
        setUnread(d.unread);
      })
      .catch(() => {});
  }, []);

  useSocketEvent(
    'notify',
    useCallback((n) => {
      setItems((list) => [n, ...list].slice(0, 30));
      setUnread((u) => u + 1);
      toast(
        <span>
          <strong>{n.title}</strong>
          {n.body && <span className="block opacity-80">{n.body}</span>}
        </span>,
      );
    }, []),
  );

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => !o);
    if (!open && unread) {
      setUnread(0);
      post('/profile/notifications/read').catch(() => {});
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="ds-btn ds-btn--ghost ds-iconbtn relative"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        title="Notifications"
      >
        <BellIcon aria-hidden />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[0.6875rem] font-bold leading-none text-danger-fg">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="fixed inset-x-3 top-16 max-h-[70dvh] overflow-y-auto rounded-[var(--radius-lg)] bg-surface sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96"
          style={{ boxShadow: 'var(--shadow-dialog)', zIndex: 'var(--z-overlay)' }}
        >
          <p className="px-4 pb-2 pt-4 font-display text-heading font-bold">{tr('Notifications')}</p>
          {items.length === 0 && <p className="px-4 pb-5 text-small text-fg-2">{tr('Nothing yet. Ride updates and payments show up here.')}</p>}
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              className="w-full border-t border-line px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-raised focus-visible:bg-raised"
              onClick={() => {
                setOpen(false);
                if (n.link) navigate(n.link);
              }}
            >
              <p className="text-small font-semibold">{n.title}</p>
              {n.body && <p className="line-clamp-2 text-small text-fg-2">{n.body}</p>}
              <p className="mt-1 text-caption text-fg-2">{ago(n.createdAt)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shows when the phone loses its connection; rides keep their state and resume. */
function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-warning-soft px-3 py-1.5 text-small font-semibold text-warning">
      <Anim name="no-internet" size={36} loop />
      {tr('You’re offline. Your ride is safe; we’ll update it when you’re back.')}
    </div>
  );
}

function ThemeButton() {
  const [, resolved] = useTheme();
  const dark = resolved === 'dark';
  return <IconButton icon={dark ? Sun : Moon} label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')} />;
}

export default function Shell() {
  const { user, connected, signOut } = useSession();
  const t = useT();
  const tabs = [...NAV[user.role], ['/profile', 'nav.profile', UserRound]];
  return (
    <div className="flex h-full flex-col bg-ground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:h-16 sm:gap-3 sm:px-5" style={{ zIndex: 'var(--z-header)' }}>
        <Link to="/" aria-label="Hopin home" className="rounded-[var(--radius-sm)] p-1">
          <Logo />
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV[user.role].map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-3 text-small font-semibold transition-colors duration-[var(--dur-fast)] ${
                  isActive ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-raised hover:text-fg'
                }`
              }
            >
              <Icon aria-hidden className="size-[18px]" />
              {t(label)}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <span
            className={`mr-1 hidden items-center gap-1.5 text-caption font-semibold md:inline-flex ${connected ? 'text-success' : 'text-fg-2'}`}
            title={connected ? t('nav.liveTitle') : t('nav.reconnecting')}
          >
            <span className={`size-2 rounded-full ${connected ? 'bg-success' : 'bg-line-strong'}`} />
            {connected ? t('nav.live') : t('nav.offline')}
          </span>
          <span className="hidden sm:block">
            <LanguageSwitch />
          </span>
          <span className="hidden sm:inline-flex">
            <ThemeButton />
          </span>
          <Bell />
          <Link to="/profile" className="hidden rounded-[var(--radius-md)] p-1 hover:bg-raised md:inline-flex" aria-label={t('nav.profile')}>
            <Avatar src={user.avatar} name={user.name} size={36} />
          </Link>
          <IconButton icon={LogOut} label={tr('Sign out')} onClick={signOut} className="hidden md:inline-flex" />
        </div>
      </header>
      <OfflineBanner />
      <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        <Suspense
          fallback={
            <div role="status" aria-busy="true" className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-6 sm:px-6">
              <span className="sr-only">Loading</span>
              <Skeleton width="40%" height={30} />
              <Skeleton height={96} radius="var(--radius-lg)" />
              <Skeleton height={160} radius="var(--radius-lg)" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      {/* Bottom tab bar on phones: thumb reach, labels under icons. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ zIndex: 'var(--z-header)' }}
      >
        {tabs.map(([to, label, Icon]) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `relative flex h-16 flex-1 flex-col items-center justify-center gap-0.5 text-[0.75rem] font-semibold transition-colors duration-[var(--dur-fast)] ${isActive ? 'text-fg' : 'text-fg-2'}`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-0 h-[3px] w-10 rounded-b-full bg-fg" aria-hidden />}
                <Icon aria-hidden className="size-[22px]" strokeWidth={isActive ? 2.4 : 2} />
                {t(label)}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
