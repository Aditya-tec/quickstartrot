import type { Expect } from '@qsr/core';

// Spec section 9, "After each step, evaluate Expect" and "Auth-error-as-pass (L3)". Pure functions:
// the executor feeds them evidence collected while the step ran and they decide pass or fail.

interface Pattern {
  id: string;
  re: RegExp;
}

/**
 * An auth error with a dummy key proves the package installed, the import path is right, the
 * function names exist and the client reached the vendor's endpoint (spec section 6, L3).
 * The first pattern that matches a line is the one recorded on the step result.
 */
export const AUTH_PATTERNS: readonly Pattern[] = [
  {
    id: 'http_401_403',
    // "HTTP 401", "HTTP/1.1 403", "status 401", "statusCode: 401", "status code 403", "code: 403",
    // and "401 Unauthorized" / "403 Forbidden". A bare "401" (a port, a count, a line) does not count.
    re: /(?:\bHTTP(?:\/\d(?:\.\d)?)?[\s:]*|\bstatus(?:[\s_-]*code)?[\s:=]*|\bcode[\s:=]+)(?:401|403)\b|\b(?:401|403)\s+(?:unauthori[sz]ed|forbidden)\b/i,
  },
  { id: 'unauthorized', re: /\bunauthori[sz]ed\b/i },
  { id: 'invalid api key', re: /invalid api key/i },
  { id: 'invalid_api_key', re: /invalid_api_key/i },
  { id: 'authentication failed', re: /authentication failed/i },
  { id: 'missing api key', re: /missing api key/i },
  { id: 'forbidden', re: /\bforbidden\b/i },
];

/**
 * Output that means the quickstart itself is broken. If any of these appears, an auth error does not
 * rescue the step: "an import error printed after a 401 is still a broken quickstart".
 */
export const DRIFT_PATTERNS: readonly Pattern[] = [
  { id: 'is not a function', re: /is not a function/i },
  { id: 'Cannot find module', re: /Cannot find module/i },
  { id: 'ModuleNotFoundError', re: /ModuleNotFoundError/i },
  { id: 'ImportError', re: /ImportError/i },
  { id: 'AttributeError', re: /AttributeError/i },
  { id: 'SyntaxError', re: /SyntaxError/i },
];

const firstMatch = (patterns: readonly Pattern[], line: string): string | null =>
  patterns.find((p) => p.re.test(line))?.id ?? null;

export const matchAuthPattern = (line: string): string | null => firstMatch(AUTH_PATTERNS, line);
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
    return missing.length === 0
      ? pass('exit code matched')
      : fail(`missing from stdout: ${missing.map((s) => JSON.stringify(s)).join(', ')}`);
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
