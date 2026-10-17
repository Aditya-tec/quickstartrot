// One-off for `qsr mutate` (P9c): copies extractions that were ALREADY crawled (for example by scripts/crawl-drift.mjs, which
// writes <out>/<slug>-<n>.json) into the local plan cache as <cache>/<slug>/<hash>.extraction.json, where `qsr plans push` now
// leaves them. Nothing is fetched: this reads files only. The hash is recomputed with the target's own rules (hashIgnore), so the
// file lines up with the plan cached for the same page.
//
//   node scripts/backfill-extraction-cache.mjs .qsr-runs/crawl-all [--cache-dir .qsr-cache] [--targets targets]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'cache-dir': { type: 'string', default: '.qsr-cache' },
    targets: { type: 'string', default: 'targets' },
  },
});
const dir = positionals[0];
if (!dir)
  throw new Error(
    'usage: node scripts/backfill-extraction-cache.mjs <dir of <slug>-<n>.json> [--cache-dir d] [--targets d]',
  );
const require = createRequire(path.join(root, 'packages/cli/package.json'));
const { parse } = require('yaml');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const compiler = await import(
  pathToFileURL(path.join(root, 'packages/compiler/dist/index.js')).href
);

let written = 0;
let withPlan = 0;
const without = [];
for (const file of readdirSync(dir).sort()) {
  const m = /^(.+)-\d+\.json$/.exec(file);
  if (!m) continue;
  const slug = m[1];
  const targetFile = path.join(root, values.targets, `${slug}.yaml`);
  if (!existsSync(targetFile)) continue;
  const target = core.Target.parse(parse(readFileSync(targetFile, 'utf8')));
  const extraction = core.Extraction.parse(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
  const hash = core.contentHash(extraction.blocks, extraction.variants, target.extract.hashIgnore);
  const out = path.join(root, values['cache-dir'], slug);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, `${hash}.extraction.json`),
    JSON.stringify({ ...extraction, contentHash: hash }),
  );
  written += 1;
  const plan = path.join(out, `${hash}.${compiler.COMPILER_VERSION}.json`);
  if (existsSync(plan)) withPlan += 1;
  else without.push(slug);
}
console.log(
  `${written} extractions copied into ${values['cache-dir']}; ${withPlan} have a cached plan for the same page`,
);
if (without.length > 0)
  console.log(`no cached plan for the page as crawled: ${without.join(', ')}`);
