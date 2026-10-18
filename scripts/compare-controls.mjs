// Prints the v1-vs-v2 table of the unmutated controls (P9d).
//   node scripts/compare-controls.mjs <v1-results.json> <v2-controls.json>
// v1: the controls of an earlier `qsr mutate --all` run (harness before versioning). v2: `qsr mutate --all --controls-only`.
// Every PASS -> not-PASS flip is listed after the table: each one is investigated by hand, none is hidden.
import { readFileSync } from 'node:fs';

const [v1File, v2File] = process.argv.slice(2);
if (!v1File || !v2File) {
  process.stderr.write(
    'usage: node scripts/compare-controls.mjs <v1-results.json> <v2-controls.json>\n',
  );
  process.exit(2);
}
const v1 = new Map(JSON.parse(readFileSync(v1File, 'utf8')).controls.map((c) => [c.slug, c]));
const v2 = new Map(JSON.parse(readFileSync(v2File, 'utf8')).controls.map((c) => [c.slug, c]));

const word = (c) =>
  c === undefined
    ? '-'
    : c.outcome === 'PASS'
      ? `PASS L${c.reachedLevel}`
      : `${c.outcome ?? 'excluded'}`;
const slugs = [...new Set([...v1.keys(), ...v2.keys()])].sort();
const flips = [];
const rows = slugs.map((slug) => {
  const a = v1.get(slug);
  const b = v2.get(slug);
  const flip = a?.outcome === 'PASS' && b !== undefined && b.outcome !== 'PASS';
  if (flip) flips.push(slug);
  const note = flip ? `FLIP: ${b.excludedReason ?? ''}` : '';
  return `| ${slug} | ${word(a)} | ${word(b)} | ${note.replaceAll('|', '/')} |`;
});
process.stdout.write(
  [
    '| Target | v1 result | v2 result | Note |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `v1 PASS: ${[...v1.values()].filter((c) => c.outcome === 'PASS').length} of ${v1.size}; v2 PASS: ${[...v2.values()].filter((c) => c.outcome === 'PASS').length} of ${v2.size}; PASS -> not PASS: ${flips.length}${flips.length ? ` (${flips.join(', ')})` : ''}.`,
    '',
  ].join('\n'),
);
