// Lighthouse against the PRODUCTION build with seeded fixtures: `/` and one tool page, mobile and desktop.
// Run `pnpm build` first. Starts `next start` itself on LIGHTHOUSE_PORT (default 3102) unless LIGHTHOUSE_URL points
// at a server that is already running (for example the real site). Chromium comes from Playwright.
//   pnpm --filter @qsr/web lighthouse
// Reports go to apps/web/lighthouse-reports/ (git-ignored). Exits 1 if any score is below 90.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from '@playwright/test';
import lighthouse, { desktopConfig } from 'lighthouse';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'lighthouse-reports');
const port = Number(process.env.LIGHTHOUSE_PORT ?? 3102);
const external = process.env.LIGHTHOUSE_URL;
const base = external ?? `http://localhost:${port}`;
const PAGES = [
  { name: 'home', path: '/' },
  { name: 'tool', path: '/tools/chalk-node' },
];
const THRESHOLD = 90;

const waitForPort = (p, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect(p, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`nothing listened on ${p}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });

let server = null;
if (!external) {
  server = spawn(
    process.execPath,
    [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--port', String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        QSR_DATA: 'fixtures',
        NEXT_PUBLIC_SITE_URL: base,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: 'ignore',
    },
  );
  await waitForPort(port);
}

mkdirSync(outDir, { recursive: true });
const debugPort = 9333;
const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${debugPort}`],
});
const rows = [];
try {
  for (const form of ['mobile', 'desktop']) {
    for (const page of PAGES) {
      const result = await lighthouse(
        `${base}${page.path}`,
        { port: debugPort, output: 'json', logLevel: 'error' },
        form === 'desktop' ? desktopConfig : undefined,
      );
      if (!result) throw new Error('lighthouse returned nothing');
      const scores = Object.fromEntries(
        Object.entries(result.lhr.categories).map(([id, c]) => [
          id,
          Math.round((c.score ?? 0) * 100),
        ]),
      );
      writeFileSync(
        path.join(outDir, `${page.name}-${form}.json`),
        JSON.stringify(result.lhr, null, 2),
      );
      const failed = Object.values(result.lhr.audits)
        .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode === 'numeric')
        .map((a) => `${a.id}=${Math.round((a.score ?? 0) * 100)}`);
      rows.push({ page: page.path, form, ...scores, weak: failed });
    }
  }
} finally {
  await browser.close();
  server?.kill();
}

console.log('\nLighthouse (production build, fixtures)\n');
console.log(
  'page'.padEnd(20),
  'form'.padEnd(8),
  'perf'.padEnd(6),
  'a11y'.padEnd(6),
  'best'.padEnd(6),
  'seo'.padEnd(6),
);
let bad = false;
for (const r of rows) {
  const scores = [r.performance, r.accessibility, r['best-practices'], r.seo];
  if (scores.some((s) => s < THRESHOLD)) bad = true;
  console.log(
    r.page.padEnd(20),
    r.form.padEnd(8),
    String(r.performance).padEnd(6),
    String(r.accessibility).padEnd(6),
    String(r['best-practices']).padEnd(6),
    String(r.seo).padEnd(6),
    r.weak.length ? `below 90: ${r.weak.join(', ')}` : '',
  );
}
process.exit(bad ? 1 : 0);
