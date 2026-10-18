import { useSyncExternalStore } from 'react';

/**
 * Light / dark / system theme. 'system' follows the phone; a choice is remembered on this device.
 * Sets <html data-theme> (read by styles.css) and the browser bar colour.
 */

const KEY = 'hopin.theme';
const BAR = { light: '#f6f2ea', dark: '#100f0c' };
const listeners = new Set();

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let choice = read();
const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
export const resolvedTheme = () => (choice === 'system' ? (systemDark() ? 'dark' : 'light') : choice);

export function applyTheme() {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  // One bar colour for the chosen theme; with 'system' the two media-tagged metas in index.html apply.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (choice === 'system') m.setAttribute('content', m.media.includes('dark') ? BAR.dark : BAR.light);
    else m.setAttribute('content', BAR[choice]);
  });
}

export function setTheme(next) {
  choice = next === 'light' || next === 'dark' ? next : 'system';
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // not remembered on this device
  }
  applyTheme();
  listeners.forEach((l) => l());
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => listeners.forEach((l) => l()));

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** ['system' | 'light' | 'dark', resolved 'light' | 'dark'] */
export function useTheme() {
  const c = useSyncExternalStore(subscribe, () => choice);
  const resolved = useSyncExternalStore(subscribe, resolvedTheme);
  return [c, resolved];
}
