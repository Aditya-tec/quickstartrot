// Replaces the mutants of a `qsr mutate --all` result that ended as `harness_error` (the network failed twice) with the verdict of a
// later run of the same target alone (same seed, so the same mutant), and records which ones in `reruns`, so the document can say so.
//   node scripts/merge-mutate-reruns.mjs <full.json> <rerun-of-one-target.json>...
import { readFileSync, writeFileSync } from 'node:fs';

const [fullFile, ...redoFiles] = process.argv.slice(2);
if (!fullFile || redoFiles.length === 0) {
  process.stderr.write('usage: node scripts/merge-mutate-reruns.mjs <full.json> <rerun.json>...\n');
  process.exit(2);
}
const full = JSON.parse(readFileSync(fullFile, 'utf8'));
const reruns = full.reruns ?? [];
for (const file of redoFiles) {
  const redo = JSON.parse(readFileSync(file, 'utf8'));
  for (const m of redo.mutants) {
    const at = full.mutants.findIndex((x) => x.slug === m.slug && x.operator === m.operator);
    if (at < 0 || full.mutants[at].status !== 'harness_error' || m.status === 'harness_error')
      continue;
    full.mutants[at] = { ...m, retried: true };
    reruns.push({
      slug: m.slug,
      operator: m.operator,
      reason:
        'the network failed twice in the full run (a harness error); run again alone, same seed',
    });
  }
}
full.reruns = reruns;
writeFileSync(fullFile, `${JSON.stringify(full, null, 2)}\n`);
process.stdout.write(
  `${reruns.length} mutants replaced: ${reruns.map((r) => `${r.slug}:${r.operator}`).join(', ')}\n`,
);
