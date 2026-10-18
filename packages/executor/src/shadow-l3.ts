import { type ShadowL3, type StepResult } from '@qsr/core';
import type { OutputEvidence } from './sink.js';
import { matchAuthPattern } from './expect.js';
import { clip } from './shadow.js';

// Shadow-L3: turns what the L3 step of a shadow target did into the record that is stored. Nothing here (or anywhere) may feed that
// record back into a step outcome, the level reached, a classification or a status; it is read only by `qsr l3-shadow-report`.

const MAX_TEXT = 300;
const isHarnessNote = (line: string): boolean => line.startsWith('[qsr]');

/** The line that decided the verdict: the first auth-evidence line, else the last line the step printed (stderr first). */
function observedLine(r: StepResult, withEvidence: boolean): string | null {
  const lines = [r.stderrTail, r.stdoutTail]
    .flatMap((t) => (t ?? '').split(/\r?\n/))
    .map((l) => l.trim())
    .filter((l) => l !== '' && !isHarnessNote(l));
  if (withEvidence) {
    const hit = lines.find((l) => matchAuthPattern(l) !== null);
    if (hit) return clip(hit, MAX_TEXT);
  }
  const last = [r.stderrTail, r.stdoutTail]
    .map((t) =>
      (t ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !isHarnessNote(l))
        .at(-1),
    )
    .find((l) => l !== undefined);
  return last === undefined ? null : clip(last, MAX_TEXT);
}

const timedOut = (r: StepResult): boolean =>
  r.outcome === 'FAIL' &&
  (r.exitCode === 124 || r.exitCode === null || /\[qsr\] step timed out/.test(r.stderrTail ?? ''));

/**
 * What was observed, in at most 300 characters: the first error line and the first line that matched an auth pattern (both captured
 * while the output streamed, so a long stack trace cannot push them out), else the last line the step printed.
 */
function observedText(r: StepResult, evidence: OutputEvidence | null): string | null {
  const lines = [evidence?.errorLine ?? null, evidence?.authLine ?? null].filter(
    (l, i, all): l is string => l !== null && all.indexOf(l) === i,
  );
  if (lines.length > 0) return clip(lines.join(' | '), MAX_TEXT);
  return observedLine(r, r.matchedAuthPattern !== null);
}

/** The record of a shadow L3 step that ran. `r` is its step result, which is NOT part of the run. */
export function shadowL3FromStep(r: StepResult, evidence: OutputEvidence | null = null): ShadowL3 {
  const pattern = r.matchedAuthPattern;
  const verdict: ShadowL3['verdict'] = timedOut(r)
    ? 'timeout'
    : r.outcome === 'PASS'
      ? pattern === null
        ? 'no_evidence'
        : 'evidence'
      : pattern === null
        ? 'error_no_evidence'
        : 'vetoed';
  return {
    verdict,
    pattern,
    exitCode: r.exitCode,
    observed: observedText(r, evidence),
    durationMs: r.durationMs,
    note: null,
  };
}

/** The record of one that could not run at all (the plumbing threw). */
export const shadowL3Skipped = (note: string, durationMs: number): ShadowL3 => ({
  verdict: 'skipped',
  pattern: null,
  exitCode: null,
  observed: null,
  durationMs,
  note: clip(note, MAX_TEXT),
});
