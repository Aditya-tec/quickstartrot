import path from 'node:path';

export type WorkPath =
  { ok: true; path: string } | { ok: false; kind: 'outside' | 'invalid'; reason: string };

/**
 * Resolves a plan path to a file path relative to /work (the sandbox working directory).
 * `outside` means the path would write beyond /work (denylist); `invalid` means it is malformed.
 */
export function toWorkPath(raw: string): WorkPath {
  const input = raw.trim();
  if (input === '') return { ok: false, kind: 'invalid', reason: 'empty path' };
  if (input.includes('\\'))
    return { ok: false, kind: 'invalid', reason: 'backslashes are not allowed' };

  let rel = input;
  if (input.startsWith('/work/')) rel = input.slice('/work/'.length);
  else if (input === '/work')
    return { ok: false, kind: 'invalid', reason: 'a directory, not a file' };
  else if (input.startsWith('/') || input.startsWith('~')) {
    return { ok: false, kind: 'outside', reason: `${input} is outside /work` };
  }

  const normalized = path.posix.normalize(rel);
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, kind: 'outside', reason: `${input} escapes /work` };
  }
  if (normalized === '.' || normalized.endsWith('/')) {
    return { ok: false, kind: 'invalid', reason: 'a directory, not a file' };
  }
  return { ok: true, path: normalized };
}

/** True if a shell word names somewhere outside /work: absolute, home-relative or `..` traversal. */
export function outsideWork(word: string): boolean {
  if (word === '/dev/null') return false;
  if (word.startsWith('~') || word.startsWith('$HOME') || word.startsWith('${HOME}')) return true;
  if (word.startsWith('/')) {
    const normalized = path.posix.normalize(word);
    return !(normalized === '/work' || normalized.startsWith('/work/'));
  }
  return word.split('/').includes('..');
}
