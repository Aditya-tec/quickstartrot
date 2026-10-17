import { describe, expect, it } from 'vitest';
import { createRateLimiter, verifySession } from './admin-session';
import { attemptLogin, cookieOptions } from './admin-login';

// The login decision: rate limit first, then a constant-time check of ADMIN_TOKEN, then a signed expiring
// session. The cookie holds the session, never the token.

const TOKEN = ['the', 'admin', 'token', 'used', 'in', 'tests', 'zzzzzzzzzzzz'].join('-');
const SECRET = ['a', 'different', 'session', 'signing', 'secret', 'zzzzzzzzzzzzzzzz'].join('-');
const NOW = 1_800_000_000;

function setup() {
  let ms = NOW * 1000;
  const limiter = createRateLimiter({ max: 3, windowMs: 15 * 60_000, now: () => ms });
  return {
    limiter,
    advance: (s: number) => (ms += s * 1000),
    base: {
      expectedToken: TOKEN,
      sessionSecret: SECRET,
      limiter,
      nowSeconds: () => Math.floor(ms / 1000),
    },
  };
}

describe('attemptLogin', () => {
  it('accepts the right token and returns a session the middleware accepts', async () => {
    const { base } = setup();
    const r = await attemptLogin({ ...base, givenToken: TOKEN, clientKey: '1.2.3.4' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.session).not.toContain(TOKEN);
      expect(await verifySession(SECRET, r.session, NOW)).toBe(true);
    }
  });

  it('refuses a wrong token and counts the failure', async () => {
    const { base, limiter } = setup();
    const r = await attemptLogin({ ...base, givenToken: 'nope', clientKey: '1.2.3.4' });
    expect(r).toEqual({ kind: 'bad' });
    expect(limiter.size()).toBe(1);
  });

  it('refuses an empty token', async () => {
    const { base } = setup();
    expect(await attemptLogin({ ...base, givenToken: '', clientKey: 'k' })).toEqual({
      kind: 'bad',
    });
  });

  it('limits a client after repeated failures, even when it then sends the right token', async () => {
    const { base } = setup();
    for (let i = 0; i < 3; i += 1)
      await attemptLogin({ ...base, givenToken: 'wrong', clientKey: 'k' });
    const r = await attemptLogin({ ...base, givenToken: TOKEN, clientKey: 'k' });
    expect(r.kind).toBe('limited');
    if (r.kind === 'limited') expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits per client, not for everyone', async () => {
    const { base } = setup();
    for (let i = 0; i < 3; i += 1)
      await attemptLogin({ ...base, givenToken: 'wrong', clientKey: 'a' });
    expect((await attemptLogin({ ...base, givenToken: TOKEN, clientKey: 'b' })).kind).toBe('ok');
  });

  it('lets the client back in after the window', async () => {
    const { base, advance } = setup();
    for (let i = 0; i < 3; i += 1)
      await attemptLogin({ ...base, givenToken: 'wrong', clientKey: 'k' });
    advance(16 * 60);
    expect((await attemptLogin({ ...base, givenToken: TOKEN, clientKey: 'k' })).kind).toBe('ok');
  });
});

describe('cookieOptions', () => {
  it('is httpOnly, secure, sameSite strict, scoped to /admin, and expires with the session', () => {
    expect(cookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/admin',
      maxAge: 8 * 3600,
    });
  });
});
