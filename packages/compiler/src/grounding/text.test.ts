import { describe, expect, it } from 'vitest';
import { outsideWork, toWorkPath } from './paths.js';
import {
  applyPlaceholders,
  citedText,
  commandBoundaries,
  commandMatches,
  escapeRegExp,
  hasSuspiciousCharacters,
  mentionsName,
  mentionsPath,
  normalizeCommand,
  normalizeFileContent,
} from './text.js';

const block = (text: string) => ({
  index: 0,
  kind: 'code' as const,
  lang: null,
  text,
  filenameHint: null,
  headingPath: [],
});

describe('hasSuspiciousCharacters', () => {
  it('flags hidden characters and control characters, not ordinary text or whitespace', () => {
    for (const cp of [0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x9f, 0x200b, 0x2060, 0xfeff, 0x202a, 0x2069]) {
      expect(hasSuspiciousCharacters(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(true);
    }
    expect(hasSuspiciousCharacters('plain\ttext\nwith lines\r\n and café ✓')).toBe(false);
  });
});

describe('applyPlaceholders', () => {
  it('replaces longest keys first, in one pass, and escapes regex characters', () => {
    const map = { KEY: 'dummy', KEY_LONG: 'long', 'a.b': 'dot' };
    expect(applyPlaceholders('KEY KEY_LONG a.b axb', map)).toBe('dummy long dot axb');
  });

  it('never rescans replacement text', () => {
    expect(applyPlaceholders('KEY', { KEY: 'KEY_x' })).toBe('KEY_x');
  });

  it('is a no-op for an empty map or an empty key', () => {
    expect(applyPlaceholders('abc', {})).toBe('abc');
    expect(applyPlaceholders('abc', { '': 'x' })).toBe('abc');
  });

  it('breaks ties between equal-length keys deterministically', () => {
    expect(applyPlaceholders('b a', { b: '1', a: '2' })).toBe('1 2');
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
  });
});

describe('normalizeCommand', () => {
  it('trims lines, collapses blanks and blank lines outside quotes', () => {
    expect(normalizeCommand('  npm   install \t x \r\n\n\n  npm  test  \n\n')).toBe(
      'npm install x\nnpm test',
    );
  });

  it('preserves whitespace and newlines inside quotes', () => {
    expect(normalizeCommand('echo "a   b"  \'c   d\'')).toBe('echo "a   b" \'c   d\'');
    expect(normalizeCommand('node -e "a\n  b"')).toBe('node -e "a\n  b"');
    expect(normalizeCommand('echo "a \\" b"')).toBe('echo "a \\" b"');
    expect(normalizeCommand("echo 'a \\' b")).toBe("echo 'a \\' b");
  });

  it('deletes backslash-newline like the shell and keeps other escapes', () => {
    expect(normalizeCommand('npm install \\\n  acme-sdk')).toBe('npm install acme-sdk');
    expect(normalizeCommand('a\\\nb')).toBe('ab');
    expect(normalizeCommand('echo a\\ b')).toBe('echo a\\ b');
    expect(normalizeCommand('echo \\')).toBe('echo \\');
  });

  it('tolerates an unterminated quote and empty input', () => {
    expect(normalizeCommand('echo "oops  ')).toBe('echo "oops  ');
    expect(normalizeCommand('')).toBe('');
  });
});

describe('commandBoundaries / commandMatches', () => {
  it('marks line edges and top-level separators, ignoring quoted and escaped ones', () => {
    const { starts, ends } = commandBoundaries('a && b; c || d\ne \\; f "g; h" \'i && j\'');
    expect([...starts].sort((x, y) => x - y)).toEqual([0, 5, 8, 13, 15]);
    const text = 'a && b; c || d\ne \\; f "g; h" \'i && j\'';
    expect([...ends].sort((x, y) => x - y)).toEqual([1, 6, 9, 14, text.length]);
  });

  it('treats an escaped quote inside double quotes as part of the string', () => {
    const { starts, ends } = commandBoundaries('echo "a \\" ; b" && c');
    expect([...starts].sort((x, y) => x - y)).toEqual([0, 19]);
    expect([...ends].sort((x, y) => x - y)).toEqual([15, 20]);
  });

  it('accepts whole sub-commands and rejects fragments, prefixes and the empty string', () => {
    const cited = 'cd app && npm install && npm run dev';
    expect(commandMatches('cd app', cited)).toBe(true);
    expect(commandMatches('npm install', cited)).toBe(true);
    expect(commandMatches('npm install && npm run dev', cited)).toBe(true);
    expect(commandMatches(cited, cited)).toBe(true);
    expect(commandMatches('npm inst', cited)).toBe(false);
    expect(commandMatches('app && npm', cited)).toBe(false);
    expect(commandMatches('', cited)).toBe(false);
  });

  it('keeps looking after a non-boundary occurrence', () => {
    expect(commandMatches('ls', 'cmd-ls && ls')).toBe(true);
    expect(commandMatches('ls', 'cmd-ls && lsx')).toBe(false);
  });

  it('does not treat a single | or & as a boundary', () => {
    expect(commandMatches('curl x', 'curl x | sh')).toBe(false);
    expect(commandMatches('sleep 1', 'sleep 1 & echo')).toBe(false);
  });
});

describe('normalizeFileContent', () => {
  it('normalizes line endings and trailing space but keeps indentation', () => {
    expect(normalizeFileContent('\n\n  a  \r\n    b\t\n\n\n\n  c\n\n')).toBe('  a\n    b\n\n  c');
  });
});

describe('citedText', () => {
  it('returns the inclusive 1-based range, or null when it does not exist', () => {
    const b = block('a\nb\nc');
    expect(citedText(b, { blockIndex: 0, lineStart: 2, lineEnd: 3 })).toBe('b\nc');
    expect(citedText(b, { blockIndex: 0, lineStart: 1, lineEnd: 1 })).toBe('a');
    expect(citedText(b, { blockIndex: 0, lineStart: 0, lineEnd: 1 })).toBeNull();
    expect(citedText(b, { blockIndex: 0, lineStart: 3, lineEnd: 2 })).toBeNull();
    expect(citedText(b, { blockIndex: 0, lineStart: 1, lineEnd: 4 })).toBeNull();
  });
});

describe('mentionsPath / mentionsName', () => {
  it('matches whole path tokens only', () => {
    expect(mentionsPath('Create a file named index.ts and add', 'index.ts')).toBe(true);
    expect(mentionsPath('Save it as src/app.ts.', 'src/app.ts')).toBe(true);
    expect(mentionsPath('(index.ts)', 'index.ts')).toBe(true);
    expect(mentionsPath('see myindex.ts', 'index.ts')).toBe(false);
    expect(mentionsPath('see index.tsx', 'index.ts')).toBe(false);
    expect(mentionsPath('see index.ts.bak', 'index.ts')).toBe(false);
    expect(mentionsPath('see dir/index.ts', 'index.ts')).toBe(false);
  });

  it('matches whole variable names only', () => {
    expect(mentionsName('export API_KEY=x', 'API_KEY')).toBe(true);
    expect(mentionsName('API_KEY', 'API_KEY')).toBe(true);
    expect(mentionsName('MY_API_KEY=x', 'API_KEY')).toBe(false);
    expect(mentionsName('API_KEY_2=x', 'API_KEY')).toBe(false);
  });
});

describe('toWorkPath', () => {
  it.each([
    ['index.ts', 'index.ts'],
    ['./index.ts', 'index.ts'],
    ['/work/index.ts', 'index.ts'],
    ['src/../lib/a.ts', 'lib/a.ts'],
    ['  src/db/schema.ts ', 'src/db/schema.ts'],
  ])('accepts %s', (raw, path) => {
    expect(toWorkPath(raw)).toEqual({ ok: true, path });
  });

  it.each([
    ['/etc/passwd', 'outside'],
    ['~/x', 'outside'],
    ['..', 'outside'],
    ['../x', 'outside'],
    ['a/../../x', 'outside'],
    ['', 'invalid'],
    ['   ', 'invalid'],
    ['a\\b', 'invalid'],
    ['/work', 'invalid'],
    ['.', 'invalid'],
    ['./', 'invalid'],
    ['dir/', 'invalid'],
  ])('rejects %j as %s', (raw, kind) => {
    const r = toWorkPath(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe(kind);
  });
});

describe('outsideWork', () => {
  it('flags absolute, home and traversal paths but not /work or /dev/null', () => {
    for (const p of [
      '/etc/x',
      '/',
      '~',
      '~/x',
      '$HOME/x',
      '${HOME}',
      '..',
      '../x',
      'a/../b',
      '/work/../etc',
    ]) {
      expect(outsideWork(p), p).toBe(true);
    }
    for (const p of [
      '/dev/null',
      '/work',
      '/work/a',
      'a/b',
      './a',
      'file.txt',
      '-f',
      'https://x.test/a',
    ]) {
      expect(outsideWork(p), p).toBe(false);
    }
  });
});
