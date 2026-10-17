import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_SECONDS,
  createRateLimiter,
  signSession,
  verifySession,
} from './admin-session.js';

// /admin is protected by an httpOnly cookie that holds an HMAC-signed, expiring session value, never the
// admin token. The token itself is compared in constant time. Failed logins are rate limited; in-memory limiting
// on serverless is per instance (documented in DEPLOY.md), and the API's own limiter is the backstop.

const SECRET = 'session-secret-0123456789abcdef0123456789';
const NOW = 1_800_000_000; // seconds

describe('signSession / verifySession', () => {
  it('a fresh session verifies', async () => {
    const token = await signSession(SECRET, NOW);
    expect(await verifySession(SECRET, token, NOW + 10)).toBe(true);
  });

  it('is two url-safe parts and contains neither the secret nor any admin token', async () => {
    const token = await signSession(SECRET, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(SECRET);
  });

  it('expires after the TTL, to the second', async () => {
    const token = await signSession(SECRET, NOW);
    expect(await verifySession(SECRET, token, NOW + SESSION_TTL_SECONDS - 1)).toBe(true);
    expect(await verifySession(SECRET, token, NOW + SESSION_TTL_SECONDS)).toBe(false);
    expect(await verifySession(SECRET, token, NOW + SESSION_TTL_SECONDS + 3600)).toBe(false);
  });

  it('is short lived: at most a working day', () => {
    expect(SESSION_TTL_SECONDS).toBeLessThanOrEqual(12 * 3600);
  });

  it('refuses a session from the future (clock games or a forged iat)', async () => {
    const token = await signSession(SECRET, NOW + 3600);
    expect(await verifySession(SECRET, token, NOW)).toBe(false);
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signSession('another-secret-0123456789abcdef0123456789', NOW);
    expect(await verifySession(SECRET, token, NOW)).toBe(false);
  });

  it('refuses a tampered payload, even with the original signature', async () => {
    const token = await signSession(SECRET, NOW);
    const [payload, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: NOW, exp: NOW + 10 * 365 * 86400 }),
    ).toString('base64url');
    expect(await verifySession(SECRET, `${forged}.${sig}`, NOW)).toBe(false);
    expect(await verifySession(SECRET, `${payload}.${sig.slice(0, -2)}AA`, NOW)).toBe(false);
  });

  it.each(['', 'x', '.', 'a.b.c', 'a.', '.b', 'not base64!.also not', '{"sub":"admin"}.', 'null'])(
    'refuses a malformed value %j without throwing',
    async (value) => {
      expect(await verifySession(SECRET, value, NOW)).toBe(false);
    },
  );

  it('refuses everything when the secret is missing or too short', async () => {
    await expect(signSession('', NOW)).rejects.toThrow(/secret/i);
    await expect(signSession('short', NOW)).rejects.toThrow(/secret/i);
    expect(await verifySession('', 'a.b', NOW)).toBe(false);
  });

  it('every session is distinct (a nonce), so a captured one cannot be matched to a login', async () => {
    const a = await signSession(SECRET, NOW);
    const b = await signSession(SECRET, NOW);
    expect(a).not.toBe(b);
  });
});

describe('createRateLimiter (failed logins, per client)', () => {
  const make = () => {
    const clock = { ms: 1_000_000 };
    const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60_000, now: () => clock.ms });
    return { clock, limiter };
  };

  it('allows 5 failures, then blocks with a retry time', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
      limiter.fail('1.2.3.4');
    }
    const blocked = limiter.check('1.2.3.4');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('counts per client: one blocked address does not block another', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) limiter.fail('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    expect(limiter.check('5.6.7.8').allowed).toBe(true);
  });

  it('forgets failures after the window', () => {
    const { clock, limiter } = make();
    for (let i = 0; i < 5; i += 1) limiter.fail('a');
    clock.ms += 15 * 60_000 + 1;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('a success does not erase earlier failures (an attacker cannot reset the count by logging in elsewhere)', () => {
    const { limiter } = make();
    for (let i = 0; i < 4; i += 1) limiter.fail('a');
    limiter.succeed();
    limiter.fail('a');
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('does not grow without bound: old clients are dropped', () => {
    const { clock, limiter } = make();
    for (let i = 0; i < 5000; i += 1) limiter.fail(`client-${i}`);
    clock.ms += 16 * 60_000;
    limiter.fail('fresh');
    expect(limiter.size()).toBeLessThan(50);
  });
});
