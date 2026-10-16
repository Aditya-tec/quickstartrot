import { describe, expect, it } from 'vitest';
import type { ExtractionBlock, VariantsConfig } from '@qsr/core';
import { CrawlError } from './errors.js';
import { contentHash } from './normalize.js';
import { applyVariants } from './variants.js';

// Docs that show alternatives inside one code block ("// ESM" ... "// CommonJs" ...). Spec section 7 is
// silent on this; it is deterministic crawler behaviour, not something the compiler guesses at.

const cfg: VariantsConfig = {
  splitOn: ['//\\s*ESM', '//\\s*(?:CommonJs|CJS)'],
  prefer: 'ESM',
};

let n = 0;
const block = (text: string, over: Partial<ExtractionBlock> = {}): ExtractionBlock => ({
  index: n++,
  kind: 'code',
  lang: 'js',
  text,
  filenameHint: null,
  headingPath: ['Guide'],
  ...over,
});
const prose = (text: string): ExtractionBlock => block(text, { kind: 'prose', lang: null });
const run = (blocks: ExtractionBlock[], c: VariantsConfig = cfg) => {
  n = 0;
  return applyVariants(
    blocks.map((b, i) => ({ ...b, index: i })),
    c,
  );
};

// The shape of Fastify's first server block: alternatives, then code shared by both.
const TWO_VARIANTS = [
  '// Require the framework and instantiate it',
  '',
  '// ESM',
  "import Fastify from 'fastify'",
  '',
  'const fastify = Fastify({',
  '  logger: true',
  '})',
  '// CommonJs',
  "const fastify = require('fastify')({",
  '  logger: true',
  '})',
  '',
  '// Declare a route',
  "fastify.get('/', (request, reply) => {",
  "  reply.send({ hello: 'world' })",
  '})',
  '',
  'fastify.listen({ port: 3000 })',
].join('\n');

describe('a block with two variants and a shared tail', () => {
  it('keeps the preamble, the preferred variant and the tail, and drops the markers', () => {
    const { blocks, report } = run([prose('Intro'), block(TWO_VARIANTS)]);
    expect(blocks[1]?.text).toBe(
      [
        '// Require the framework and instantiate it',
        '',
        "import Fastify from 'fastify'",
        '',
        'const fastify = Fastify({',
        '  logger: true',
        '})',
        '',
        '// Declare a route',
        "fastify.get('/', (request, reply) => {",
        "  reply.send({ hello: 'world' })",
        '})',
        '',
        'fastify.listen({ port: 3000 })',
      ].join('\n'),
    );
    expect(blocks[1]?.text).not.toContain('CommonJs');
    expect(blocks[1]?.text).not.toContain('require(');
    expect(report.blocks).toEqual([
      {
        originalIndex: 1,
        blockIndex: 1,
        action: 'kept_variant',
        keptMarker: '// ESM',
        markers: ['// ESM', '// CommonJs'],
      },
    ]);
  });

  it('prefer CommonJs gives the other variant, with the same tail', () => {
    const { blocks } = run([block(TWO_VARIANTS)], { ...cfg, prefer: 'CommonJs' });
    expect(blocks[0]?.text).toContain("const fastify = require('fastify')({");
    expect(blocks[0]?.text).not.toContain('import Fastify');
    expect(blocks[0]?.text).toContain('fastify.listen({ port: 3000 })');
    expect(blocks[0]?.text).toContain('// Declare a route');
  });

  it('matches markers case-insensitively and against the WHOLE trimmed line', () => {
    const text = ['  // esm  ', 'a()', '// cjs', 'b()', '', 'shared()'].join('\n');
    expect(run([block(text)]).blocks[0]?.text).toBe('a()\n\nshared()');
    // a code line that merely contains the marker text is not a marker
    const notMarker = ['const note = "// ESM"', 'x()'].join('\n');
    expect(run([block(TWO_VARIANTS), block(notMarker)]).blocks[1]?.text).toBe(notMarker);
  });

  it('a variant with no shared tail is just that variant', () => {
    const text = ['// ESM', "import a from 'a'", '// CJS', "const a = require('a')"].join('\n');
    expect(run([block(text)]).blocks[0]?.text).toBe("import a from 'a'");
    expect(run([block(text)], { ...cfg, prefer: 'CJS' }).blocks[0]?.text).toBe(
      "const a = require('a')",
    );
  });

  it('three variants: the preferred one in the middle, the tail after the last', () => {
    const text = [
      '// ESM',
      'one()',
      '// CJS',
      'two()',
      '// CommonJs',
      'three()',
      '',
      'tail()',
    ].join('\n');
    const three: VariantsConfig = {
      splitOn: ['//\\s*ESM', '//\\s*CJS', '//\\s*CommonJs'],
      prefer: 'CJS',
    };
    expect(run([block(text)], three).blocks[0]?.text).toBe('two()\n\ntail()');
  });
});

