import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coverageNotes, type Target } from '@qsr/core';
import { parseTargetFile } from './targets.js';

// "What this check does not cover": every target whose config leaves out or replaces anything has a generated note, the reason for left-out
// blocks is declared, and docs/TARGET-SELECTION.md lists the notes of every such target, word for word, from the same function.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const dir = path.join(ROOT, 'targets');
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
const doc = readFileSync(path.join(ROOT, 'docs/TARGET-SELECTION.md'), 'utf8');

const excludes = (t: Target): boolean =>
  Object.keys(t.placeholders).length > 0 ||
  t.extract.tab !== undefined ||
  t.extract.variants !== undefined ||
  t.extract.ignoreBlocksMatching.length > 0 ||
  (t.extract.hashIgnore?.length ?? 0) > 0;

describe('every committed target', () => {
  it('reads the target files', () => {
    expect(files.length).toBeGreaterThan(70);
  });

  for (const file of files) {
    it(`${file}: has a note for what it leaves out, and a declared reason for left-out blocks`, async () => {
      const t = await parseTargetFile(path.join(dir, file));
      const notes = coverageNotes(t);
      if (excludes(t))
        expect(notes.length, `${t.slug} excludes something but has no note`).toBeGreaterThan(0);
      else expect(notes).toEqual([]);
      if (t.extract.ignoreBlocksMatching.length > 0)
        expect(
          t.extract.ignoreWhy,
          `${t.slug} leaves blocks out without saying why (extract.ignoreWhy)`,
        ).toBeDefined();
    });
  }

  it('is listed in docs/TARGET-SELECTION.md with exactly its notes, and the doc lists nobody else', async () => {
    const section = doc.slice(doc.indexOf('### What each check does not cover'));
    expect(section.startsWith('### What each check does not cover')).toBe(true);
    const listed = new Map(
      [...section.matchAll(/^- \*\*([a-z0-9-]+)\*\*: (.+)$/gm)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]),
    );
    const expected = new Map<string, string>();
    for (const file of files) {
      const t = await parseTargetFile(path.join(dir, file));
      const notes = coverageNotes(t);
      if (notes.length > 0 && !file.startsWith('_')) expected.set(t.slug, notes.join(' '));
    }
    expect([...listed.entries()].sort()).toEqual([...expected.entries()].sort());
  });
});
