import { describe, expect, it } from 'vitest';
import { coverageNotes, COVERAGE_SENTENCES } from './coverage-notes.js';
import { Target } from './target.js';

// "What this check does not cover": one plain sentence for everything the target's config leaves out or replaces, generated from the config and
// never typed per target. A target that excludes anything has at least one; a target that excludes nothing has none.

const base = {
  slug: 'acme-node',
  name: 'Acme',
  docsUrl: 'https://docs.acme.dev/quickstart',
  language: 'node',
  level: 2,
  runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
  extract: { root: 'main' },
} as const;
const make = (over: Record<string, unknown> = {}, extract: Record<string, unknown> = {}): Target =>
  Target.parse({ ...base, ...over, extract: { ...base.extract, ...extract } });

describe('coverageNotes', () => {
  it('is empty for a target that leaves nothing out', () => {
    expect(coverageNotes(make())).toEqual([]);
  });

  it('says that credentials in the docs are replaced by a dummy value, for a target with placeholders', () => {
    expect(coverageNotes(make({ placeholders: { YOUR_KEY: 'qsr_dummy_key' } }))).toEqual([
      COVERAGE_SENTENCES.placeholders,
    ]);
    expect(COVERAGE_SENTENCES.placeholders).toMatch(/dummy value/);
  });

  it('says why content was left out, from the declared reason', () => {
    const t = make({}, { ignoreBlocksMatching: ['LANGFUSE_SECRET_KEY'], ignoreWhy: 'credentials' });
    expect(coverageNotes(t)).toEqual([
      'Account and API-key steps from the docs are not exercised at this level.',
    ]);
  });

  it('names the tab, and the variant, that is the only one checked', () => {
    expect(coverageNotes(make({}, { tab: 'Python SDK' }))).toEqual([
      'Only the "Python SDK" tab of the page is checked.',
    ]);
    const v = make({}, { variants: { splitOn: ['// ESM', '// CommonJs'], prefer: 'ESM' } });
    expect(coverageNotes(v)).toEqual([
      'The docs show alternatives in one code block; only the one matching "ESM" is checked.',
    ]);
  });

  it('says that a value that changes on every visit is ignored when telling whether the docs changed', () => {
    const t = make({}, { hashIgnore: [{ pattern: 'x', replaceWith: 'y' }] });
    expect(coverageNotes(t)).toEqual([COVERAGE_SENTENCES.hashIgnore]);
  });

  it('lists each kind once, in a fixed order, however many patterns or placeholders there are', () => {
    const t = make(
      { placeholders: { A: 'qsr_dummy_key', B: 'qsr_dummy_key' } },
      {
        tab: 'JS',
        ignoreBlocksMatching: ['a', 'b'],
        ignoreWhy: 'credentials',
        hashIgnore: [{ pattern: 'x', replaceWith: 'y' }],
      },
    );
    const notes = coverageNotes(t);
    expect(notes).toHaveLength(4);
    expect(new Set(notes).size).toBe(4);
    expect(coverageNotes(t)).toEqual(notes);
  });
});

describe('extract.ignoreWhy', () => {
  it('is accepted with the blocks, and refused without them', () => {
    expect(
      make({}, { ignoreBlocksMatching: ['x'], ignoreWhy: 'credentials' }).extract.ignoreWhy,
    ).toBe('credentials');
    expect(
      Target.safeParse({ ...base, extract: { root: 'main', ignoreWhy: 'credentials' } }).success,
    ).toBe(true);
  });

  it('takes only a reason the code has a sentence for', () => {
    expect(
      Target.safeParse({
        ...base,
        extract: { root: 'main', ignoreBlocksMatching: ['x'], ignoreWhy: 'because' },
      }).success,
    ).toBe(false);
  });

  it('without a reason the note is still there, just less specific (a test over the committed targets demands the reason)', () => {
    expect(coverageNotes(make({}, { ignoreBlocksMatching: ['x'] }))).toEqual([
      COVERAGE_SENTENCES.ignoredWithoutReason,
    ]);
  });
});
