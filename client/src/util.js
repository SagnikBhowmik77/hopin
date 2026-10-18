import { useEffect, useState } from 'react';
import { getLang, localized, t } from './i18n/index.js';
import { Banknote, Briefcase, Clock, CreditCard, Landmark, Smartphone, Wallet } from 'lucide-react';
import { VEHICLE_ICON } from './ds/icons.jsx';

export const rupees = (n) => `₹${Math.round(n ?? 0).toLocaleString('en-IN')}`;

// These tables follow the chosen language (step 10): VEHICLE_META.car.label is "Cab" or "कैब".
// `icon` is a lucide component: render it as <meta.icon />, never as text.
const VEHICLE_ICONS = VEHICLE_ICON;
export const VEHICLE_META = localized((tr) =>
  Object.fromEntries(Object.entries(VEHICLE_ICONS).map(([type, icon]) => [type, { label: tr(`vehicle.${type}`), icon, blurb: tr(`vehicle.${type}.blurb`) }])),
);

const PAYMENT_ICONS = { cash: Banknote, upi: Smartphone, card: CreditCard, wallet: Wallet };
export const PAYMENT_META = localized((tr) => Object.fromEntries(Object.entries(PAYMENT_ICONS).map(([m, icon]) => [m, { label: tr(`pay.${m}`), icon }])));

/** For showing how something WAS paid: includes the extra methods Razorpay can report. */
const PAID_ICONS = { ...PAYMENT_ICONS, netbanking: Landmark, online_wallet: Wallet, emi: CreditCard, corporate: Briefcase, paylater: Clock };
export const PAID_VIA = localized((tr) => Object.fromEntries(Object.entries(PAID_ICONS).map(([m, icon]) => [m, { label: tr(`pay.${m}`), icon }])));

export const STATUS_TEXT = localized((tr) =>
  Object.fromEntries(['scheduled', 'requested', 'accepted', 'arrived', 'ongoing', 'completed', 'cancelled'].map((s) => [s, tr(`status.${s}`)])),
);

export const REVIEW_TAGS = {
  good: ['Safe driving', 'Clean vehicle', 'Polite', 'On time', 'Knew the route'],
  bad: ['Rash driving', 'Late pickup', 'Rude'],
};

// Fallback map centre when the browser will not share a location (Kolkata).
export const DEFAULT_CENTER = { lat: 22.5726, lng: 88.3639 };

export function getBrowserLocation(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

const locale = () => (getLang() === 'hi' ? 'hi-IN' : 'en-IN');

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t('time.today', { time }) : `${d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}, ${time}`;
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('time.justNow');
  if (s < 3600) return t('time.minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hAgo', { n: Math.floor(s / 3600) });
  return when(iso);
}

export const shortPlace = (p) => p?.address?.split(',')[0] ?? '';

/** Seconds elapsed since `iso`, ticking once a second. */
export function useElapsed(iso) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000)) : 0;
}

/** Free Google Maps directions link (no API key) for drivers who want turn-by-turn. */
export function navigationUrl(points) {
  const fmt = (p) => `${p.lat},${p.lng}`;
  const [origin, ...rest] = points;
  const destination = rest.pop();
  const params = new URLSearchParams({ api: '1', origin: fmt(origin), destination: fmt(destination), travelmode: 'driving' });
  if (rest.length) params.set('waypoints', rest.map(fmt).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

/** Shrinks a picked image to a 256px square JPEG data URL for the avatar. */
export function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const s = Math.min(img.width, img.height);
      canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('That file is not an image'));
    img.src = URL.createObjectURL(file);
  });
}
