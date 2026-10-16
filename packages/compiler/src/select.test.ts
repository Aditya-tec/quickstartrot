import { describe, expect, it } from 'vitest';
import type { Extraction, ExtractionBlock } from '@qsr/core';
import { QUICKSTART_HEADING, selectBlocks, toPromptBlock } from './select.js';

// Selection decides which blocks of a long docs page the model sees. It must be deterministic, keep
// the document order, prefer what a new developer needs (code under quickstart-style headings and
// the prose that introduces it), and say exactly what it left out.

type Spec = ['h', string] | ['p', string, string] | ['c', string, string]; // kind, text, heading path (joined with ' > ')

function page(specs: Spec[]): Extraction {
  const blocks: ExtractionBlock[] = specs.map((s, index) => ({
    index,
    kind: s[0] === 'h' ? 'heading' : s[0] === 'p' ? 'prose' : 'code',
    lang: s[0] === 'c' ? 'bash' : null,
    text: s[1],
    filenameHint: null,
    headingPath: s[0] === 'h' ? [s[1]] : (s[2] as string).split(' > '),
  }));
  return {
    url: 'https://example.com/docs',
    finalUrl: 'https://example.com/docs',
    title: 'Docs',
    fetchedAt: '2026-10-16T00:00:00.000Z',
    blocks,
    contentHash: 'h',
  };
}
const long = (n: number, c = 'x'): string => c.repeat(n);
const sizeOf = (x: Extraction, indexes: number[]): number =>
  x.blocks
    .filter((b) => indexes.includes(b.index))
    .reduce((sum, b) => sum + JSON.stringify(toPromptBlock(b)).length, 0);
const indexesOf = (r: ReturnType<typeof selectBlocks>): number[] =>
  r.blocks.map((b) => b.blockIndex);

describe('selectBlocks: nothing to drop', () => {
  it('keeps every block, in order, and reports no truncation', () => {
    const x = page([
      ['h', 'Quickstart'],
      ['p', 'Install it.', 'Quickstart'],
      ['c', 'npm install acme', 'Quickstart'],
    ]);
    const r = selectBlocks(x, 100_000);
    expect(indexesOf(r)).toEqual([0, 1, 2]);
    expect(r.truncation).toEqual({
      truncated: false,
      totalBlocks: 3,
      includedBlocks: 3,
      omittedBlocks: 0,
      omittedBlockIndexes: [],
      clippedBlockIndexes: [],
    });
  });

  it('a page with no blocks at all is an empty, untruncated selection', () => {
    const r = selectBlocks(page([]), 1000);
    expect(r.blocks).toEqual([]);
    expect(r.truncation).toMatchObject({ truncated: false, totalBlocks: 0, includedBlocks: 0 });
  });
});

