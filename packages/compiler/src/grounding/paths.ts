import path from 'node:path';

// One implementation of the lexical /work path check, shared with the executor, lives in core.
export { toWorkPath, type WorkPath } from '@qsr/core';

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
