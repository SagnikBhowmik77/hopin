import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createClient } from '@supabase/supabase-js';
import { API_URL, api, currentToken, setTokenProvider } from './api.js';

/**
 * Sign-in is Supabase Auth: email + password (with email verification) or Google.
 * This provider owns the Supabase client, follows its auth events, and loads the
 * Hopin profile for whoever is signed in.
 *
 * status:
 *   loading       starting up
 *   error         the server or Supabase could not be reached (message in `error`)
 *   signedOut     nobody is signed in
 *   recovery      arrived from a "reset password" email; must choose a new password
 *   needsProfile  signed in, but no Hopin profile yet (first sign-in)
 *   ready         signed in with a profile (`user`)
 */
const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [supabase, setSupabase] = useState(null);
  const [providers, setProviders] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const recovering = useRef(false);

  const loadMe = useCallback(async () => {
    try {
      const me = await api('/auth/me');
      if (me.user) {
        setUser(me.user);
        setIdentity(null);
        setStatus('ready');
      } else {
        setUser(null);
        setIdentity(me.identity);
        setStatus('needsProfile');
      }
    } catch (err) {
      if (err.status === 401) {
        setUser(null);
        setStatus('signedOut');
      } else {
        setError(err.message);
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    let unsubscribe = () => {};
    (async () => {
      let cfg;
      try {
        cfg = await api('/auth/config');
      } catch (err) {
        setError(err.message);
        setStatus('error');
        return;
      }
      const client = createClient(cfg.supabaseUrl, cfg.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      });
      setTokenProvider(async () => (await client.auth.getSession()).data.session?.access_token ?? null);
      setProviders(cfg.providers);
      setSupabase(client);

      const { data } = client.auth.onAuthStateChange((event, session) => {
        // Supabase advises not to await its own calls inside this callback; defer instead.
        setTimeout(() => {
          if (event === 'PASSWORD_RECOVERY') {
            recovering.current = true;
            setStatus('recovery');
            return;
          }
          if (recovering.current && event !== 'SIGNED_OUT') return;
          if (!session) {
            setUser(null);
            setIdentity(null);
            setStatus('signedOut');
          } else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
            loadMe();
          }
        }, 0);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    })();
    return () => unsubscribe();
  }, [loadMe]);

  // One live connection per signed-in user. The token is read fresh on every
  // (re)connect, so an auto-refreshed token is picked up.
  useEffect(() => {
    if (status !== 'ready' || !user) return;
    const s = io(API_URL || undefined, { auth: (cb) => currentToken().then((token) => cb({ token })), transports: ['websocket', 'polling'] });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [status, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishRecovery = useCallback(() => {
    recovering.current = false;
    loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    recovering.current = false;
    await supabase?.auth.signOut();
  }, [supabase]);

  const value = useMemo(
    () => ({ supabase, providers, status, error, user, setUser, identity, loadMe, finishRecovery, signOut, socket, connected }),
    [supabase, providers, status, error, user, identity, loadMe, finishRecovery, signOut, socket, connected],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent(event, handler) {
  const { socket } = useSession();
  useEffect(() => {
    if (!socket) return;
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, [socket, event, handler]);
}
