import path from 'node:path';

/** The sandbox working directory (spec section 9: `-w /work`, "path must normalize inside /work"). */
export const WORK_DIR = '/work';

export type WorkPath =
  { ok: true; path: string } | { ok: false; kind: 'outside' | 'invalid'; reason: string };

/**
 * Resolves a plan path to a file path relative to /work.
 *  - `outside`: the path would leave /work (absolute, `~`, or `..` traversal). The compiler reports
 *    it as a denylist violation; the executor refuses it as a HARNESS_ERROR.
 *  - `invalid`: malformed (empty, NUL, backslashes, or a directory rather than a file).
 * This is a lexical check; the executor additionally resolves symlinks inside the container.
 */
export function toWorkPath(raw: string): WorkPath {
  const input = raw.trim();
  if (input === '') return { ok: false, kind: 'invalid', reason: 'empty path' };
  if (input.includes('\0')) return { ok: false, kind: 'invalid', reason: 'NUL byte in path' };
  if (input.includes('\\'))
    return { ok: false, kind: 'invalid', reason: 'backslashes are not allowed' };

  let rel = input;
  if (input.startsWith(`${WORK_DIR}/`)) rel = input.slice(WORK_DIR.length + 1);
  else if (input === WORK_DIR)
    return { ok: false, kind: 'invalid', reason: 'a directory, not a file' };
  else if (input.startsWith('/') || input.startsWith('~')) {
    return { ok: false, kind: 'outside', reason: `${input} is outside ${WORK_DIR}` };
  }

  const normalized = path.posix.normalize(rel);
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, kind: 'outside', reason: `${input} escapes ${WORK_DIR}` };
  }
  if (normalized === '.' || normalized.endsWith('/')) {
    return { ok: false, kind: 'invalid', reason: 'a directory, not a file' };
  }
  return { ok: true, path: normalized };
}
