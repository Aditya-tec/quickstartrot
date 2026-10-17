// Screens candidate docs pages for target selection (docs/TARGET-SELECTION.md). For each URL it checks robots.txt for
// QuickstartRotBot (the same check the crawler makes), loads the page in Chromium with the bot user agent, and reports
// how many code blocks it has, whether it has an install command, and which container selector holds the most of them.
// It fetches ONE page per candidate, one candidate at a time, with a pause. A local tool: nothing is stored anywhere.
//
//   node scripts/probe-docs-page.mjs <file.json> [slug ...]      file: [{ "slug": "...", "docsUrl": "https://..." }, ...]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const crawler = await import(pathToFileURL(path.join(root, 'packages/crawler/dist/index.js')).href);
const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/probe-docs-page.mjs <candidates.json> [slug ...]');
const only = new Set(process.argv.slice(3));
const candidates = JSON.parse(readFileSync(file, 'utf8')).filter(
  (c) => only.size === 0 || only.has(c.slug),
);
const botUrl = crawler.resolveBotUrl(process.env.BOT_INFO_URL);
const userAgent = crawler.botUserAgent(botUrl);

const SELECTORS = [
  'main article',
  'article',
  '[role=main]',
  'main',
  '#content',
  '#content-area',
  '.vp-doc',
  '.markdown',
  '.theme-doc-markdown',
  '.docs-content',
  '.prose',
  '.content',
  '.document',
  '.body',
  '#main-content',
  '.md-content',
  'body',
];
const INSTALL =
  /(npm (i|install)|yarn add|pnpm (add|i)|bun add|pip3? install|poetry add|uv add|npx |pnpm create)/i;

const fetchLike = async (url, init) => {
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, text: () => res.text() };
};

const browser = await crawler.launchBrowser();
const out = [];
try {
  for (const c of candidates) {
    const row = { slug: c.slug, url: c.docsUrl };
    try {
      await crawler.assertRobotsAllowed(c.docsUrl, userAgent, fetchLike);
      row.robots = 'allowed';
    } catch (err) {
      row.robots = `BLOCKED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120);
      out.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();
    try {
      const response = await page.goto(c.docsUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      row.status = response?.status() ?? 0;
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      row.finalUrl = page.url() === c.docsUrl ? undefined : page.url();
      const info = await page.evaluate(
        ({ selectors, installSource }) => {
          const install = new RegExp(installSource, 'i');
          const pres = [...document.querySelectorAll('pre')];
          const text = pres.map((p) => p.innerText);
          const roots = selectors
            .map((s) => {
              const els = [...document.querySelectorAll(s)];
              const el = els[0];
              if (!el) return null;
              return {
                selector: s,
                matches: els.length,
                pre: el.querySelectorAll('pre').length,
                chars: (el.innerText || '').length,
              };
            })
            .filter((r) => r && r.pre > 0);
          return {
            title: document.title.slice(0, 80),
            h1: (document.querySelector('h1')?.innerText ?? '').slice(0, 80),
            pre: pres.length,
            install: text.some((t) => install.test(t)),
            roots,
            tabs: [...document.querySelectorAll('[role=tab]')]
              .map((t) => t.innerText.trim())
              .filter(Boolean)
              .slice(0, 12),
          };
        },
        { selectors: SELECTORS, installSource: INSTALL.source },
      );
      Object.assign(row, info);
    } catch (err) {
      row.error = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    } finally {
      await context.close();
    }
    out.push(row);
    console.log(JSON.stringify(row));
    await new Promise((r) => setTimeout(r, 1500));
  }
} finally {
  await browser.close();
}
void createRequire;
