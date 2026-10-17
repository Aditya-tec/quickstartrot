// Renders the "Candidates and results" part of docs/TARGET-SELECTION.md from docs/target-candidates.json (the record
// scripts/set-target.mjs keeps) and the saved `qsr run` output of each enabled target (.qsr-runs/<slug>.out.txt, written
// by scripts/batch-run.mjs). The prose above the heading is hand-written and is left alone.
//
//   node scripts/render-target-selection.mjs [--date 2026-10-17]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: { date: { type: 'string', default: new Date().toISOString().slice(0, 10) } },
});
const candidates = JSON.parse(readFileSync(path.join(root, 'docs/target-candidates.json'), 'utf8'));
const docPath = path.join(root, 'docs/TARGET-SELECTION.md');
const HEADING = '## Candidates and results';

const cell = (s) =>
  String(s ?? '')
    .replaceAll('|', '/')
    .replaceAll('\n', ' ')
    .trim();
const ORDER = { enabled: 0, disabled: 1, excluded: 2, 'not-attempted': 3 };
const LABEL = {
  enabled: 'enabled',
  disabled: 'disabled',
  excluded: 'excluded',
  'not-attempted': 'not run',
};
const byStatus = Object.groupBy(candidates, (c) => c.status);
const n = (s) => (byStatus[s] ?? []).length;
const enabled = byStatus.enabled ?? [];
const groups = Object.groupBy(enabled, (c) => c.group);
const sample = enabled.filter((c) => c.group !== 'calibration');
const libShare = Math.round(((groups.library ?? []).length / sample.length) * 100);

function runLine(slug) {
  const f = path.join(root, '.qsr-runs', `${slug}.out.txt`);
  if (!existsSync(f)) return { text: 'no local run recorded', tokens: '' };
  const t = readFileSync(f, 'utf8');
  const m =
    /outcome:\s+(\S+)\s+reached level (L\d) of the target's (L\d)\s+\(([\d.]+)s in steps\)/.exec(t);
  let tokens = 0;
  for (const l of t.split('\n')) {
    if (!l.startsWith('{"level"')) continue;
    try {
      const j = JSON.parse(l);
      if (j.msg === 'llm call' && j.ok) tokens += (j.tokensIn ?? 0) + (j.tokensOut ?? 0);
    } catch {
      /* not a log line */
    }
  }
  if (!m) return { text: 'no result line', tokens: String(tokens) };
  const skipped = /^\s+#\d+\s+\S+\s+manual\s.*SKIPPED/m.test(t) || /^skipped: /m.test(t);
  return {
    text: `${m[1]} reached ${m[2]} of ${m[3]}, ${m[4]} s${skipped ? ', has a manual step' : ''}`,
    tokens: tokens === 0 ? 'cached plan' : String(tokens),
  };
}

const out = [HEADING, ''];
out.push(
  `Looked at: **${candidates.length}** candidates. **${n('enabled')} enabled**, ${n('disabled')} written and run but disabled with a reason, ${n('excluded')} excluded before or after a probe, ${n('not-attempted')} passed the probe but were not run in P9a (the 50-target goal was met). Status as of ${values.date}.`,
  '',
  `Mix of the ${n('enabled')} enabled: ${groups.library?.length ?? 0} libraries and frameworks, ${groups.vendor?.length ?? 0} vendor SDKs and API clients, ${groups.calibration?.length ?? 0} calibration targets. Without the calibration targets the sample is ${libShare}% libraries and ${100 - libShare}% vendors (goal: 40 and 60). Levels: ${enabled.filter((c) => c.level === 3).length} at L3 (the vendor's API is reached), ${enabled.filter((c) => c.level === 2).length} at L2 (installed and built; many docs pages show only an install command, so those runs reach L1 and the public page says so). Most vendor quickstarts need an account to go beyond that, and the harness never signs up for one.`,
  '',
  '### Enabled targets and their local runs',
  '',
  'Each row is the result of `qsr run <slug>` on this machine (real Docker, the pinned images, the real docs page). "Cached plan" means the compiled plan came from the local cache of an earlier compile, so the run used no model tokens. The notes in each `targets/<slug>.yaml` carry the steps and the resolved versions.',
  '',
  '| Target | Group | Target level | Local run | Model tokens |',
  '|---|---|---|---|---|',
);
for (const c of [...enabled].sort(
  (a, b) => a.group.localeCompare(b.group) || a.slug.localeCompare(b.slug),
)) {
  const r = runLine(c.slug);
  out.push(`| ${c.slug} | ${c.group} | L${c.level} | ${cell(r.text)} | ${r.tokens} |`);
}
out.push(
  '',
  '### All candidates',
  '',
  'Level is the target level for the ones that have a target file. Every reason is one line; the full notes of a written target are in its YAML file.',
  '',
  '| Candidate | Group | Language | Level | Status | Why |',
  '|---|---|---|---|---|---|',
);
const sorted = [...candidates].sort(
  (a, b) =>
    ORDER[a.status] - ORDER[b.status] ||
    a.group.localeCompare(b.group) ||
    a.slug.localeCompare(b.slug),
);
for (const c of sorted) {
  const reason =
    c.status === 'enabled'
      ? cell(c.reason) || 'Run explained: see the notes in the target file'
      : cell(c.reason) || '(no reason recorded)';
  out.push(
    `| ${c.slug} | ${c.group} | ${c.language} | ${c.level ? 'L' + c.level : '-'} | ${LABEL[c.status] ?? c.status} | ${reason} |`,
  );
}
out.push('');

const doc = readFileSync(docPath, 'utf8');
const at = doc.indexOf(HEADING);
if (at < 0) throw new Error(`${HEADING} not found in docs/TARGET-SELECTION.md`);
writeFileSync(docPath, doc.slice(0, at) + out.join('\n'));
console.log(`rendered ${candidates.length} candidates, ${enabled.length} enabled`);

// the repository's format check covers docs/*.md, so leave the file exactly as prettier writes it
const { spawnSync } = await import('node:child_process');
const fmt = spawnSync('pnpm', ['exec', 'prettier', '--write', docPath], {
  cwd: root,
  encoding: 'utf8',
  shell: true,
});
if (fmt.status !== 0) throw new Error(`prettier failed: ${fmt.stderr || fmt.stdout}`);
