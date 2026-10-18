import type { Expect } from '@qsr/core';
import { describe, expect, it } from 'vitest';
import {
  AUTH_PATTERNS,
  DRIFT_PATTERNS,
  evaluateExpect,
  matchAuthPattern,
  matchDriftPattern,
  type StepEvidence,
} from './expect.js';

// Spec section 9, "Auth-error-as-pass (L3)": a run step with authErrorIsPass passes when it exits
// non-zero AND stdout or stderr matches an auth pattern, and it must NOT match any drift pattern,
// because an import error printed after a 401 is still a broken quickstart. 100% coverage.

const base: Expect = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const asAuth: Expect = { ...base, authErrorIsPass: true };
const evidence = (over: Partial<StepEvidence> = {}): StepEvidence => ({
  exitCode: 0,
  timedOut: false,
  authPattern: null,
  driftPattern: null,
  stdoutIncludesFound: new Set(),
  ...over,
});

/** One realistic line for every auth pattern in the spec, taken from how real SDKs print them. */
const AUTH_LINES: Record<string, string> = {
  http_401_403: 'Error: Request failed with status code 401',
  unauthorized: 'Unauthorized: bad credentials',
  'invalid api key': 'Error: Invalid API Key provided',
  invalid_api_key: '{"error":{"code":"invalid_api_key"}}',
  'authentication failed': 'authentication failed for user',
  'missing api key': 'Missing API key. Pass it in the Authorization header',
  forbidden: 'Forbidden: you do not have access',
};

const DRIFT_LINES: Record<string, string> = {
  'is not a function': 'TypeError: client.send is not a function',
  'Cannot find module': "Error: Cannot find module 'acme-sdk'",
  ModuleNotFoundError: "ModuleNotFoundError: No module named 'acme'",
  ImportError: 'ImportError: cannot import name Client',
  AttributeError: "AttributeError: module 'acme' has no attribute 'send'",
  SyntaxError: 'SyntaxError: Unexpected token',
};

describe('auth patterns', () => {
  it('has exactly the spec patterns', () => {
    expect(AUTH_PATTERNS.map((p) => p.id)).toEqual(Object.keys(AUTH_LINES));
    expect(DRIFT_PATTERNS.map((p) => p.id)).toEqual(Object.keys(DRIFT_LINES));
  });

  it.each(Object.entries(AUTH_LINES))('recognises %s', (id, line) => {
    expect(matchAuthPattern(line)).toBe(id);
  });

  it.each([
    'HTTP 401',
    'HTTP/1.1 403 Forbidden',
    'HTTP/2 401',
    'status 401',
    'statusCode: 401',
    "{ statusCode: 401, name: 'validation_error', message: 'API key is invalid' }",
    'status code 403',
    'code: 403',
    '401 Unauthorized',
    '403 Forbidden',
    'received 401 UNAUTHORIZED from server',
  ])('recognises the HTTP form %j', (line) => {
    expect(matchAuthPattern(line)).not.toBeNull();
  });

  it.each([
    'listening on port 4010',
    'processed 4011 items',
    'line 401 of file',
    'error code 4013',
    'HTTP 200 OK',
    'status: 404',
    'authenticated as user',
    'all good',
    '',
  ])('does not mistake %j for an auth error', (line) => {
    expect(matchAuthPattern(line)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchAuthPattern('UNAUTHORIZED')).toBe('unauthorized');
    expect(matchAuthPattern('INVALID API KEY')).toBe('invalid api key');
  });
});

describe('vendor patterns count as auth evidence', () => {
  it('matchAuthPattern knows the registered vendor patterns, after the spec ones', () => {
    expect(matchAuthPattern("message: 'API key is invalid',")).toBe('resend:api_key_is_invalid');
    expect(matchAuthPattern('Request failed with status code 401: API key is invalid')).toBe(
      'http_401_403',
    );
    expect(matchAuthPattern('WebAPIPlatformError: An API error occurred: not_authed')).toBe(
      'slack:not_authed',
    );
    expect(matchAuthPattern('a not_authed_thing is not the code')).toBeNull();
  });
});

describe('drift patterns', () => {
  it.each(Object.entries(DRIFT_LINES))('recognises %s', (id, line) => {
    expect(matchDriftPattern(line)).toBe(id);
  });

  it('does not flag clean output or auth errors', () => {
    expect(matchDriftPattern('HTTP 401 Unauthorized')).toBeNull();
    expect(matchDriftPattern('')).toBeNull();
  });
});

