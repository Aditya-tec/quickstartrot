// Records the result of `qsr run <slug>` (scripts/batch-run.mjs keeps its output in .qsr-runs/<slug>.out.txt) in the
// target file and in the candidates record. For a PASS it enables the target and writes the notes from the run itself:
// the level reached, the steps the plan ran, the versions it resolved, and how the page was crawled. A target that did
// NOT pass is never enabled by this script: it needs a person's explanation (scripts/set-target.mjs).
//
//   node scripts/apply-run-result.mjs <slug> [--extra "a quirk worth keeping"] [--date 2026-10-17]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages/cli/package.json'));
const { parse } = require('yaml');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    extra: { type: 'string', default: '' },
    date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
  },
});
const slug = positionals[0];
if (!slug) throw new Error('usage: node scripts/apply-run-result.mjs <slug>');

const out = readFileSync(path.join(root, '.qsr-runs', `${slug}.out.txt`), 'utf8');
const result =
  /outcome:\s+(\S+)\s+reached level L(\d) of the target's L(\d)\s+\(([\d.]+)s in steps\)/.exec(out);
if (!result) throw new Error(`${slug}: no result line in the run output; read it by hand`);
const [, outcome, reached, target, secs] = result;
if (outcome !== 'PASS')
  throw new Error(`${slug}: the run was ${outcome}, not PASS; this script only records passes`);

const lines = out.split('\n');
const steps = lines
  .map((l) => /^\s+#\d+\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}(PASS|FAIL|SKIPPED)\s/.exec(l))
  .filter(Boolean)
  .filter((m) => m[2] !== 'harness_check')
  .map(
    (m) => `${m[2].replace('write_file', 'write').replace('append_file', 'append')} ${m[3].trim()}`,
  );
const checks = lines.filter(
  (l) => /^\s+#\d+\s+\S+\s+harness_check/.test(l) && /PASS/.test(l),
).length;
const resolved = /^\s+resolved\s+(.+)$/m.exec(out)?.[1]?.trim() ?? 'none recorded';
const image = /ref:\s+(\S+)/.exec(out)?.[1] ?? 'the standard image';
const blocks = /"msg":"crawl ok"/.test(out)
  ? /"blocks":(\d+)[^\n]*"msg":"crawl ok"/.exec(out)?.[1]
  : undefined;
const yamlText = readFileSync(path.join(root, 'targets', `${slug}.yaml`), 'utf8');
const t = parse(yamlText);

const summary = steps.join(' > ');
const notes =
  `Run ${values.date} (qsr run, local Docker, ${image.split('/').pop()}): PASS, reached L${reached} of L${target} in ${secs} s of steps. ` +
  `Plan: ${summary}${checks > 0 ? `, then the harness syntax and import checks (${checks} passed)` : ''}. ` +
  `Resolved: ${resolved}. ` +
  `Crawl: root '${t.extract.root}'${t.extract.tab ? `, tab '${t.extract.tab}'` : ''}${blocks ? `, ${blocks} blocks on the page` : ''}.` +
  (values.extra ? ` ${values.extra}` : '');

const r = spawnSync(
  process.execPath,
  [
    path.join(root, 'scripts/set-target.mjs'),
    slug,
    '--enabled',
    'true',
    '--level',
    String(target),
    '--notes',
    notes,
  ],
  { encoding: 'utf8' },
);
process.stdout.write(r.stdout + r.stderr);
