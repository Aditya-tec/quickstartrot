import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { submissions } from '@qsr/db';
import { resetDb, startTestApp, type TestApp } from './helpers.js';

// POST /submissions (spec sections 11 and 14): https-only URLs, no IP literals or private hosts, only an
// HMAC of the IP is stored (keyed with a server secret), 5 a day per ip_hash, optional Turnstile.
// A submission is NEVER fetched: a human turns it into a target PR.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp(dbUrl as string);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetDb(t.handle);
  t.fetchCalls.length = 0;
  t.fetchReplies.length = 0;
  t.clock.now = new Date('2026-10-16T12:00:00.000Z');
});

const post = (body: unknown, ip = '203.0.113.20', app: TestApp = t) =>
  app.app.inject({
    method: 'POST',
    url: '/submissions',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
    remoteAddress: ip,
  });
const good = {
  docsUrl: 'https://docs.example.com/quickstart',
  contact: 'founder@example.com',
  note: 'Please add us',
};
const rows = () => t.handle.db.select().from(submissions);

d('accepting a submission', () => {
  it('stores it as NEW with a normalised URL and returns 201', async () => {
    const res = await post({ ...good, docsUrl: 'HTTPS://Docs.Example.com/quickstart#top' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: expect.any(String), status: 'NEW' });
    const [row] = await rows();
    expect(row).toMatchObject({
      id: res.json().id,
      docsUrl: 'https://docs.example.com/quickstart',
      contact: 'founder@example.com',
      note: 'Please add us',
      status: 'NEW',
    });
  });

  it('contact and note are optional', async () => {
    expect((await post({ docsUrl: good.docsUrl })).statusCode).toBe(201);
    expect((await rows())[0]).toMatchObject({ contact: null, note: null });
  });

  it('NEVER fetches the submitted URL', async () => {
    await post(good);
    expect(t.fetchCalls).toEqual([]);
  });
});

d('privacy: only a keyed hash of the IP is stored', () => {
  it('stores HMAC-SHA256(server secret, ip) as ip_hash, and the raw address appears nowhere in the row', async () => {
    await post(good, '203.0.113.20');
    const [row] = await rows();
    const expected = createHmac('sha256', t.config.submissionIpSecret)
      .update('203.0.113.20')
      .digest('hex');
    expect(row?.ipHash).toBe(expected);
    expect(JSON.stringify(row)).not.toContain('203.0.113.20');
  });

  it('is stable per address and different between addresses', async () => {
    await post(good, '203.0.113.20');
    await post(good, '203.0.113.20');
    await post(good, '203.0.113.21');
    const hashes = (await rows()).map((r) => r.ipHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('depends on the server secret: the same address under another secret hashes differently', async () => {
    const other = await startTestApp(dbUrl as string, {
      config: { SUBMISSION_IP_SECRET: 'another-secret-0123456789abcdef' },
    });
    await post(good, '203.0.113.20');
    await post(good, '203.0.113.20', other);
    const hashes = (await rows()).map((r) => r.ipHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    await other.close();
  });
});

d('5 a day per ip_hash', () => {
  it('the sixth submission from one address in 24 hours is a 429 with Retry-After; others are unaffected', async () => {
    for (let i = 0; i < 5; i++)
      expect((await post({ docsUrl: `https://docs.example.com/q${i}` })).statusCode).toBe(201);
    const sixth = await post({ docsUrl: 'https://docs.example.com/q6' });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(sixth.headers['retry-after']).toBeDefined();
    expect(await rows()).toHaveLength(5);
    expect(
      (await post({ docsUrl: 'https://docs.example.com/other' }, '203.0.113.99')).statusCode,
    ).toBe(201);
  });

  it('the window slides: after 24 hours the address may submit again', async () => {
    for (let i = 0; i < 5; i++) await post({ docsUrl: `https://docs.example.com/q${i}` });
    expect((await post(good)).statusCode).toBe(429);
    t.clock.now = new Date(t.clock.now.getTime() + 24 * 3600 * 1000 + 1000);
    expect((await post(good)).statusCode).toBe(201);
  });

  it('rejected submissions do not use up the allowance', async () => {
    for (let i = 0; i < 8; i++) await post({ docsUrl: 'http://not-https.example.com' });
    expect((await post(good)).statusCode).toBe(201);
  });
});

d('URL validation', () => {
  it.each([
    ['http://docs.example.com/q', /https/],
    ['https://127.0.0.1/docs', /IP address/],
    ['https://localhost/docs', /local|private|internal/],
    ['https://user:pw@docs.example.com/', /credentials/],
    ['https://docs.example.com:8443/', /port/],
    ['javascript:alert(1)', /https/],
    ['not a url', /URL|url/],
  ])('rejects %s', async (docsUrl, reason) => {
    const res = await post({ docsUrl });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(reason);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects over-long contact and note, and unknown keys are ignored rather than stored', async () => {
    expect((await post({ ...good, contact: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await post({ ...good, note: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await post({ ...good, status: 'ACCEPTED' })).statusCode).toBe(201);
    expect((await rows())[0]?.status).toBe('NEW');
  });
});

d('Turnstile', () => {
  const withTurnstile = () =>
    startTestApp(dbUrl as string, { config: { TURNSTILE_SECRET: 'turnstile-secret-value' } });
  const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });
  const no = () =>
    new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
      status: 200,
    });

  it('is not consulted when TURNSTILE_SECRET is not set', async () => {
    expect((await post(good)).statusCode).toBe(201);
    expect(t.fetchCalls).toEqual([]);
  });

  it('with a secret set, a missing token is refused without calling Cloudflare', async () => {
    const app = await withTurnstile();
    const res = await post(good, '203.0.113.30', app);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/Turnstile|verification/i);
    expect(app.fetchCalls).toEqual([]);
    await app.close();
  });

  it('a valid token is verified with Cloudflare, with the secret and the token and NO address', async () => {
    const app = await withTurnstile();
    app.fetchReplies.push(ok());
    const res = await post({ ...good, turnstileToken: 'tok-123' }, '203.0.113.30', app);
    expect(res.statusCode).toBe(201);
    expect(app.fetchCalls).toHaveLength(1);
    expect(app.fetchCalls[0]?.url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    const sent = String(app.fetchCalls[0]?.init?.body);
    expect(sent).toContain('secret=turnstile-secret-value');
    expect(sent).toContain('response=tok-123');
    expect(sent).not.toContain('203.0.113.30');
    await app.close();
  });

  it('a token Cloudflare rejects is a 403 and stores nothing', async () => {
    const app = await withTurnstile();
    app.fetchReplies.push(no());
    const res = await post({ ...good, turnstileToken: 'bad' }, '203.0.113.30', app);
    expect(res.statusCode).toBe(403);
    expect(await rows()).toHaveLength(0);
    await app.close();
  });

  it('if Cloudflare cannot be reached the submission is refused (fail closed), not accepted unchecked', async () => {
    const app = await withTurnstile();
    app.fetchReplies.push(new Error('network down'));
    const res = await post({ ...good, turnstileToken: 'tok' }, '203.0.113.30', app);
    expect(res.statusCode).toBe(503);
    expect(await rows()).toHaveLength(0);
    app.fetchReplies.push(new Response('boom', { status: 500 }));
    expect((await post({ ...good, turnstileToken: 'tok' }, '203.0.113.30', app)).statusCode).toBe(
      503,
    );
    await app.close();
  });
});
