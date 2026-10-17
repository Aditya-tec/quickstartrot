// Drafts targets/<slug>.yaml from docs/target-candidates.json and a probe result file (scripts/probe-docs-page.mjs).
// The draft is a starting point: level, placeholders and notes are set by hand after reading the crawl and the run.
// Drafts start as enabled: false; a target is enabled only after `qsr run <slug>` gave an explainable result
// (docs/TARGET-SELECTION.md, "Process").
//
//   node scripts/draft-target.mjs <probe.jsonl> <slug> [slug ...]
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [probeFile, ...slugs] = process.argv.slice(2);
if (!probeFile || slugs.length === 0)
  throw new Error('usage: node scripts/draft-target.mjs <probe.jsonl> <slug> ...');
const candidates = new Map(
  JSON.parse(readFileSync(path.join(root, 'docs/target-candidates.json'), 'utf8')).map((c) => [
    c.slug,
    c,
  ]),
);
const probes = new Map(
  readFileSync(probeFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .map((r) => [r.slug, r]),
);

const NODE_TABS = ['node.js', 'nodejs', 'node', 'javascript', 'typescript', 'js', 'ts'];
const PY_TABS = ['python', 'py'];
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;

for (const slug of slugs) {
  const c = candidates.get(slug);
  const p = probes.get(slug);
  if (!c || !p) {
    console.log(`${slug}: not in the candidate list or the probe file`);
    continue;
  }
  const file = path.join(root, 'targets', `${slug}.yaml`);
  if (existsSync(file)) {
    console.log(`${slug}: ${file} already exists, not overwritten`);
    continue;
  }
  const roots = (p.roots ?? []).filter((r) => r.selector !== 'body');
  const best = roots.sort((a, b) => b.pre - a.pre || a.chars - b.chars)[0];
  const wanted = c.language === 'node' ? NODE_TABS : PY_TABS;
  const tab = (p.tabs ?? []).find((t) => wanted.includes(t.trim().toLowerCase()));
  const lines = [
    `slug: ${slug}`,
    `name: ${quote(c.name)}`,
    `docsUrl: ${c.docsUrl}`,
    `language: ${c.language}`,
    'level: 2',
    'runtime:',
    c.language === 'node'
      ? '  image: ghcr.io/aditya-tec/qsr-node:22'
      : '  image: ghcr.io/aditya-tec/qsr-python:3.12',
    c.language === 'node' ? "  nodeVersion: '22'" : "  pythonVersion: '3.12'",
    'extract:',
    `  root: ${quote(best?.selector ?? 'main')}`,
    ...(tab ? [`  tab: ${quote(tab)}`] : []),
    'enabled: false',
    `notes: ${quote('DRAFT, not yet run. Candidate from docs/TARGET-SELECTION.md (group: ' + c.group + ').')}`,
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  console.log(`${slug}: drafted (root ${best?.selector ?? 'main'}${tab ? `, tab ${tab}` : ''})`);
}
