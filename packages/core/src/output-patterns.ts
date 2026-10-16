// Output patterns shared by the executor (auth-error-as-pass) and the classifier (NEEDS_CREDENTIALS,
// API_DRIFT precedence). One definition, so the two can never disagree about what an auth error is.

export interface OutputPattern {
  id: string;
  re: RegExp;
}

/**
 * An auth error with a dummy key proves the package installed, the import path is right, the
 * function names exist and the client reached the vendor's endpoint (spec section 6, L3).
 * The first pattern that matches a line is the one recorded on the step result.
 */
export const AUTH_PATTERNS: readonly OutputPattern[] = [
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
export const DRIFT_PATTERNS: readonly OutputPattern[] = [
  { id: 'is not a function', re: /is not a function/i },
  { id: 'Cannot find module', re: /Cannot find module/i },
  { id: 'ModuleNotFoundError', re: /ModuleNotFoundError/i },
  { id: 'ImportError', re: /ImportError/i },
  { id: 'AttributeError', re: /AttributeError/i },
  { id: 'SyntaxError', re: /SyntaxError/i },
];
