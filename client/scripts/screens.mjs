// Screenshots for design review: node scripts/screens.mjs <path> [name]
// Captures the page at 375px (phone) and 1280px (desktop), in light and dark, full height,
// into hopin/design/screens/. Needs the dev server on http://localhost:5190.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const route = process.argv[2] ?? '/design-preview';
const name = process.argv[3] ?? (route.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home');
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../design/screens');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const problems = [];
for (const [label, viewport] of [
  ['375', { width: 375, height: 812 }],
  ['1280', { width: 1280, height: 800 }],
]) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, isMobile: label === '375', hasTouch: label === '375' });
    await context.addInitScript((t) => localStorage.setItem('hopin.theme', t), theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${label}/${theme}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${label}/${theme} console: ${m.text()}`));
    await page.goto(`http://localhost:5190${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    // Horizontal scroll is a bug at any width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`${label}/${theme}: page is ${overflow}px wider than the screen`);
    const file = path.join(out, `${name}-${label}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('saved', path.relative(process.cwd(), file));
    await context.close();
  }
}
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no errors, no horizontal scroll');
