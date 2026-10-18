// Downloads Hopin's free media once, processes it with ffmpeg and writes public/media.
//   node scripts/fetch-media.js        (or: npm run media)
// Sources are free to use: Pexels (Pexels License), LottieFiles (Lottie Simple License) and
// unDraw (unDraw License). Nothing is hotlinked: the app only loads files from /media.
// PEXELS_API_KEY / UNSPLASH_ACCESS_KEY / PIXABAY_API_KEY are not needed for this list: every
// asset below has a direct, public download URL. Re-running skips files already downloaded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'media-src'); // originals (git-ignored)
const OUT = path.join(ROOT, 'public', 'media');
const ACCENT = '#ffc21a';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36' };

// A warm, slightly lifted grade so footage and photos sit with the taxi-yellow palette.
const GRADE = 'eq=contrast=1.05:saturation=1.08:gamma=1.02,colorbalance=rs=0.05:gs=0.015:bs=-0.06:rm=0.04:gm=0.01:bm=-0.05';

const VIDEO = {
  id: 'login-kolkata',
  url: 'https://videos.pexels.com/video-files/32665224/13926744_1280_720_24fps.mp4',
  page: 'https://www.pexels.com/video/bustling-kolkata-street-with-iconic-yellow-taxis-32665224/',
  title: 'Bustling Kolkata street with iconic yellow taxis',
  start: 1, // seconds into the clip
  length: 10,
};

const PHOTOS = [
  { id: 'onboard-book', pexels: 14178831, title: 'Yellow taxi speeding through the streets of Kolkata', page: 'https://www.pexels.com/photo/a-yellow-taxi-on-the-road-14178831/' },
  { id: 'onboard-safe', pexels: 33448009, title: 'Yellow taxi at Sealdah Station, Kolkata, by night', page: 'https://www.pexels.com/photo/iconic-yellow-taxi-at-sealdah-station-by-night-33448009/' },
  { id: 'onboard-pay', pexels: 4199524, title: 'Making a payment with a smartphone', page: 'https://www.pexels.com/photo/making-a-payment-with-a-smartphone-4199524/' },
];
const WIDTHS = [480, 960, 1440];

// `recolor`: [hue range in degrees, target colour] pairs; matching colours take the target's hue
// and saturation but keep their own lightness, so gradients and shading survive.
const DONE = 'https://assets-v2.lottiefiles.com/a/ea8932a4-86d0-4998-a37a-472e24f85c03/Zr7QGOrtRW.lottie';
const LOTTIES = [
  { id: 'searching', title: 'Radar animation', url: 'https://assets-v2.lottiefiles.com/a/facac14b-8b67-4be0-b6ee-dbc8b89fe9af/rYXsM1qRR6.lottie', page: 'https://lottiefiles.com/free-animation/radar-animation-rYXsM1qRR6', recolor: [[[170, 270], ACCENT]] },
  { id: 'payment-success', title: 'Done', url: DONE, page: 'https://lottiefiles.com/free-animation/done-Zr7QGOrtRW', recolor: [[[10, 60], '#1e8a52']] },
  { id: 'trip-complete', title: 'Done', url: DONE, page: 'https://lottiefiles.com/free-animation/done-Zr7QGOrtRW', recolor: [[[10, 60], ACCENT]] },
  { id: 'empty-trips', title: 'Empty box', url: 'https://assets-v2.lottiefiles.com/a/a8d23832-1503-4eee-989d-f2e63558ae73/KuoxLIaV8V.lottie', page: 'https://lottiefiles.com/free-animation/empty-box-KuoxLIaV8V' },
  { id: 'no-internet', title: 'No signal', url: 'https://assets-v2.lottiefiles.com/a/6f9189c0-116d-11ee-a120-df3a07386b76/oklN5U7R2e.lottie', page: 'https://lottiefiles.com/free-animations/no-internet' },
];

const ILLUSTRATIONS = [
  { id: 'order-a-ride', url: 'https://cdn.undraw.co/illustration/order-a-ride_cceg.svg' },
  { id: 'empty-mailbox', url: 'https://cdn.undraw.co/illustration/empty-mailbox_ef0e.svg' },
  { id: 'quality-time', url: 'https://cdn.undraw.co/illustration/quality-time_h2b9.svg' },
];

// ---- helpers --------------------------------------------------------------------------------
const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

async function download(url, file) {
  if (existsSync(file)) return file;
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`  downloaded ${path.basename(file)} (${kb(file)})`);
  return file;
}

