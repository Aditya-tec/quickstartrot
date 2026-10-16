import { describe, expect, it } from 'vitest';
import { authorizeAdmin, constantTimeEqual, FailureLimiter, parseBearer } from './admin-auth.js';

// Spec section 11: admin endpoints take `Bearer ADMIN_TOKEN`. The comparison is constant time, failures are
// rate limited hard, and the token is never logged (the logger redacts the header; nothing here returns it).

const TOKEN = 'admin-token-0123456789abcdef';

describe('constantTimeEqual', () => {
  it('compares equal and different strings', () => {
    expect(constantTimeEqual(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(constantTimeEqual(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(constantTimeEqual(TOKEN, 'x'.repeat(TOKEN.length))).toBe(false);
  });

  it('never throws on different lengths (timingSafeEqual would), including empty and very long input', () => {
    expect(constantTimeEqual('', TOKEN)).toBe(false);
    expect(constantTimeEqual(TOKEN, '')).toBe(false);
    expect(constantTimeEqual('a'.repeat(100_000), TOKEN)).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('parseBearer', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
  ])('%j -> %j', (header, token) => {
    expect(parseBearer(header)).toBe(token);
  });

  it.each([undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer ', 'Bearerabc', 'Bearer a b'])(
    'no token in %j',
    (header) => {
      expect(parseBearer(header)).toBeNull();
    },
  );
});

describe('FailureLimiter', () => {
  const make = (max = 3, windowMs = 1000) => {
    let t = 0;
    return {
      limiter: new FailureLimiter({ max, windowMs, now: () => t }),
      advance: (ms: number) => (t += ms),
    };
  };

  it('blocks a key after `max` failures inside the window', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) {
      expect(limiter.isBlocked('ip')).toBe(false);
      limiter.recordFailure('ip');
    }
    expect(limiter.isBlocked('ip')).toBe(true);
    expect(limiter.isBlocked('other')).toBe(false);
  });

  it('forgets failures once they are older than the window', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) limiter.recordFailure('ip');
    advance(1001);
    expect(limiter.isBlocked('ip')).toBe(false);
  });

  it('only failures inside the window count (a sliding window)', () => {
    const { limiter, advance } = make();
    limiter.recordFailure('ip');
    advance(600);
    limiter.recordFailure('ip');
    advance(600); // the first is now 1200 ms old
    limiter.recordFailure('ip');
    expect(limiter.isBlocked('ip')).toBe(false);
    limiter.recordFailure('ip');
    expect(limiter.isBlocked('ip')).toBe(true);
  });

  it('reset clears a key; memory does not grow without bound', () => {
    const { limiter, advance } = make();
    limiter.recordFailure('a');
    limiter.reset('a');
    expect(limiter.size).toBe(0);
    for (let i = 0; i < 50; i++) limiter.recordFailure(`k${i}`);
    advance(5000);
    limiter.recordFailure('fresh'); // sweeps the expired keys
    expect(limiter.size).toBe(1);
  });
});

describe('authorizeAdmin', () => {
  const setup = () => {
    const t = 0;
    return new FailureLimiter({ max: 3, windowMs: 60_000, now: () => t });
  };
  const call = (limiter: FailureLimiter, header: string | undefined, key = 'ip') =>
    authorizeAdmin({ header, token: TOKEN, limiter, key });

  it('accepts the right token', () => {
    expect(call(setup(), `Bearer ${TOKEN}`)).toBe('ok');
  });

  it('rejects a wrong, missing or malformed token', () => {
    const limiter = setup();
    expect(call(limiter, 'Bearer nope')).toBe('unauthorized');
    expect(call(limiter, undefined)).toBe('unauthorized');
    expect(call(limiter, TOKEN)).toBe('unauthorized');
  });

  it('after 3 failures the key is rate limited, even for the CORRECT token (no brute-force oracle)', () => {
    const limiter = setup();
    for (let i = 0; i < 3; i++) expect(call(limiter, 'Bearer wrong')).toBe('unauthorized');
    expect(call(limiter, `Bearer ${TOKEN}`)).toBe('rate_limited');
    expect(call(limiter, 'Bearer wrong')).toBe('rate_limited');
    expect(call(limiter, `Bearer ${TOKEN}`, 'someone-else')).toBe('ok');
  });

  it('a success clears earlier typos', () => {
    const limiter = setup();
    call(limiter, 'Bearer wrong');
    call(limiter, 'Bearer wrong');
    expect(call(limiter, `Bearer ${TOKEN}`)).toBe('ok');
    call(limiter, 'Bearer wrong');
    call(limiter, 'Bearer wrong');
    expect(call(limiter, `Bearer ${TOKEN}`)).toBe('ok');
  });
});
