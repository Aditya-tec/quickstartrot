import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyHashIgnore, contentHash } from './content-hash.js';
import type { ExtractionBlock, VariantsReport } from './extraction.js';
import { HashIgnoreRule, Target, unsafeRegexReason, type TargetInput } from './target.js';

// The content hash is the plan-cache key. P9a go-live added a per-target `extract.hashIgnore`; these tests pin that a
// target WITHOUT it hashes byte-for-byte as before, and that the rule does exactly what it says and no more.

interface Golden {
  slug: string;
  /** Made by the function as it was BEFORE hashIgnore existed, from a live crawl on 2026-10-17. */
  contentHash: string;
  variants: VariantsReport | null;
  blocks: ExtractionBlock[];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  gunzipSync(readFileSync(path.join(here, 'fixtures', 'crawl-hashes.json.gz'))).toString('utf8'),
) as Golden[];

describe('a target without hashIgnore hashes exactly as before', () => {
  it('has the 51 enabled targets crawled on 2026-10-17', () => {
    expect(golden).toHaveLength(51);
  });

  it.each(golden.map((g) => [g.slug, g] as const))('%s: same hash', (_slug, g) => {
    const variants = g.variants ?? undefined;
    expect(contentHash(g.blocks, variants)).toBe(g.contentHash);
    expect(contentHash(g.blocks, variants, undefined)).toBe(g.contentHash);
    expect(contentHash(g.blocks, variants, [])).toBe(g.contentHash);
  });
});

const KEY_RULE = {
  pattern: String.raw`\b([A-Za-z0-9_-]{5,8})\.[A-Za-z0-9_-]{5,8}:(?=\*{3,})`,
  replaceWith: '$1.KEYID:',
};
const block = (text: string, over: Partial<ExtractionBlock> = {}): ExtractionBlock => ({
  index: 0,
  kind: 'code',
  lang: 'python',
  text,
  filenameHint: null,
  headingPath: [],
  ...over,
});
const page = (keyId: string, extra = ''): ExtractionBlock[] => [
  block(`client = Realtime("xVLyHw.${keyId}:*****", client_id="me")${extra}`),
  block('pip install ably', { index: 1, lang: 'shell' }),
];

describe('hashIgnore', () => {
  it('two pages that differ only in the rotating demo key id hash the same', () => {
    const a = contentHash(page('ztp85A'), undefined, [KEY_RULE]);
    const b = contentHash(page('-gbZ_g'), undefined, [KEY_RULE]);
    expect(a).toBe(b);
    // without the rule they differ: this is the drift
    expect(contentHash(page('ztp85A'))).not.toBe(contentHash(page('-gbZ_g')));
  });

  it('a real-looking key with the same prefix and no stars is NOT normalized', () => {
    const real = (id: string): ExtractionBlock[] => [
      block(`client = Realtime("xVLyHw.${id}:abcdefghijklmnopqrstuvwxyz012345", client_id="me")`),
    ];
    expect(contentHash(real('ztp85A'), undefined, [KEY_RULE])).not.toBe(
      contentHash(real('-gbZ_g'), undefined, [KEY_RULE]),
    );
    expect(applyHashIgnore('xVLyHw.ztp85A:abcdefghijkl', [KEY_RULE])).toBe(
      'xVLyHw.ztp85A:abcdefghijkl',
    );
    // one or two stars are not a mask either
    expect(applyHashIgnore('xVLyHw.ztp85A:**', [KEY_RULE])).toBe('xVLyHw.ztp85A:**');
  });

  it('a change anywhere else in the page still changes the hash', () => {
    const base = contentHash(page('ztp85A'), undefined, [KEY_RULE]);
    expect(contentHash(page('ztp85A', ' # new'), undefined, [KEY_RULE])).not.toBe(base);
    expect(
      contentHash(
        [...page('ztp85A'), block('pip install ably==2', { index: 2, lang: 'shell' })],
        undefined,
        [KEY_RULE],
      ),
    ).not.toBe(base);
  });

  it('keeps the prefix, replaces only what the rule matches, and leaves the input alone', () => {
    const blocks = page('ztp85A');
    const before = JSON.stringify(blocks);
    expect(applyHashIgnore(blocks[0]?.text ?? '', [KEY_RULE])).toContain('"xVLyHw.KEYID:*****"');
    contentHash(blocks, undefined, [KEY_RULE]);
    expect(JSON.stringify(blocks)).toBe(before); // the stored extraction keeps the verbatim text
  });

  it('rules apply in order, to every block, and an empty list changes nothing', () => {
    expect(
      applyHashIgnore('a1 b1', [
        { pattern: 'a1', replaceWith: 'b1' },
        { pattern: 'b1', replaceWith: 'c' },
      ]),
    ).toBe('c c');
    expect(applyHashIgnore('xyz', [])).toBe('xyz');
  });
});

