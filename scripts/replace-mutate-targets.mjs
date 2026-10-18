// Replaces the controls and mutants of whole targets in a `qsr mutate --all` result by those of a later run of each target alone (same seed,
// so the same mutants), and records which targets and why in `rerunTargets`, so the document can say so.
//   node scripts/replace-mutate-targets.mjs <full.json> "<reason>" <rerun-of-one-target.json>...
// Used when a target's level changed (harness v3: three targets stopped reaching L3) and only those were run again.
import { readFileSync, writeFileSync } from 'node:fs';

const [fullFile, reason, ...redoFiles] = process.argv.slice(2);
if (!fullFile || !reason || redoFiles.length === 0) {
  process.stderr.write(
    'usage: node scripts/replace-mutate-targets.mjs <full.json> "<reason>" <rerun.json>...\n',
  );
  process.exit(2);
}
const full = JSON.parse(readFileSync(fullFile, 'utf8'));
const rerunTargets = full.rerunTargets ?? [];
for (const file of redoFiles) {
  const redo = JSON.parse(readFileSync(file, 'utf8'));
  const slugs = new Set([...redo.controls.map((c) => c.slug), ...redo.mutants.map((m) => m.slug)]);
  for (const slug of slugs) {
    full.controls = [
      ...full.controls.filter((c) => c.slug !== slug),
      ...redo.controls.filter((c) => c.slug === slug),
    ];
    full.mutants = [
      ...full.mutants.filter((m) => m.slug !== slug),
      ...redo.mutants.filter((m) => m.slug === slug),
    ];
    // an earlier mutant-level re-run of this target is superseded by the whole-target replacement
    full.reruns = (full.reruns ?? []).filter((x) => x.slug !== slug);
    rerunTargets.push({ slug, reason });
  }
}
full.controls.sort((a, b) => (a.slug < b.slug ? -1 : 1));
full.rerunTargets = rerunTargets;
writeFileSync(fullFile, `${JSON.stringify(full, null, 2)}\n`);
process.stdout.write(
  `${rerunTargets.length} targets replaced: ${rerunTargets.map((r) => r.slug).join(', ')}\n`,
);