// ---- Lottie recolouring ---------------------------------------------------------------------
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function rgbHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
}
/** Maps one 0–1 RGB colour through the rules; greys and unmatched hues are left alone. */
function mapColor(rgb, rules) {
  const [h, s, l] = rgbHsl(rgb);
  if (s < 0.15) return rgb;
  for (const [[lo, hi], hex] of rules) {
    if (h < lo || h > hi) continue;
    const [th, ts, tl] = rgbHsl(hexRgb(hex));
    // Keep the original's lightness relative to a mid tone, centred on the target's own lightness.
    return hslRgb([th, ts, Math.min(0.97, Math.max(0.05, tl + (l - 0.5) * 0.9))]);
  }
  return rgb;
}
/** Walks a Lottie document and recolours solid colours ("c") and gradient stops ("g"). */
function recolorLottie(node, rules) {
  if (Array.isArray(node)) return node.forEach((n) => recolorLottie(n, rules));
  if (!node || typeof node !== 'object') return;
  const fix = (arr) => {
    const out = mapColor(arr.slice(0, 3), rules);
    out.forEach((v, i) => (arr[i] = Math.round(v * 1000) / 1000));
  };
  if (node.c?.k && Array.isArray(node.c.k)) {
    if (typeof node.c.k[0] === 'number' && node.c.k.length >= 3) fix(node.c.k);
    else node.c.k.forEach((kf) => ['s', 'e'].forEach((p) => Array.isArray(kf?.[p]) && kf[p].length >= 3 && fix(kf[p])));
  }
  if (node.g?.k && typeof node.g.p === 'number') {
    const stops = (arr) => {
      for (let i = 0; i < node.g.p; i++) {
        const seg = arr.slice(i * 4 + 1, i * 4 + 4);
        mapColor(seg, rules).forEach((v, j) => (arr[i * 4 + 1 + j] = Math.round(v * 1000) / 1000));
      }
    };
    if (Array.isArray(node.g.k.k) && typeof node.g.k.k[0] === 'number') stops(node.g.k.k);
    else if (Array.isArray(node.g.k.k)) node.g.k.k.forEach((kf) => ['s', 'e'].forEach((p) => Array.isArray(kf?.[p]) && stops(kf[p])));
  }
  Object.values(node).forEach((v) => recolorLottie(v, rules));
}

/** The first animation JSON inside a .lottie (a zip). Enough of a zip reader for that. */
function lottieJson(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a .lottie zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // dotLottie v1 keeps animations in animations/, v2 in a/.
    if (!/^(animations|a)\/.+\.json$/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
  }
  throw new Error('no animation in .lottie');
}

// ---- run ---------------------------------------------------------------------------------------
for (const d of [RAW, OUT, path.join(OUT, 'onboarding'), path.join(OUT, 'lottie'), path.join(OUT, 'illustrations')]) mkdirSync(d, { recursive: true });
const manifest = { video: {}, photos: {}, lottie: {}, illustrations: {} };

