// Diagnoses a page whose content hash changes between crawls: crawls the targets N times, T seconds apart, saves each
// extraction and its hash, and prints which blocks differ from the first crawl. It uses the real crawler and the real
// hash function and changes neither.
//
//   node scripts/crawl-drift.mjs ably-node ably-python [--times 5] [--gap 120] [--out .qsr-runs/drift]
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(root, 'packages/cli/package.json'));
const { parse } = req('yaml');
const { readFileSync } = await import('node:fs');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    times: { type: 'string', default: '5' },
    gap: { type: 'string', default: '120' },
    out: { type: 'string', default: '.qsr-runs/drift' },
  },
});
const crawler = await import(pathToFileURL(path.join(root, 'packages/crawler/dist/index.js')).href);
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const out = path.resolve(root, values.out);
mkdirSync(out, { recursive: true });
const botUrl = crawler.resolveBotUrl(process.env.BOT_INFO_URL);
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
};
const targets = positionals.map((slug) =>
  core.Target.parse(parse(readFileSync(path.join(root, 'targets', `${slug}.yaml`), 'utf8'))),
);
const browser = await crawler.launchBrowser();
try {
  for (let i = 1; i <= Number(values.times); i++) {
    for (const t of targets) {
      const e = await crawler.extract(t, { browser, log: logger, botUrl });
      writeFileSync(path.join(out, `${t.slug}-${i}.json`), JSON.stringify(e, null, 2));
      console.log(
        `${new Date().toISOString()} ${t.slug} crawl ${i}: hash ${e.contentHash.slice(0, 12)}, ${e.blocks.length} blocks`,
      );
    }
    if (i < Number(values.times))
      await new Promise((r) => setTimeout(r, Number(values.gap) * 1000));
  }
} finally {
  await browser.close();
}
