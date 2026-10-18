import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { getLang, onLanguageChosen, setLang, useLang } from './i18n/index.js';
import { useSession } from './session.jsx';
import Shell from './components/Shell.jsx';
import { Toaster } from './components/ui.jsx';
import { RefreshCw, ServerCrash } from 'lucide-react';
import { Logo } from './components/Shell.jsx';
import AuthPage, { PhoneSignIn, ProfileSetup, ResetPassword } from './pages/AuthPage.jsx';
import { Button, EmptyState, Skeleton } from './ds/index.js';

// Each screen loads on first visit, so a rider never downloads the admin console and vice versa.
const Book = lazy(() => import('./pages/Book.jsx'));
const Drive = lazy(() => import('./pages/Drive.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const Trips = lazy(() => import('./pages/Trips.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Help = lazy(() => import('./pages/Help.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const Track = lazy(() => import('./pages/Track.jsx'));
const Family = lazy(() => import('./pages/Family.jsx'));
const CompanyPage = lazy(() => import('./components/Growth.jsx').then((m) => ({ default: m.CompanyPage })));
const DesignPreview = lazy(() => import('./pages/DesignPreview.jsx'));

const HOME = { rider: '/book', driver: '/drive', admin: '/admin' };

function Splash({ children }) {
  return <div className="grid h-full place-items-center bg-ground p-6 text-center">{children}</div>;
}

/** While a screen's code arrives: the shape of a page, not a spinner. */
function ScreenSkeleton() {
  return (
    <div role="status" aria-busy="true" className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-6 sm:px-6">
      <span className="sr-only">Loading</span>
      <Skeleton width="40%" height={30} />
      <Skeleton height={96} radius="var(--radius-lg)" />
      <Skeleton height={160} radius="var(--radius-lg)" />
    </div>
  );
}

export default function App() {
  const { status, error, user, setUser } = useSession();
  // Reading the language here re-renders every screen when it changes (step 10).
  useLang();
  // Signed in: the profile's language wins (notifications use it); switching saves it there.
  useEffect(() => {
    if (user?.language && user.language !== getLang()) setLang(user.language, { fromUser: false });
  }, [user?.language]);
  useEffect(() => {
    onLanguageChosen((language) => {
      if (user) api('/profile', { method: 'PATCH', body: { language } }).then((r) => setUser(r.user)).catch(() => {});
    });
  }, [user, setUser]);

  return (
    <>
      <Toaster />
      <Suspense fallback={<ScreenSkeleton />}>
      <Routes>
        {/* Public live-trip page shared over SMS / SOS - works without signing in. */}
        <Route path="/track/:token" element={<Track />} />
        {/* Design system review page: development builds only. */}
        {import.meta.env.DEV && (
          <Route
            path="/design-preview"
            element={
              <Suspense fallback={null}>
                <DesignPreview />
              </Suspense>
            }
          />
        )}
        {status === 'loading' && (
          <Route
            path="*"
            element={
              <Splash>
                <span role="status" aria-label="Loading Hopin" className="animate-pulse motion-reduce:animate-none">
                  <Logo size={44} />
                </span>
              </Splash>
            }
          />
        )}
        {status === 'error' && (
          <Route
            path="*"
            element={
              <Splash>
                <EmptyState
                  icon={ServerCrash}
                  tone="danger"
                  title="Hopin can’t start right now"
                  action={
                    <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
                      Try again
                    </Button>
                  }
                >
                  {error}
                </EmptyState>
              </Splash>
            }
          />
        )}
        {status === 'signedOut' && (
          <>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/forgot" element={<AuthPage mode="forgot" />} />
            <Route path="/phone" element={<PhoneSignIn />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        )}
        {status === 'recovery' && <Route path="*" element={<ResetPassword />} />}
        {status === 'needsProfile' && <Route path="*" element={<ProfileSetup />} />}
        {status === 'ready' && user && (
          <Route element={<Shell />}>
            {user.role === 'rider' && <Route path="/book" element={<Book />} />}
            {user.role === 'rider' && <Route path="/family" element={<Family />} />}
            {user.role === 'rider' && <Route path="/company" element={<CompanyPage />} />}
            {user.role === 'driver' && <Route path="/drive" element={<Drive />} />}
            {user.role === 'driver' && <Route path="/documents" element={<Documents />} />}
            {user.role === 'admin' && <Route path="/admin" element={<Admin />} />}
            {user.role !== 'admin' && <Route path="/trips" element={<Trips />} />}
            {user.role !== 'admin' && <Route path="/trips/:id" element={<Trips />} />}
            <Route path="/profile" element={<Profile />} />
            <Route path="/help" element={<Help />} />
            <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
          </Route>
        )}
      </Routes>
      </Suspense>
    </>
  );
}
