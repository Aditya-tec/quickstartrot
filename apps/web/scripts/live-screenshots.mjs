// Screenshots of a RUNNING server (default: http://localhost:3103, the app built and started without QSR_DATA so it
// reads the real public views). Used to look at the real home page and a real tool page.
//   LIVE_URL=http://localhost:3103 node scripts/live-screenshots.mjs [tool-slug]
// Output: apps/web/screenshots/live/<page>-<width>.png (git-ignored).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.env.LIVE_URL ?? 'http://localhost:3103';
const tool = process.argv[2] ?? 'resend-node';
const out = path.join(import.meta.dirname, '..', 'screenshots', 'live');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const width of [1280, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const [name, url] of [
      ['home', '/'],
      [`tool-${tool}`, `/tools/${tool}`],
    ]) {
      const response = await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
      const file = path.join(out, `${name}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(response?.status(), file);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