describe('selectBlocks: what is kept first', () => {
  const x = page([
    ['h', 'Concepts'], //                                    0
    ['p', long(300, 'a'), 'Concepts'], //                    1  far prose
    ['p', long(300, 'b'), 'Concepts'], //                    2  far prose
    ['p', long(300, 'c'), 'Concepts'], //                    3  far prose
    ['h', 'Quickstart'], //                                  4
    ['p', long(100, 'd'), 'Quickstart'], //                  5  prose before code
    ['p', long(100, 'e'), 'Quickstart'], //                  6  prose before code
    ['c', 'npm install acme', 'Quickstart'], //              7  CODE under a quickstart heading
    ['p', long(300, 'f'), 'Advanced'], //                    8  far prose
    ['c', long(300, 'g'), 'Advanced'], //                    9  other code
    ['p', long(300, 'h'), 'Advanced'], //                    10 far prose
  ]);

  it('keeps code and the two prose blocks before it, drops far prose and headings first', () => {
    const tight = sizeOf(x, [5, 6, 7]) + 5; // just enough for the quickstart code and its two prose blocks
    const r = selectBlocks(x, tight);
    expect(indexesOf(r)).toEqual([5, 6, 7]);
    expect(r.truncation.omittedBlockIndexes).toEqual([0, 1, 2, 3, 4, 8, 9, 10]);
    expect(r.truncation).toMatchObject({
      truncated: true,
      totalBlocks: 11,
      includedBlocks: 3,
      omittedBlocks: 8,
    });
  });

  it('prefers code under a quickstart-style heading over other code', () => {
    const tight = sizeOf(x, [7]) + sizeOf(x, [9]) - 1; // room for one of the two code blocks only
    const r = selectBlocks(x, tight);
    expect(indexesOf(r)).toContain(7);
    expect(indexesOf(r)).not.toContain(9);
  });

  it('other code beats far prose once the quickstart blocks are in', () => {
    const budget = sizeOf(x, [5, 6, 7, 9]) + 3;
    const r = selectBlocks(x, budget);
    expect(indexesOf(r)).toEqual([5, 6, 7, 9]);
  });

  it('prose under a matching heading beats prose elsewhere', () => {
    const y = page([
      ['p', long(200, 'a'), 'Overview'], //                0 far prose
      ['p', long(200, 'b'), 'Installation guide'], //      1 prose, matching heading, no code after it
      ['p', long(200, 'c'), 'Overview'], //                2 far prose
    ]);
    const r = selectBlocks(y, sizeOf(y, [1]) + 3);
    expect(indexesOf(r)).toEqual([1]);
  });

  it('only the nearest two prose blocks before a code block count as its introduction', () => {
    const y = page([
      ['p', long(120, 'a'), 'Quickstart'], //  0 three blocks back: not an introduction
      ['p', long(120, 'b'), 'Quickstart'], //  1
      ['p', long(120, 'c'), 'Quickstart'], //  2
      ['c', 'pip install acme', 'Elsewhere'], // 3 code (not under a matching heading)
    ]);
    // Block 0 is prose under a matching heading (tier 5); 1 and 2 are the code's introduction (tier 4).
    const r = selectBlocks(y, sizeOf(y, [1, 2, 3]) + 3);
    expect(indexesOf(r)).toEqual([1, 2, 3]);
  });

  it('introductions stop at the previous code block', () => {
    const y = page([
      ['p', long(100, 'a'), 'Elsewhere'], //  0 introduces block 1
      ['c', 'npm i a', 'Elsewhere'], //        1
      ['c', 'npm i b', 'Elsewhere'], //        2 nothing but code before it
      ['p', long(400, 'z'), 'Elsewhere'], //   3 far prose
    ]);
    const r = selectBlocks(y, sizeOf(y, [0, 1, 2]) + 3);
    expect(indexesOf(r)).toEqual([0, 1, 2]);
  });

  it.each([
    'Quickstart',
    'Quick start',
    'Getting started',
    'Installation',
    'Setup',
    'Usage',
    'Hello world',
    'Fastify > Getting Started',
    'Docs > Install the CLI',
  ])('treats a heading like %j as a quickstart heading', (heading) => {
    expect(QUICKSTART_HEADING.test(heading)).toBe(true);
  });

  it.each(['Concepts', 'Plugins', 'Changelog', 'API reference'])(
    'does not treat %j as one',
    (heading) => {
      expect(QUICKSTART_HEADING.test(heading)).toBe(false);
    },
  );
});

describe('selectBlocks: a page whose every heading shares one matching root (the Fastify case)', () => {
  // Every block sits under "Getting Started", so the root matches the quickstart pattern for ALL of
  // them. That must not turn into "everything is top priority": the sections below it decide.
  const section = (n: number, name: string): Spec[] => [
    ['p', `Intro ${n} one ${long(80, 'i')}`, `Getting Started > ${name}`],
    ['p', `Intro ${n} two ${long(80, 'j')}`, `Getting Started > ${name}`],
    ['c', `code ${n} ${long(200, 'c')}`, `Getting Started > ${name}`],
  ];
  const x = page([
    ...section(1, 'Install'),
    ...section(2, 'Your first server'),
    ...section(3, 'Your first plugin'),
    ...section(4, 'Validate your data'),
    ...section(5, 'Serialize your data'),
  ]);

  it('keeps each early section whole (its code AND the two prose blocks before it) before any later code', () => {
    const budget = sizeOf(x, [0, 1, 2, 3, 4, 5, 6, 7, 8]) + 5; // sections 1-3 fit, nothing more
    const r = selectBlocks(x, budget);
    expect(indexesOf(r)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.truncation.omittedBlockIndexes).toEqual([9, 10, 11, 12, 13, 14]);
  });

  it('never keeps a later section code block while dropping the intro prose of an earlier one', () => {
    for (const budget of [900, 1200, 1500, 1800, 2200]) {
      const ids = new Set(indexesOf(selectBlocks(x, budget)));
      for (const code of [2, 5, 8, 11, 14]) {
        if (!ids.has(code)) continue;
        // if a later section's code is shown, every earlier code and both its intro blocks are too
        for (const earlier of [2, 5, 8, 11, 14].filter((c) => c < code)) {
          expect(ids.has(earlier), `budget ${budget}: code ${earlier} before ${code}`).toBe(true);
        }
      }
    }
  });

  it('a section whose heading matches jumps ahead of earlier sections that do not', () => {
    const y = page([
      ...section(1, 'Concepts'),
      ...section(2, 'Advanced'),
      ...section(3, 'Installation'),
    ]);
    const r = selectBlocks(y, sizeOf(y, [6, 7, 8]) + 5);
    expect(indexesOf(r)).toEqual([6, 7, 8]);
  });
});

