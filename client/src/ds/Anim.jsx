import { Suspense, lazy, useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import media from '../media.json';

// lottie-react (and lottie-web inside it) loads only when an animation is first shown.
const Lottie = lazy(() => import('lottie-react'));
const cache = new Map();

function useAnimation(name) {
  const url = media.lottie[name];
  const [data, setData] = useState(() => cache.get(url) ?? null);
  useEffect(() => {
    if (!url || cache.has(url)) return undefined;
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json) return;
        cache.set(url, json);
        if (live) setData(json);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  return data;
}

/**
 * A decorative Lottie animation from public/media/lottie (see scripts/fetch-media.js).
 * Hidden from screen readers; the text next to it carries the meaning. With reduced motion
 * it shows the last frame, still. Reserves its box while loading so nothing jumps.
 */
export function Anim({ name, size = 96, loop = false, className = '', style }) {
  const reduced = useReducedMotion();
  const data = useAnimation(name);
  const box = { width: size, height: size, ...style };
  return (
    <span aria-hidden className={`inline-block shrink-0 ${className}`} style={box}>
      {data && (
        <Suspense fallback={null}>
          <Lottie
            animationData={data}
            loop={reduced ? false : loop}
            autoplay={!reduced}
            initialSegment={reduced ? [data.op - 1, data.op] : undefined}
            style={{ width: '100%', height: '100%' }}
            rendererSettings={{ preserveAspectRatio: 'xMidYMid meet' }}
          />
        </Suspense>
      )}
    </span>
  );
}

/** An unDraw illustration (recoloured to the accent by fetch-media.js). */
export function Illustration({ name, width = 200, className = '' }) {
  const src = media.illustrations[name];
  if (!src) return null;
  return <img src={src} alt="" aria-hidden width={width} loading="lazy" decoding="async" className={`h-auto max-w-full ${className}`} style={{ width }} />;
}
