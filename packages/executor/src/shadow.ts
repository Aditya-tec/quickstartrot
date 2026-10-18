import type { ShadowExportCheck } from '@qsr/core';

// Shadow mode of the experimental export check (P9d). The check runs after every normal step of a production run and its answer
// is only RECORDED: this module turns the script's raw output into that record, and is the only thing that ever reads it. Nothing
// here (or anywhere) may feed it back into a step outcome, the level reached, a classification or a status.

export interface ShadowRaw {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const MAX_NAMES = 50;
const MAX_NOTE = 300;
export const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 3)}...` : s;

const NOT_EXPORTED = /qsr-check-exports: '([^']+)' does not export '([^']+)'/;
const NO_NAME = /qsr-check-exports: cannot import name '([^']+)' from '([^']+)'/;
const NO_MODULE = /qsr-check-exports: cannot import module '([^']+)'/;

/** Names the docs import that the loaded package does not have: `pkg: name`, or the dotted module that does not import. */
function missingNames(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split('\n')) {
    const a = NOT_EXPORTED.exec(line);
    const b = a ? null : NO_NAME.exec(line);
    const c = a || b ? null : NO_MODULE.exec(line);
    const name = a ? `${a[1]}: ${a[2]}` : b ? `${b[2]}: ${b[1]}` : c ? (c[1] as string) : null;
    if (name !== null && !out.includes(name)) out.push(clip(name, 200));
  }
  return out.slice(0, MAX_NAMES);
}

/**
 * pass (exit 0), fail (exit 1, with the missing names), skipped (anything else: a crash, a timeout, no way to run). A skipped
 * check says nothing about the docs, and a fail is a CANDIDATE only: `qsr shadow-report` lists them for a person to judge.
 */
export function parseShadowOutput(raw: ShadowRaw): ShadowExportCheck {
  const { durationMs } = raw;
  if (raw.timedOut)
    return { outcome: 'skipped', missing: [], note: 'the check timed out', durationMs };
  if (raw.exitCode === 0) {
    const unchecked = raw.stdout
      .split('\n')
      .find((l) => l.includes('qsr-check-exports: not checked'));
    return {
      outcome: 'pass',
      missing: [],
      note: unchecked ? clip(unchecked.trim(), MAX_NOTE) : null,
      durationMs,
    };
  }
  if (raw.exitCode === 1) {
    const missing = missingNames(raw.stderr);
    const first = raw.stderr.split('\n').find((l) => l.trim() !== '') ?? '';
    return {
      outcome: 'fail',
      missing,
      note:
        missing.length === 0 ? clip(`no missing name found in: ${first.trim()}`, MAX_NOTE) : null,
      durationMs,
    };
  }
  return {
    outcome: 'skipped',
    missing: [],
    note: clip(`the check could not run (exit ${String(raw.exitCode)})`, MAX_NOTE),
    durationMs,
  };
}
