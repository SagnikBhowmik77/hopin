// Contact sheet for design review: tiles screenshots with their names into one image.
//   node scripts/sheet.mjs <out.png> <cols> <width> <file...>
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [out, cols = '4', width = '320', ...files] = process.argv.slice(2);
const cells = files
  .map((f) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${path.basename(f, '.png')}</figcaption></figure>`)
  .join('');
const html = `<!doctype html><style>
body{margin:0;padding:16px;background:#888;font:600 13px system-ui;display:grid;grid-template-columns:repeat(${cols},${width}px);gap:14px;align-items:start}
figure{margin:0}img{width:100%;display:block;border-radius:6px}figcaption{color:#fff;padding:4px 2px}
</style>${cells}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(cols) * (Number(width) + 14) + 32, height: 400 } });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
