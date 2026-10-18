import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, CreditCard, ShieldCheck, Zap } from 'lucide-react';
import media from '../media.json';
import { useT } from '../i18n/index.js';
import { Button } from '../ds/index.js';
import { Logo } from './Shell.jsx';
import LanguageSwitch from './LanguageSwitch.jsx';

const KEY = 'hopin.onboarded';
export const onboarded = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true; // no storage: don't trap people in the intro
  }
};
const markOnboarded = () => {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* ignore */
  }
};

const SLIDES = [
  { id: 'onboard-book', icon: Zap, title: 'onb.book.title', body: 'onb.book.body' },
  { id: 'onboard-safe', icon: ShieldCheck, title: 'onb.safe.title', body: 'onb.safe.body' },
  { id: 'onboard-pay', icon: CreditCard, title: 'onb.pay.title', body: 'onb.pay.body' },
];

/** Responsive photo with AVIF/WebP srcset and a blurred placeholder that sharpens on load. */
function Photo({ id, eager }) {
  const p = media.photos[id];
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="absolute inset-0 overflow-hidden bg-ink" style={{ backgroundImage: `url(${p.placeholder})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
      <div className="absolute inset-0 backdrop-blur-xl" aria-hidden style={{ opacity: loaded ? 0 : 1, transition: 'opacity 300ms' }} />
      <picture>
        <source type="image/avif" srcSet={p.avif} sizes="(min-width: 1024px) 60vw, 100vw" />
        <source type="image/webp" srcSet={p.webp} sizes="(min-width: 1024px) 60vw, 100vw" />
        <img
          src={p.fallback}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={eager ? 'high' : 'auto'}
          onLoad={() => setLoaded(true)}
          className="size-full object-cover"
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 300ms' }}
        />
      </picture>
    </div>
  );
}

/** First run only: three slides, then the sign-in screen. UI only; nothing is sent anywhere. */
export default function Onboarding({ onDone }) {
  const t = useT();
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;
  const finish = () => {
    markOnboarded();
    onDone();
  };
  const go = (n) => setI(Math.max(0, Math.min(SLIDES.length - 1, n)));
  const s = SLIDES[i];
  const Icon = s.icon;

  return (
    <div className="fixed inset-0 flex flex-col bg-ink text-[#f5f0e6] lg:flex-row" style={{ zIndex: 'var(--z-overlay)' }} role="region" aria-roledescription="carousel" aria-label="Welcome to Hopin">
      <div className="relative min-h-0 flex-1 overflow-hidden lg:flex-[1.2]">
        <AnimatePresence initial={false}>
          <motion.div
            key={s.id}
            className="absolute inset-0 touch-pan-y"
            initial={reduced ? false : { opacity: 0, scale: 1.03 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            drag={reduced ? false : 'x'}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.2}
            onDragEnd={(_e, info) => {
              if (info.offset.x < -60) go(i + 1);
              else if (info.offset.x > 60) go(i - 1);
            }}
          >
            <Photo id={s.id} eager={i === 0} />
          </motion.div>
        </AnimatePresence>
        {/* Warm ink scrim so the logo and controls read on any photo. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#17150f]/70 via-transparent to-[#17150f]/50" aria-hidden />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <span className="text-[#f5f0e6]">
            <Logo />
          </span>
          <button type="button" className="min-h-11 rounded-[var(--radius-sm)] bg-[#17150f]/60 px-4 text-small font-semibold" onClick={finish}>
            {t('onb.skip')}
          </button>
        </div>
      </div>

      <div className="shrink-0 space-y-5 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 lg:flex lg:w-[440px] lg:flex-col lg:justify-center lg:px-10">
        <div className="hidden lg:block">
          <LanguageSwitch />
        </div>
        <div aria-live="polite" className="min-h-[10rem] space-y-3">
          <span className="grid size-11 place-items-center rounded-[var(--radius-md)] bg-taxi text-ink" aria-hidden>
            <Icon className="size-5" />
          </span>
          <h1 className="font-display text-[2rem] font-bold leading-[1.1]">{t(s.title)}</h1>
          <p className="max-w-sm text-body text-[#cfc6b4]">{t(s.body)}</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex" role="tablist" aria-label="Slides">
            {SLIDES.map((x, n) => (
              <button key={x.id} type="button" role="tab" aria-selected={n === i} aria-label={`Slide ${n + 1} of ${SLIDES.length}`} onClick={() => go(n)} className="grid size-11 place-items-center">
                <span className={`block h-2 rounded-full transition-all duration-[var(--dur-base)] ${n === i ? 'w-6 bg-taxi' : 'w-2 bg-[#f5f0e6]/40'}`} />
              </button>
            ))}
          </div>
          <Button variant="primary" size="lg" iconRight={ArrowRight} onClick={last ? finish : () => go(i + 1)}>
            {last ? t('onb.start') : t('onb.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
