// After the first production cycle under a new harness version (P9d): did any target change status only because of the bump?
//   node --env-file=.env scripts/verify-version-bump.mjs .qsr-runs/status-before-v2.json
// The file is the tools block of GET /admin/stats taken BEFORE the deploy ({ takenAt, tools: [{ slug, status, ... }] }).
// It asks the API for the current numbers (API_BASE_URL and ADMIN_TOKEN from the environment; the token is never printed), prints the
// harness versions seen, and lists every target whose status differs. A difference is not automatically a bug (a vendor can really
// break), but each one must be explained from its run, not assumed: a HEALTHY target that is now DEGRADED or BROKEN after ONE cycle under
// the new version failed under it for the first time, which is allowed; BROKEN after one cycle is not (it needs two under one version).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const base = process.env.API_BASE_URL;
const token = process.env.ADMIN_TOKEN;
if (!file || !base || !token) {
  process.stderr.write(
    'usage: node --env-file=.env scripts/verify-version-bump.mjs <status-before.json>   (API_BASE_URL and ADMIN_TOKEN must be set)\n',
  );
  process.exit(2);
}
const before = JSON.parse(readFileSync(file, 'utf8'));
const res = await fetch(`${base.replace(/\/$/, '')}/admin/stats?days=2`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  process.stderr.write(`GET /admin/stats answered ${res.status}\n`);
  process.exit(1);
}
const now = await res.json();
const then = new Map(before.tools.map((t) => [t.slug, t]));
const changed = [];
for (const t of now.tools) {
  const was = then.get(t.slug);
  if (was && was.status !== t.status)
    changed.push({ slug: t.slug, was: was.status, now: t.status });
}
const versions = now.harness?.versions ?? [];
process.stdout.write(
  [
    `Baseline taken ${before.takenAt}; ${before.tools.length} targets then, ${now.tools.length} now.`,
    `Harness versions in the last 2 days: ${versions.length ? versions.map((v) => `v${v.version} x${v.runs} (${v.firstAt} .. ${v.lastAt})`).join('; ') : 'none'}.`,
    changed.length === 0
      ? 'No target changed status: the version bump changed nothing, as expected.'
      : `${changed.length} target(s) changed status; explain each from its run:\n${changed.map((c) => `  ${c.slug}: ${c.was} -> ${c.now}`).join('\n')}`,
    changed.some((c) => c.now === 'BROKEN')
      ? 'WARNING: a target is BROKEN. That needs two failures under ONE harness version; check that two cycles ran under v2 before accepting it.'
      : '',
    '',
  ]
    .filter((l, i, a) => l !== '' || i === a.length - 1)
    .join('\n'),
);
