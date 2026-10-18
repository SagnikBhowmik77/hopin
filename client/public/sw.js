/* Hopin service worker (step 9).
 *
 * - Push: shows ride notifications when Hopin's tab is closed or in the background. If a Hopin
 *   window is open and focused, the in-app toast already shows it, so the system one is skipped.
 * - Tap on a notification: focuses an open Hopin window on that page, or opens one.
 * - Offline: if a page can't load at all, shows a small offline page (with the 112 number).
 *   The app's code is NOT cached, so an old version can never get stuck on a phone.
 */

const OFFLINE = '/offline.html';
const CACHE = 'hopin-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([OFFLINE, '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Hopin', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (data.tag !== 'test' && windows.some((w) => w.focused)) return undefined;
      return self.registration.showNotification(data.title || 'Hopin', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: data.tag || undefined,
        data: { link: data.link || '/' },
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = new URL(event.notification.data?.link || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus().then((w) => (w && 'navigate' in w ? w.navigate(link) : w));
      return self.clients.openWindow(link);
    }),
  );
});