console.log('Video');
{
  const src = await download(VIDEO.url, path.join(RAW, `${VIDEO.id}-720.mp4`));
  const base = path.join(OUT, VIDEO.id);
  const cut = ['-ss', String(VIDEO.start), '-t', String(VIDEO.length), '-i', src, '-an', '-vf', `scale=-2:720,${GRADE}`];
  // The login screen's budget is 1.5 MB in all, so the clip is capped near 1 Mbit/s (~1.2 MB for 10 s).
  // A light blur-free denoise first: busy street footage compresses far better without grain.
  const quiet = [...cut.slice(0, -1), `scale=-2:720,hqdn3d=2:2:6:6,${GRADE}`];
  ff(...quiet, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-crf', '30', '-maxrate', '950k', '-bufsize', '1900k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`);
  // VP9 overshoots in one pass on busy footage; two passes hold the target.
  const vp9 = ['-c:v', 'libvpx-vp9', '-b:v', '700k', '-maxrate', '900k', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-passlogfile', path.join(RAW, 'vp9')];
  ff(...quiet, ...vp9, '-pass', '1', '-f', 'null', devNull);
  ff(...quiet, ...vp9, '-pass', '2', `${base}.webm`);
  // Poster: the first graded frame, small enough to show instantly.
  ff('-ss', String(VIDEO.start), '-i', src, '-frames:v', '1', '-vf', `scale=-2:720,${GRADE}`, '-c:v', 'libwebp', '-quality', '48', `${base}-poster.webp`);
  ff('-ss', String(VIDEO.start), '-i', src, '-frames:v', '1', '-vf', `scale=-2:720,${GRADE}`, '-q:v', '6', `${base}-poster.jpg`);
  manifest.video = { mp4: `/media/${VIDEO.id}.mp4`, webm: `/media/${VIDEO.id}.webm`, poster: `/media/${VIDEO.id}-poster.webp`, posterJpg: `/media/${VIDEO.id}-poster.jpg` };
  console.log(`  mp4 ${kb(`${base}.mp4`)} · webm ${kb(`${base}.webm`)} · poster ${kb(`${base}-poster.webp`)}`);
}

console.log('Photos');
for (const p of PHOTOS) {
  const src = await download(`https://images.pexels.com/photos/${p.pexels}/pexels-photo-${p.pexels}.jpeg?auto=compress&cs=tinysrgb&w=2000`, path.join(RAW, `${p.id}.jpg`));
  const out = { webp: [], avif: [] };
  for (const w of WIDTHS) {
    const f = path.join(OUT, 'onboarding', `${p.id}-${w}`);
    ff('-i', src, '-vf', `scale=${w}:-2,${GRADE}`, '-c:v', 'libwebp', '-quality', '72', `${f}.webp`);
    ff('-i', src, '-vf', `scale=${w}:-2,${GRADE},format=yuv420p`, '-frames:v', '1', '-c:v', 'libsvtav1', '-crf', '38', '-still-picture', '1', `${f}.avif`);
    out.webp.push(`/media/onboarding/${p.id}-${w}.webp ${w}w`);
    out.avif.push(`/media/onboarding/${p.id}-${w}.avif ${w}w`);
  }
  // A tiny blurred placeholder, inlined, so the slide never flashes empty (blur-up).
  const lq = path.join(RAW, `${p.id}-lqip.webp`);
  ff('-i', src, '-vf', `scale=24:-2,${GRADE}`, '-c:v', 'libwebp', '-quality', '40', lq);
  out.placeholder = `data:image/webp;base64,${readFileSync(lq).toString('base64')}`;
  manifest.photos[p.id] = { ...out, webp: out.webp.join(', '), avif: out.avif.join(', '), fallback: `/media/onboarding/${p.id}-960.webp` };
  console.log(`  ${p.id}: 960w webp ${kb(path.join(OUT, 'onboarding', `${p.id}-960.webp`))}, avif ${kb(path.join(OUT, 'onboarding', `${p.id}-960.avif`))}`);
}

console.log('Lottie');
for (const l of LOTTIES) {
  const src = await download(l.url, path.join(RAW, `${path.basename(new URL(l.url).pathname)}`));
  const doc = JSON.parse(lottieJson(readFileSync(src)));
  if (l.recolor) recolorLottie(doc, l.recolor);
  const json = JSON.stringify(doc); // re-serialise: drops whitespace
  const file = path.join(OUT, 'lottie', `${l.id}.json`);
  writeFileSync(file, json);
  manifest.lottie[l.id] = `/media/lottie/${l.id}.json`;
  const size = statSync(file).size;
  console.log(`  ${l.id}: ${kb(file)}${size > 100 * 1024 ? '  OVER 100 KB' : ''}`);
}

console.log('Illustrations');
for (const i of ILLUSTRATIONS) {
  const src = await download(i.url, path.join(RAW, `${i.id}.svg`));
  // unDraw's default accent is #6c63ff; recolour it to Hopin's yellow.
  const svg = readFileSync(src, 'utf8').replace(/#6c63ff/gi, ACCENT);
  const file = path.join(OUT, 'illustrations', `${i.id}.svg`);
  writeFileSync(file, svg);
  manifest.illustrations[i.id] = `/media/illustrations/${i.id}.svg`;
  console.log(`  ${i.id}: ${kb(file)}`);
}

writeFileSync(path.join(ROOT, 'src', 'media.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const credits = `# Media credits

Every file here was downloaded by \`scripts/fetch-media.js\` from a free source and is served
from this folder (no hotlinking). Video and photos are colour-graded and re-encoded.

## Video — Pexels License (free to use, no attribution required)
- \`${VIDEO.id}.mp4\`, \`${VIDEO.id}.webm\`, posters — “${VIDEO.title}”, ${VIDEO.page}
  (720p, ${VIDEO.length} s cut from ${VIDEO.start} s, muted)

## Photos — Pexels License
${PHOTOS.map((p) => `- \`onboarding/${p.id}-*\` — “${p.title}”, ${p.page}`).join('\n')}

## Animations — LottieFiles, Lottie Simple License (free, attribution not required)
${LOTTIES.map((l) => `- \`lottie/${l.id}.json\` — “${l.title}”, ${l.page}`).join('\n')}

## Illustrations — unDraw License (free, attribution not required); recoloured to ${ACCENT}
${ILLUSTRATIONS.map((i) => `- \`illustrations/${i.id}.svg\` — ${i.url}`).join('\n')}

Licences: https://www.pexels.com/license/ · https://lottiefiles.com/page/license · https://undraw.co/license
`;
writeFileSync(path.join(OUT, 'CREDITS.md'), credits);
console.log('Wrote public/media/CREDITS.md and src/media.json');
