// Loads the production build with the exact headers from vercel.json and reports
// Content-Security-Policy violations. Needs `npm run build` and the API on :8720.
//   node scripts/csp-check.mjs [/path ...]
import { chromium } from 'playwright';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
const headers = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
// Local preview is plain http; upgrading would break it.
headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace('; upgrade-insecure-requests', '');
delete headers['Strict-Transport-Security'];

const port = 4190;
const server = await preview({ preview: { port, strictPort: true, headers } });
const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['/login'];
const browser = await chromium.launch();
let failed = 0;
for (const p of paths) {
  const page = await browser.newPage();
  const violations = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${port}${p}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const title = await page.title();
  console.log(`${p} (${title}): ${violations.length ? `${violations.length} problem(s)` : 'no CSP violations'}`);
  violations.forEach((v) => console.log(`  ${v.slice(0, 220)}`));
  failed += violations.length;
  await page.close();
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