describe('evaluateExpect: the normal path', () => {
  it('passes on the expected exit code', () => {
    expect(evaluateExpect(base, evidence()).pass).toBe(true);
  });

  it('fails on a different exit code and says which', () => {
    const v = evaluateExpect(base, evidence({ exitCode: 2 }));
    expect(v).toMatchObject({ pass: false });
    expect(v.reason).toMatch(/exit code 2, expected 0/);
  });

  it('honours a non-zero expected exit code', () => {
    expect(evaluateExpect({ ...base, exitCode: 3 }, evidence({ exitCode: 3 })).pass).toBe(true);
    expect(evaluateExpect({ ...base, exitCode: 3 }, evidence({ exitCode: 0 })).pass).toBe(false);
  });

  it('requires every stdoutIncludes string to have been seen', () => {
    const e: Expect = { ...base, stdoutIncludes: ['ready', 'ok'] };
    expect(
      evaluateExpect(e, evidence({ stdoutIncludesFound: new Set(['ready', 'ok']) })).pass,
    ).toBe(true);
    const missing = evaluateExpect(e, evidence({ stdoutIncludesFound: new Set(['ready']) }));
    expect(missing.pass).toBe(false);
    expect(missing.reason).toMatch(/missing from stdout: "ok"/);
  });

  it('a timeout fails regardless of everything else, with exit code 124 as `timeout` reports it', () => {
    const v = evaluateExpect(
      asAuth,
      evidence({ exitCode: 124, timedOut: true, authPattern: 'unauthorized' }),
    );
    expect(v).toMatchObject({ pass: false, matchedAuthPattern: null });
    expect(v.reason).toMatch(/timed out/);
  });

  it('a process with no exit code (killed by the harness) fails', () => {
    const v = evaluateExpect(asAuth, evidence({ exitCode: null, authPattern: 'unauthorized' }));
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no exit code/);
  });
});

describe('evaluateExpect: auth-error-as-pass', () => {
  it.each(Object.keys(AUTH_LINES))('every auth pattern passes: %s', (id) => {
    const v = evaluateExpect(asAuth, evidence({ exitCode: 1, authPattern: id }));
    expect(v).toMatchObject({ pass: true, matchedAuthPattern: id });
    expect(v.reason).toMatch(/auth error treated as pass/);
  });

  it.each(Object.keys(DRIFT_LINES))(
    'a drift pattern printed after the auth error vetoes the pass: %s',
    (id) => {
      const v = evaluateExpect(
        asAuth,
        evidence({ exitCode: 1, authPattern: 'http_401_403', driftPattern: id }),
      );
      expect(v.pass).toBe(false);
      expect(v.reason).toMatch(new RegExp(`vetoed by drift pattern "${id}"`));
      expect(v.matchedAuthPattern).toBe('http_401_403'); // the evidence is kept
    },
  );

  it('without the flag an auth error is just a failure', () => {
    const v = evaluateExpect(base, evidence({ exitCode: 1, authPattern: 'unauthorized' }));
    expect(v).toMatchObject({ pass: false, matchedAuthPattern: null });
    expect(v.reason).toMatch(/exit code 1, expected 0/);
  });

  it('a non-zero exit with the flag but NO auth pattern still fails', () => {
    const v = evaluateExpect(asAuth, evidence({ exitCode: 1 }));
    expect(v).toMatchObject({ pass: false, matchedAuthPattern: null });
  });

  it('drift without any auth error fails as an ordinary failure', () => {
    const v = evaluateExpect(asAuth, evidence({ exitCode: 1, driftPattern: 'ImportError' }));
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/exit code 1, expected 0/);
  });

  it('exit 0 passes as before, and the auth pattern in the output is now RECORDED as the evidence an L3 claim needs', () => {
    const v = evaluateExpect(asAuth, evidence({ exitCode: 0, authPattern: 'forbidden' }));
    expect(v).toMatchObject({ pass: true, matchedAuthPattern: 'forbidden' });
  });

  it('the evidence is recorded whether or not the step allows auth errors as a pass', () => {
    expect(
      evaluateExpect(base, evidence({ exitCode: 0, authPattern: 'unauthorized' })),
    ).toMatchObject({
      pass: true,
      matchedAuthPattern: 'unauthorized',
    });
  });

  it('exit 0 with no auth pattern records no evidence (the pass stands, but it proves no vendor was reached)', () => {
    expect(evaluateExpect(asAuth, evidence({ exitCode: 0 }))).toMatchObject({
      pass: true,
      matchedAuthPattern: null,
    });
  });

  it('a drift pattern vetoes the evidence on exit 0 too: the step passes by exit code but claims no auth evidence', () => {
    const v = evaluateExpect(
      asAuth,
      evidence({ exitCode: 0, authPattern: 'http_401_403', driftPattern: 'is not a function' }),
    );
    expect(v).toMatchObject({ pass: true, matchedAuthPattern: null });
  });

  it('exit 0 with a missing stdoutIncludes still fails (the flag only rescues non-zero exits)', () => {
    const e: Expect = { ...asAuth, stdoutIncludes: ['hello'] };
    expect(evaluateExpect(e, evidence({ exitCode: 0, authPattern: 'forbidden' })).pass).toBe(false);
  });

  it('does not rescue a step that expected a non-zero exit but exited 0 with auth words in the output', () => {
    const v = evaluateExpect(
      { ...asAuth, exitCode: 3 },
      evidence({ exitCode: 0, authPattern: 'forbidden' }),
    );
    expect(v).toMatchObject({ pass: false, matchedAuthPattern: null });
    expect(v.reason).toMatch(/exit code 0, expected 3/);
  });

  it('does not rescue an expected exit code the step was told to produce', () => {
    const v = evaluateExpect({ ...asAuth, exitCode: 2 }, evidence({ exitCode: 2 }));
    expect(v).toMatchObject({ pass: true, matchedAuthPattern: null });
  });
});
