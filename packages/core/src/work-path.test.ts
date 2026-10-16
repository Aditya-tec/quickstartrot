import { describe, expect, it } from 'vitest';
import { toWorkPath } from './work-path.js';

// Path normalization shared by the compiler's grounding validator and the executor. Anything that
// resolves outside /work must be refused; the executor reports it as HARNESS_ERROR. 100% coverage.

describe('toWorkPath: accepts paths that stay inside /work', () => {
  it.each([
    ['index.ts', 'index.ts'],
    ['./index.ts', 'index.ts'],
    ['/work/index.ts', 'index.ts'],
    ['/work/src/db/schema.ts', 'src/db/schema.ts'],
    ['src/../lib/a.ts', 'lib/a.ts'],
    ['a/./b/../c.ts', 'a/c.ts'],
    ['  src/db/schema.ts ', 'src/db/schema.ts'],
    ['.env', '.env'],
    ['dir/.hidden/file', 'dir/.hidden/file'],
    ['..hidden', '..hidden'],
    ['a/..b/c', 'a/..b/c'],
    ['a/b/..', 'a'],
  ])('%j -> %j', (raw, path) => {
    expect(toWorkPath(raw)).toEqual({ ok: true, path });
  });
});

describe('toWorkPath: refuses paths that leave /work', () => {
  it.each([
    '/etc/passwd',
    '/',
    '/work2/x',
    '/workspace/x',
    '/tmp/x',
    '/home/runner/.bashrc',
    '~',
    '~/x',
    '~root/x',
    '..',
    '../x',
    '../../etc/passwd',
    'a/../../x',
    './../x',
    '/work/../etc/passwd',
    '/work/a/../../etc',
  ])('%j is outside', (raw) => {
    const r = toWorkPath(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe('outside');
  });
});

describe('toWorkPath: refuses malformed paths', () => {
  it.each([
    ['', 'empty path'],
    ['   ', 'empty path'],
    ['a\\b', 'backslashes'],
    ['C:\\Windows\\x', 'backslashes'],
    ['a\0b', 'NUL'],
    ['/work', 'directory'],
    ['.', 'directory'],
    ['./', 'directory'],
    ['dir/', 'directory'],
  ])('%j is invalid', (raw, why) => {
    const r = toWorkPath(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe('invalid');
    expect(!r.ok && r.reason).toMatch(new RegExp(why, 'i'));
  });
});

describe('toWorkPath: result shape', () => {
  it('explains why a path is refused, naming the input', () => {
    const r = toWorkPath('../secrets');
    expect(!r.ok && r.reason).toContain('../secrets');
  });
});
