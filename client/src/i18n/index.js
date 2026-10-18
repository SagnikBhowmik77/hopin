import { useCallback, useSyncExternalStore } from 'react';
import en from './en.js';
import hi from './hi.js';
import hiPhrases from './phrases.hi.js';

/**
 * Languages (step 10): English and Hindi. The choice is kept in this browser and, once signed
 * in, on the profile, so notifications and texts from Hopin's server use it too.
 * Text is looked up by key in en.js / hi.js; a key missing in Hindi falls back to English.
 */

const DICTS = { en, hi };
export const LANGUAGES = [
  ['en', 'English'],
  ['hi', 'हिन्दी'],
];
const KEY = 'hopin.lang';

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (DICTS[saved]) return saved;
  } catch {
    // storage blocked: fall through to the browser's language
  }
  return /^hi\b/i.test(navigator.language ?? '') ? 'hi' : 'en';
}

let lang = initial();
const listeners = new Set();
let onUserChange = null;
document.documentElement.lang = lang;

export const getLang = () => lang;

/** Switches language. `fromUser` changes are also saved to the signed-in profile. */
export function setLang(next, { fromUser = true } = {}) {
  if (!DICTS[next] || next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not remembered in this browser; the profile still keeps it
  }
  listeners.forEach((l) => l());
  if (fromUser) onUserChange?.(next);
}

/** Called with the new language whenever the person switches it (the app saves it to the profile). */
export const onLanguageChosen = (fn) => {
  onUserChange = fn;
};

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useLang = () => useSyncExternalStore(subscribe, getLang);

// Screen text can also be written as plain English (t('Choose a ride')): the English sentence is
// its own key, and PHRASES holds its translation. Anything missing shows in English.
const PHRASES = { hi: hiPhrases };

export function translate(l, key, vars) {
  const text = DICTS[l]?.[key] ?? PHRASES[l]?.[key] ?? en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : text;
}

/** Text in the current language, for code outside components. */
export const t = (key, vars) => translate(lang, key, vars);

/** `const t = useT()` in a component; it re-renders when the language changes. */
export function useT() {
  const l = useLang();
  return useCallback((key, vars) => translate(l, key, vars), [l]);
}

/**
 * A lookup table whose values follow the current language, e.g. STATUS_TEXT[ride.status].
 * `build(t)` returns the table; it is rebuilt when the language changes.
 */
export function localized(build) {
  const cache = {};
  const table = () => (cache[lang] ??= build((key, vars) => translate(lang, key, vars)));
  return new Proxy(
    {},
    {
      get: (_target, k) => table()[k],
      has: (_target, k) => k in table(),
      ownKeys: () => Reflect.ownKeys(table()),
      getOwnPropertyDescriptor: (_target, k) => (k in table() ? { enumerable: true, configurable: true, writable: false, value: table()[k] } : undefined),
    },
  );
}