describe('selectBlocks: order, determinism, accounting', () => {
  const x = page([
    ['p', long(150, 'a'), 'Quickstart'],
    ['c', 'npm install acme', 'Quickstart'],
    ['p', long(150, 'b'), 'Misc'],
    ['c', long(150, 'c'), 'Misc'],
    ['p', long(150, 'd'), 'Misc'],
  ]);

  it('never reorders: the kept blocks are in document order whatever their priority', () => {
    for (const budget of [400, 600, 800, 1000, 1200]) {
      const ids = indexesOf(selectBlocks(x, budget));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
  });

  it('is deterministic', () => {
    expect(selectBlocks(x, 700)).toEqual(selectBlocks(x, 700));
  });

  it('included + omitted always add up to the total, and the lists match the counts', () => {
    for (const budget of [1, 100, 300, 500, 900, 5000]) {
      const { blocks, truncation: t } = selectBlocks(x, budget);
      expect(t.includedBlocks + t.omittedBlocks).toBe(t.totalBlocks);
      expect(t.includedBlocks).toBe(blocks.length);
      expect(t.omittedBlockIndexes).toHaveLength(t.omittedBlocks);
      expect(t.omittedBlockIndexes).toEqual([...t.omittedBlockIndexes].sort((a, b) => a - b));
      expect(t.truncated).toBe(t.omittedBlocks > 0 || t.clippedBlockIndexes.length > 0);
    }
  });

  it('stays within the character budget whenever more than one block is kept', () => {
    for (const budget of [400, 600, 900]) {
      const { blocks } = selectBlocks(x, budget);
      const total = blocks.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
      expect(total).toBeLessThanOrEqual(budget);
    }
  });
});

describe('selectBlocks: the last resort', () => {
  it('clips a single block that alone exceeds the budget, from the top, and marks it', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of a very long block`);
    const x = page([['c', lines.join('\n'), 'Quickstart']]);
    const r = selectBlocks(x, 600);
    expect(r.blocks).toHaveLength(1);
    const block = r.blocks[0];
    expect(block?.clipped).toBe(true);
    expect(block?.lines?.[0]).toEqual([1, 'line 1 of a very long block']);
    expect(block?.lines?.length).toBeLessThan(200);
    expect(JSON.stringify(block).length).toBeLessThanOrEqual(600);
    expect(r.truncation).toMatchObject({
      truncated: true,
      includedBlocks: 1,
      omittedBlocks: 0,
      clippedBlockIndexes: [0],
    });
  });

  it('clips prose too, and never returns an empty selection however small the budget', () => {
    const x = page([
      ['p', long(5000), 'Overview'],
      ['c', 'npm i', 'Overview'],
    ]);
    const r = selectBlocks(x, 1);
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(r.truncation.truncated).toBe(true);
    const clippedProse = selectBlocks(page([['p', long(5000), 'Overview']]), 500);
    expect(clippedProse.blocks[0]?.clipped).toBe(true);
    expect(JSON.stringify(clippedProse.blocks[0]).length).toBeLessThanOrEqual(500);
  });

  it('does not clip a block that is merely dropped: clipping is only for the nothing-fits case', () => {
    const x = page([
      ['c', 'npm install acme', 'Quickstart'],
      ['c', long(3000), 'Other'],
    ]);
    const r = selectBlocks(x, 400);
    expect(indexesOf(r)).toEqual([0]);
    expect(r.truncation.clippedBlockIndexes).toEqual([]);
    expect(r.blocks[0]?.clipped).toBeUndefined();
  });
});
