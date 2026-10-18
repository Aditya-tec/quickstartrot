import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The launch checklist and the script that runs it say the same thing: every id in the document is a check the script has, and every
// check the script has is in the document. Nothing here runs a network check (--list only prints the ids).

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));
const relativeLinks = (md: string, dir = ''): string[] =>
  [...md.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)].map((m) =>
    path.posix.normalize(path.posix.join(dir, (m[1] ?? '').split('#')[0] ?? '')),
  );

describe('docs/LAUNCH-CHECKLIST.md', () => {
  const md = read('docs/LAUNCH-CHECKLIST.md');
  const rows = [
    ...md.matchAll(/^\| `([a-z0-9-]+)`\s*\| (.+?)\s*\| (Automated|By hand)\s*\| (.+?)\s*\|$/gm),
  ].map((m) => ({
    id: m[1] ?? '',
    how: m[3] ?? '',
  }));
  const scriptIds = spawnSync('node', ['scripts/launch-check.mjs', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean);

  it('lists every check the script runs, and nothing the script does not', () => {
    expect(scriptIds.length).toBeGreaterThanOrEqual(15);
    expect(rows.map((r) => r.id).sort()).toEqual([...scriptIds].sort());
  });

  it('covers the items the launch needs', () => {
    const ids = rows.map((r) => r.id);
    for (const need of [
      'cycle-valid',
      'no-unreviewed-public',
      'disclosures-48h',
      'readme-matches-site',
      'ci-green',
      'secrets-history',
      'cold-start-pages',
      'rate-limit-api',
      'badges-cached',
      'unfurl-home',
      'unfurl-methodology',
      'license',
    ])
      expect(ids, need).toContain(need);
  });

  it('says how to run it and how to read the result, and that a failure blocks the launch', () => {
    expect(md).toContain('node --env-file=.env scripts/launch-check.mjs');
    for (const word of ['PASS', 'FAIL', 'WARN', 'MANUAL', 'SKIP']) expect(md).toContain(word);
    expect(md).toMatch(/a FAIL blocks the launch/i);
  });

  it('marks the two items only a person can do', () => {
    expect(rows.filter((r) => r.how === 'By hand').map((r) => r.id)).toEqual([
      'disclosure-log',
      'post-claims',
    ]);
  });

  it('states what the check sends: nothing to any vendor, nothing posted, no data created', () => {
    expect(md).toMatch(/sends nothing to a vendor/i);
    expect(md).toMatch(/creates no data/i);
  });

  it('links only to files that exist', () => {
    for (const link of relativeLinks(md, 'docs')) expect(exists(link), link).toBe(true);
  });
});
