import {
  ALL_AUTH_PATTERNS,
  AUTH_PATTERNS,
  DRIFT_PATTERNS,
  type Expect,
  type OutputPattern,
} from '@qsr/core';

export { AUTH_PATTERNS, DRIFT_PATTERNS };

// Spec section 9, "After each step, evaluate Expect" and "Auth-error-as-pass (L3)". Pure functions:
// the executor feeds them evidence collected while the step ran and they decide pass or fail.

const firstMatch = (patterns: readonly OutputPattern[], line: string): string | null =>
  patterns.find((p) => p.re.test(line))?.id ?? null;

export const matchAuthPattern = (line: string): string | null =>
  firstMatch(ALL_AUTH_PATTERNS, line);
export const matchDriftPattern = (line: string): string | null => firstMatch(DRIFT_PATTERNS, line);

/** What the executor observed while the step ran. */
export interface StepEvidence {
  /** null when the process produced no exit code (killed by the harness). */
  exitCode: number | null;
  /** The step hit its time limit (exit 124 from `timeout`, or the host-side deadline). */
  timedOut: boolean;
  /** First auth pattern seen in stdout or stderr, if any. */
  authPattern: string | null;
  /** First drift pattern seen in stdout or stderr, if any. */
  driftPattern: string | null;
  /** Which of `expect.stdoutIncludes` appeared in stdout. */
  stdoutIncludesFound: ReadonlySet<string>;
}

export interface Verdict {
  pass: boolean;
  reason: string;
  /** The auth pattern that decided (or was vetoed in) the verdict; null when auth played no part. */
  matchedAuthPattern: string | null;
}

const pass = (reason: string, matchedAuthPattern: string | null = null): Verdict => ({
  pass: true,
  reason,
  matchedAuthPattern,
});
const fail = (reason: string, matchedAuthPattern: string | null = null): Verdict => ({
  pass: false,
  reason,
  matchedAuthPattern,
});

export function evaluateExpect(expect: Expect, evidence: StepEvidence): Verdict {
  const { exitCode, authPattern, driftPattern } = evidence;
  if (evidence.timedOut) return fail('timed out');
  if (exitCode === null) return fail('no exit code (the process was killed by the harness)');

  if (exitCode === expect.exitCode) {
    const missing = expect.stdoutIncludes.filter((s) => !evidence.stdoutIncludesFound.has(s));
    // Harness v3: the auth pattern in the output is recorded as EVIDENCE that a vendor was reached, whatever the exit code (a snippet
    // that catches the vendor's error exits 0). A drift pattern takes the evidence away: an import error is not a vendor answer.
    if (missing.length === 0) {
      const proof = driftPattern === null ? authPattern : null;
      return pass(
        proof === null
          ? 'exit code matched'
          : `exit code matched; evidence of reaching the vendor: ${proof}`,
        proof,
      );
    }
    return fail(`missing from stdout: ${missing.map((s) => JSON.stringify(s)).join(', ')}`);
  }

  const mismatch = `exit code ${exitCode}, expected ${expect.exitCode}`;
  if (expect.authErrorIsPass && exitCode !== 0 && authPattern !== null) {
    return driftPattern === null
      ? pass(`auth error treated as pass (${authPattern})`, authPattern)
      : fail(
          `${mismatch}; auth error "${authPattern}" vetoed by drift pattern "${driftPattern}"`,
          authPattern,
        );
  }
  return fail(mismatch);
}