describe('HashIgnoreRule validation (at load time)', () => {
  it('accepts the demo-key rule', () => {
    expect(HashIgnoreRule.safeParse(KEY_RULE).success).toBe(true);
  });

  it.each([
    ['an invalid regex', '([a-z'],
    ['an empty pattern', ''],
    ['a nested quantifier', '(a+)+'],
    ['a nested star', '(.*)*'],
    ['a quantified group with a bounded inner quantifier', '(a{2,5})+'],
    ['a quantified alternation', '(a|aa)+'],
    ['a quantified group in a longer pattern', 'x(?:[a-z]+\\d)*y'],
    ['a back-reference', '(a)\\1'],
    ['a pattern over 200 characters', 'a'.repeat(201)],
  ])('rejects %s', (_name, pattern) => {
    expect(HashIgnoreRule.safeParse({ pattern, replaceWith: 'x' }).success).toBe(false);
  });

  it('accepts safe shapes that look similar', () => {
    for (const pattern of [
      '(a)+',
      '(?:ab)+',
      'a+b+',
      '[a-z]+\\.[0-9]{3,5}',
      '(\\+)+',
      '[(+*]+',
      '(a+)?',
      '(?=\\*{3,})',
    ])
      expect(unsafeRegexReason(pattern), pattern).toBeNull();
  });

  it('rejects a replacement over 100 characters, extra fields, and more than 5 rules', () => {
    expect(HashIgnoreRule.safeParse({ pattern: 'a', replaceWith: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(HashIgnoreRule.safeParse({ pattern: 'a', replaceWith: 'x', flags: 'i' }).success).toBe(
      false,
    );
    const rules = Array.from({ length: 6 }, () => ({ pattern: 'a', replaceWith: 'b' }));
    expect(Target.safeParse(target(rules)).success).toBe(false);
    expect(Target.safeParse(target(rules.slice(0, 5))).success).toBe(true);
  });
});

function target(hashIgnore?: unknown): TargetInput {
  return {
    slug: 'ably-python',
    name: 'Ably',
    docsUrl: 'https://ably.com/docs/getting-started/python',
    language: 'python',
    level: 2,
    runtime: { image: 'ghcr.io/x/qsr-python:3.12' },
    extract: { root: 'main article', ...(hashIgnore === undefined ? {} : { hashIgnore }) },
  } as TargetInput;
}

describe('Target', () => {
  it('leaves the field absent when it is not given, so the config hash of every other target is unchanged', () => {
    const parsed = Target.parse(target());
    expect('hashIgnore' in parsed.extract).toBe(false);
    expect(Object.keys(parsed.extract).sort()).toEqual([
      'codeBlocks',
      'ignoreBlocksMatching',
      'root',
    ]);
  });

  it('keeps the rules when they are given', () => {
    expect(Target.parse(target([KEY_RULE])).extract.hashIgnore).toEqual([KEY_RULE]);
  });
});
