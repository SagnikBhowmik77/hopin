import { useSyncExternalStore } from 'react';
import { api, post } from './api.js';

/**
 * Installable app + push notifications (step 9). The service worker (public/sw.js) shows pushes
 * with Hopin closed; this file registers it, keeps Chrome's "install" prompt for a button, and
 * turns push on/off for this browser.
 */

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[pwa] service worker failed', err));
  });
}

// --- install prompt (Chrome/Edge/Android) -------------------------------------------------
let installEvent = null;
const listeners = new Set();
const changed = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini bar
    installEvent = e;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    changed();
  });
}
const subscribeInstall = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** The pending install prompt, or null when the browser isn't offering one (or it's installed). */
export const useInstallPrompt = () => useSyncExternalStore(subscribeInstall, () => installEvent);

export async function promptInstall() {
  const e = installEvent;
  if (!e) return 'unavailable';
  installEvent = null;
  changed();
  await e.prompt();
  return (await e.userChoice).outcome; // 'accepted' | 'dismissed'
}

export const isInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

// --- push ------------------------------------------------------------------------------------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** This browser's current push subscription, if any. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks permission, subscribes with Hopin's VAPID key, and saves it on the server. */
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error(isIOS() ? 'On iPhone, add Hopin to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there.' : 'This browser cannot show notifications.');
  }
  const { enabled, publicKey } = await api('/push');
  if (!enabled) throw new Error('Push notifications are not set up on this server.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  return post('/push/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
