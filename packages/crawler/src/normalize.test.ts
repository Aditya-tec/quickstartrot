import { describe, expect, it } from 'vitest';
import {
  contentHash,
  normalizeBlocks,
  normalizeCode,
  normalizeInline,
  type RawBlock,
} from './normalize.js';

describe('normalizeCode', () => {
  it('converts CRLF and lone CR to LF and trims trailing whitespace per line', () => {
    expect(normalizeCode('a  \r\nb\t\rc', 'ts')).toBe('a\nb\nc');
  });

  it('collapses 3+ blank lines to one blank line and trims outer blank lines', () => {
    expect(normalizeCode('\n\na\n\n\n\n\nb\n\n', 'ts')).toBe('a\n\nb');
  });

  it('strips $ and > prompts in shell blocks only', () => {
    expect(normalizeCode('$ npm i x\n> npm run y\n  $ z', 'bash')).toBe('npm i x\nnpm run y\nz');
    // A TypeScript block that happens to start a line with `>` or `$` is left alone.
    expect(normalizeCode('const a = 1;\n$ not a prompt', 'ts')).toBe(
      'const a = 1;\n$ not a prompt',
    );
  });

  it('does not strip `$` without a following space (shell variables, template strings)', () => {
    expect(normalizeCode('$HOME/bin\n${x}', 'bash')).toBe('$HOME/bin\n${x}');
  });

  it('treats any block whose first line starts with "$ " as a terminal session', () => {
    expect(normalizeCode('$ cd project\n\n$ ls', null)).toBe('cd project\n\nls');
    // tagged text/pytest, command followed by output: only the "$ " prompt goes, output stays
    expect(normalizeCode('$ flask run\n * Running on http://x\n> not a prompt', 'text')).toBe(
      'flask run\n * Running on http://x\n> not a prompt',
    );
    expect(normalizeCode('$ pytest -q\n.F', 'pytest')).toBe('pytest -q\n.F');
  });

  it('never treats a block tagged as a programming language as a terminal session', () => {
    expect(normalizeCode('$ (document).ready(init);', 'js')).toBe('$ (document).ready(init);');
    expect(normalizeCode('$ x = 1', 'PHP')).toBe('$ x = 1');
    expect(normalizeCode('$ echo hi', 'bash')).toBe('echo hi'); // an explicit shell tag still strips
    expect(normalizeCode('$ echo hi', 'text')).toBe('echo hi'); // untyped output blocks still strip
  });

  it('leaves variables, expansions and template literals that start with $ untouched', () => {
    expect(normalizeCode('$HOME/.local/bin/acme --init', 'bash')).toBe(
      '$HOME/.local/bin/acme --init',
    );
    expect(normalizeCode('${PORT:-3000}', null)).toBe('${PORT:-3000}');
    expect(normalizeCode('`${greeting}, ${name}!`;', 'js')).toBe('`${greeting}, ${name}!`;');
    expect(normalizeCode('$env:ACME_KEY = "x"', 'powershell')).toBe('$env:ACME_KEY = "x"');
    expect(normalizeCode('$user = new User();\n$user->save();', 'php')).toBe(
      '$user = new User();\n$user->save();',
    );
  });

  it('leaves non-session code alone, including "$" without a space and a later "$ " line', () => {
    expect(normalizeCode('{ "a": 1 }', null)).toBe('{ "a": 1 }');
    expect(normalizeCode('$HOME/bin', 'text')).toBe('$HOME/bin');
    expect(normalizeCode('ls\n$ not a prompt here', null)).toBe('ls\n$ not a prompt here');
  });

  it('is idempotent', () => {
    const once = normalizeCode('$ a  \r\n\n\n\nb', 'sh');
    expect(normalizeCode(once, 'sh')).toBe(once);
  });
});

describe('normalizeInline', () => {
  it('collapses whitespace, removes zero-width characters and permalink glyphs', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    expect(normalizeInline(`  Send${zeroWidthSpace}  your\n first email  #`)).toBe(
      'Send your first email',
    );
    expect(normalizeInline('Install ¶')).toBe('Install');
  });
});

const raw = (over: Partial<RawBlock>): RawBlock => ({
  kind: 'code',
  lang: 'ts',
  text: 'x',
  filenameHint: null,
  headingPath: ['Quickstart'],
  ...over,
});

describe('normalizeBlocks', () => {
  it('re-indexes after dropping empty and ignored blocks', () => {
    const blocks = normalizeBlocks(
      [
        raw({ kind: 'heading', lang: null, text: 'Intro' }),
        raw({ text: '   \n  ' }),
        raw({ text: '// Output: ok' }),
        raw({ text: 'real()' }),
      ],
      ['^// Output:'],
    );
    expect(blocks.map((b) => [b.index, b.text])).toEqual([
      [0, 'Intro'],
      [1, 'real()'],
    ]);
  });

  it('never drops headings via ignore patterns', () => {
    const blocks = normalizeBlocks(
      [raw({ kind: 'heading', lang: null, text: '// Output: heading' })],
      ['^// Output:'],
    );
    expect(blocks).toHaveLength(1);
  });

  it('anchors ignore patterns to the block start, so mid-snippet matches do not drop the block', () => {
    const blocks = normalizeBlocks([raw({ text: 'a()\n// Output: 1' })], ['^// Output:']);
    expect(blocks).toHaveLength(1);
  });
});

describe('contentHash', () => {
  const blocks = normalizeBlocks(
    [raw({ text: 'a' }), raw({ kind: 'prose', lang: null, text: 'b' })],
    [],
  );

  it('is a 64-char sha256 hex and deterministic', () => {
    expect(contentHash(blocks)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(blocks)).toBe(contentHash(structuredClone(blocks)));
  });

  it('changes when code or prose text changes, but not when only filename hints change', () => {
    const changedCode = normalizeBlocks(
      [raw({ text: 'a2' }), raw({ kind: 'prose', lang: null, text: 'b' })],
      [],
    );
    const changedProse = normalizeBlocks(
      [raw({ text: 'a' }), raw({ kind: 'prose', lang: null, text: 'c' })],
      [],
    );
    const hinted = normalizeBlocks(
      [raw({ text: 'a', filenameHint: 'index.ts' }), raw({ kind: 'prose', lang: null, text: 'b' })],
      [],
    );
    expect(contentHash(changedCode)).not.toBe(contentHash(blocks));
    expect(contentHash(changedProse)).not.toBe(contentHash(blocks));
    expect(contentHash(hinted)).toBe(contentHash(blocks));
  });

  it('matches the spec formula exactly', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(JSON.stringify(blocks.map((b) => [b.kind, b.lang, b.text])))
      .digest('hex');
    expect(contentHash(blocks)).toBe(expected);
  });
});