describe('a block with a single marker', () => {
  it('the preferred marker: the block is kept, minus the marker line', () => {
    const text = ['// ESM', "import a from 'a'", '', 'a()'].join('\n');
    const { blocks, report } = run([block(text)]);
    expect(blocks[0]?.text).toBe("import a from 'a'\n\na()");
    expect(report.blocks[0]).toMatchObject({
      action: 'kept_variant',
      keptMarker: '// ESM',
      markers: ['// ESM'],
    });
  });

  it("the other variant's block is dropped, and the remaining blocks are renumbered", () => {
    const { blocks, report } = run([
      prose('before'),
      block(['// CommonJs', "const a = require('a')"].join('\n')),
      prose('after'),
    ]);
    expect(blocks.map((b) => [b.index, b.text])).toEqual([
      [0, 'before'],
      [1, 'after'],
    ]);
    expect(report.blocks).toEqual([
      {
        originalIndex: 1,
        blockIndex: null,
        action: 'dropped_block',
        keptMarker: null,
        markers: ['// CommonJs'],
      },
    ]);
  });

  it('a non-preferred marker below a preamble keeps the preamble and drops the variant', () => {
    const text = ['setup()', '', '// CommonJs', 'other()'].join('\n');
    expect(run([block(text)]).blocks[0]?.text).toBe('setup()');
  });
});

describe('a block with none', () => {
  it('is left exactly as it was, and so are prose and headings', () => {
    const plain = block('npm install fastify', { lang: 'bash' });
    const { blocks } = run([prose('x'), plain, block(TWO_VARIANTS)]);
    expect(blocks[0]?.text).toBe('x');
    expect(blocks[1]).toEqual({ ...plain, index: 1 });
  });

  it('prose that looks like a marker is not touched', () => {
    const p = prose('// ESM');
    expect(run([p, block(TWO_VARIANTS)]).blocks[0]?.text).toBe('// ESM');
  });
});

describe('variant_not_found: a docs structure change is a finding, not something to guess around', () => {
  it('no block on the page has any marker', () => {
    expect(() => run([block('npm i x', { lang: 'bash' }), prose('hello')])).toThrow(CrawlError);
    try {
      run([block('npm i x')]);
    } catch (e) {
      expect(e).toMatchObject({ reason: 'variant_not_found' });
      expect((e as Error).message).toMatch(/no code block contains a variant marker/);
    }
  });

  it('a block with several markers but not the preferred one', () => {
    const text = ['// CommonJs', 'a()', '// CJS', 'b()'].join('\n');
    try {
      run([block(text)]);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ reason: 'variant_not_found' });
      expect((e as Error).message).toMatch(/block 0/);
      expect((e as Error).message).toMatch(/ESM/);
    }
  });

  it('an empty page of blocks', () => {
    expect(() => run([])).toThrow(/no code block contains a variant marker/);
  });
});

describe('the record and the hash', () => {
  it('the content hash reflects the variant that was kept', () => {
    const esm = run([block(TWO_VARIANTS)]).blocks;
    const cjs = run([block(TWO_VARIANTS)], { ...cfg, prefer: 'CommonJs' }).blocks;
    expect(contentHash(esm)).not.toBe(contentHash(cjs));
    expect(contentHash(esm)).toBe(contentHash(run([block(TWO_VARIANTS)]).blocks));
  });

  it('is pure: the input blocks are not mutated', () => {
    const input = [block(TWO_VARIANTS)];
    const snapshot = structuredClone(input);
    applyVariants(input, cfg);
    expect(input).toEqual(snapshot);
  });

  it('reports every affected block in document order', () => {
    const { report } = run([
      block(TWO_VARIANTS),
      block('plain()'),
      block(['// CommonJs', 'x()'].join('\n')),
      block(['// ESM', 'y()'].join('\n')),
    ]);
    expect(report.prefer).toBe('ESM');
    expect(report.blocks.map((b) => [b.originalIndex, b.blockIndex, b.action])).toEqual([
      [0, 0, 'kept_variant'],
      [2, null, 'dropped_block'],
      [3, 2, 'kept_variant'],
    ]);
  });
});
