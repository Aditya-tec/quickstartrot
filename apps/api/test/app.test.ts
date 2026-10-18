import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '@qsr/core';
import {
  ADMIN_TOKEN,
  HMAC_SECRET,
  resetDb,
  startTestApp,
  targetInput,
  type TestApp,
} from './helpers.js';

// Security hygiene of the API (spec sections 11 and 14): helmet, a CORS allow-list, rate limits, a body
// limit, errors as problem+json without stack traces, a request id in every log line, redaction of
// credentials in the log, and HMAC on every /internal route.

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
  t.logs.length = 0;
});

const validSync = { targets: [targetInput('chalk-node')] };

// Render's health check calls this every few seconds and restarts the instance when it does not answer within five seconds. So it must be
// shallow: no database, no storage, no model, no HMAC. A database ping here meant that a burst of requests that queued for the 5-connection
// pool also delayed Render's own probe, and Render restarted the service (two "health check timed out" events on 2026-10-18, each in the
// minute a launch-check burst of GET /health ended). The database check lives at GET /admin/ready, behind the admin token.
d('GET /health', () => {
  it('answers 200 with the time, and needs no credentials', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', time: '2026-10-16T12:00:00.000Z' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not use the database: it is still a 200 when the pool is closed', async () => {
    const broken = await startTestApp(dbUrl as string);
    await broken.handle.close();
    const res = await broken.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', time: '2026-10-16T12:00:00.000Z' });
    await broken.app.close();
  });

  it('answers at once while every pooled connection is busy and twenty requests wait for one', async () => {
    // the whole pool; a postgres.js query only starts when it is executed
    const busy = Array.from({ length: 5 }, () => t.handle.sql`select pg_sleep(1.5)`.execute());
    await new Promise((r) => setTimeout(r, 50));
    const waiting = Array.from({ length: 20 }, () => t.admin('GET', '/admin/queue'));
    await new Promise((r) => setTimeout(r, 50));
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      timings.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }
    expect(
      Math.max(...timings),
      `health took ${timings.map((x) => Math.round(x)).join(', ')} ms`,
    ).toBeLessThan(100);
    await Promise.all(busy);
    expect((await Promise.all(waiting)).every((r) => r.statusCode === 200)).toBe(true);
  });

  it('writes no log line for a probe (Render calls it all day), but still logs other requests', async () => {
    t.logs.length = 0;
    await t.app.inject({ method: 'GET', url: '/health' });
    await t.app.inject({ method: 'GET', url: '/health' });
    expect(t.logs).toEqual([]);
    await t.app.inject({ method: 'GET', url: '/nope' });
    expect(t.logs.join('')).toContain('/nope');
  });

  it('is still rate limited like every route (a flood from one address cannot use it to burn the CPU)', async () => {
    const strict = await startTestApp(dbUrl as string, { config: { RATE_LIMIT_PER_MINUTE: '3' } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1)
      codes.push(
        (await strict.app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.50' }))
          .statusCode,
      );
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await strict.close();
  });
});

d('GET /admin/ready', () => {
  it('needs the admin token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/ready' });
    expect(res.statusCode).toBe(401);
  });

  it('pings the database and says so', async () => {
    const res = await t.admin('GET', '/admin/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: true, time: '2026-10-16T12:00:00.000Z' });
  });

  it('is a 503 problem (not a crash, no details) when the database cannot be reached', async () => {
    const broken = await startTestApp(dbUrl as string);
    await broken.handle.close();
    const res = await broken.admin('GET', '/admin/ready');
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ status: 503, title: 'Service Unavailable' });
    expect(res.body).not.toMatch(/ECONNREFUSED|postgres|stack|at .*\.ts/i);
    await broken.app.close();
  });
});

d('headers and CORS', () => {
  it('sets the helmet security headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured web origin and nothing else', async () => {
    const allowed = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://qsr.example.vercel.app' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://qsr.example.vercel.app');
    const denied = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await t.app.inject({
      method: 'OPTIONS',
      url: '/submissions',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows localhost outside production, but NOT in production', async () => {
    const dev = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const prod = await startTestApp(dbUrl as string, { config: { NODE_ENV: 'production' } });
    const res = await prod.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await prod.close();
  });
});

d('errors are application/problem+json, without stack traces', () => {
  it('unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ type: 'about:blank', title: 'Not Found', status: 404 });
    expect(res.json().requestId).toEqual(expect.any(String));
  });

  it('malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/submissions',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('validation errors name the field, never echo the value', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/submissions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ docsUrl: 12345, contact: 'x'.repeat(500) }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['contact', 'docsUrl']);
    expect(res.body).not.toContain('12345');
    expect(res.body).not.toMatch(/stack|node_modules|\.ts:\d+/);
  });

  it('an unexpected failure is a generic 500 with a request id, and the cause stays in the server log', async () => {
    const broken = await startTestApp(dbUrl as string);
    await broken.handle.close(); // every query now fails
    const res = await broken.signed('/internal/targets/sync', validSync);
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json();
    expect(body).toMatchObject({ status: 500, title: 'Internal Server Error' });
    expect(body.detail).toBeUndefined();
    expect(res.body).not.toMatch(/CONNECTION|postgres|stack|node_modules|\.ts:\d+/i);
    expect(broken.logs.join('')).toContain(body.requestId);
    await broken.app.close();
  });
});

d('logging', () => {
  it('puts a request id in every log line of a request, and returns it in the response', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/nope', // not /health: a probe writes no log lines
      headers: { 'x-request-id': 'req-abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('req-abc-123');
    const lines = t.logs
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const forThis = lines.filter((l) => l['reqId'] === 'req-abc-123');
    expect(forThis.length).toBeGreaterThanOrEqual(2); // "incoming request" and "request completed"
    for (const l of lines.filter((l) => l['req'] || l['res'])) expect(l['reqId']).toBeDefined();
  });

  it('generates a request id when the caller sends none, different for each request', async () => {
    const a = await t.app.inject({ method: 'GET', url: '/health' });
    const b = await t.app.inject({ method: 'GET', url: '/health' });
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{8,}$/);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('never logs the admin token, the HMAC signature or the Authorization header', async () => {
    await t.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: 'Bearer super-secret-bearer-value' },
    });
    await t.admin('GET', '/admin/queue');
    const bad = await t.signed('/internal/targets/sync', validSync, { secret: 'wrong-secret' });
    expect(bad.statusCode).toBe(401);
    const sig = signRequest(
      'wrong-secret',
      Math.floor(t.clock.now.getTime() / 1000),
      Buffer.from(JSON.stringify(validSync)),
    );
    const log = t.logs.join('');
    for (const secret of [
      'super-secret-bearer-value',
      ADMIN_TOKEN,
      HMAC_SECRET,
      sig,
      sig.slice(7),
    ]) {
      expect(log, secret).not.toContain(secret);
    }
    expect(log).toContain('[Redacted]');
  });
});

d('rate limits', () => {
  it('limits a client that hammers the API', async () => {
    const strict = await startTestApp(dbUrl as string, { config: { RATE_LIMIT_PER_MINUTE: '5' } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push(
        (await strict.app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.9' }))
          .statusCode,
      );
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    const limited = await strict.app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '203.0.113.9',
    });
    expect(limited.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(limited.headers['retry-after']).toBeDefined();
    // another client is unaffected
    expect(
      (await strict.app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.10' }))
        .statusCode,
    ).toBe(200);
    await strict.close();
  });
});

d('HMAC on /internal/*', () => {
  const sync = (headers: Record<string, string>, payload = JSON.stringify(validSync)) =>
    t.app.inject({
      method: 'POST',
      url: '/internal/targets/sync',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });
  const now = () => Math.floor(t.clock.now.getTime() / 1000);
  const signedHeaders = (ts = now(), body = JSON.stringify(validSync), secret = HMAC_SECRET) => ({
    [TIMESTAMP_HEADER]: String(ts),
    [SIGNATURE_HEADER]: signRequest(secret, ts, Buffer.from(body)),
  });

  it('accepts a correctly signed request', async () => {
    const res = await sync(signedHeaders());
    expect(res.statusCode).toBe(200);
  });

  it('rejects a bad signature (401, problem+json, nothing about why beyond the category)', async () => {
    const res = await sync(signedHeaders(now(), JSON.stringify(validSync), 'not-the-secret'));
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('rejects a stale timestamp', async () => {
    expect((await sync(signedHeaders(now() - 301))).statusCode).toBe(401);
  });

  it('rejects a timestamp in the future', async () => {
    expect((await sync(signedHeaders(now() + 301))).statusCode).toBe(401);
  });

  it('rejects a tampered body', async () => {
    const headers = signedHeaders();
    const res = await sync(
      headers,
      JSON.stringify({ targets: [targetInput('chalk-node'), targetInput('evil-node')] }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('a wrong-length signature is a 401, never a 500', async () => {
    const good = signedHeaders();
    for (const sig of [
      good[SIGNATURE_HEADER].slice(0, -2),
      `${good[SIGNATURE_HEADER]}ab`,
      'sha256=',
      'x',
      '',
      'sha256=' + 'a'.repeat(5000),
    ]) {
      const res = await sync({
        [TIMESTAMP_HEADER]: good[TIMESTAMP_HEADER],
        [SIGNATURE_HEADER]: sig,
      });
      expect(res.statusCode, sig.slice(0, 20)).toBe(401);
    }
  });

  it('missing headers: either one or both', async () => {
    const good = signedHeaders();
    expect((await sync({})).statusCode).toBe(401);
    expect((await sync({ [TIMESTAMP_HEADER]: good[TIMESTAMP_HEADER] })).statusCode).toBe(401);
    expect((await sync({ [SIGNATURE_HEADER]: good[SIGNATURE_HEADER] })).statusCode).toBe(401);
  });

  it('is checked BEFORE the body is validated: an unauthenticated caller learns nothing about the schema', async () => {
    const res = await sync({}, JSON.stringify({ targets: 'not even close' }));
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/targets|array|expected/i);
  });

  it('is checked before a malformed body is reported', async () => {
    expect((await sync({}, '{nope')).statusCode).toBe(401);
    const headers = signedHeaders(now(), '{nope');
    expect((await sync(headers, '{nope')).statusCode).toBe(400);
  });

  it('a request with no body at all is signed over the empty string', async () => {
    const ts = now();
    const res = await t.app.inject({
      method: 'POST',
      url: '/internal/cycles/00000000-0000-4000-8000-000000000000/finish',
      headers: {
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(HMAC_SECRET, ts, Buffer.alloc(0)),
      },
    });
    expect(res.statusCode).toBe(404); // authenticated, then "no such cycle"
  });

  it('every /internal route requires it', async () => {
    for (const url of [
      '/internal/targets/sync',
      '/internal/cycles',
      '/internal/compile',
      '/internal/uploads',
      '/internal/runs',
      '/internal/cycles/00000000-0000-4000-8000-000000000000/finish',
      '/admin/gc',
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('only JSON bodies are accepted on /internal', async () => {
    const ts = now();
    const res = await t.app.inject({
      method: 'POST',
      url: '/internal/targets/sync',
      headers: {
        'content-type': 'text/plain',
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(HMAC_SECRET, ts, Buffer.from('hello')),
      },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(415);
  });
});

d('body limits', () => {
  it('/internal/runs accepts up to 5 MB; everything else is capped at 1 MB', async () => {
    const big = (mb: number) => JSON.stringify({ pad: 'x'.repeat(mb * 1024 * 1024) });
    const over5 = await t.signed('/internal/runs', undefined, { raw: big(5.5) });
    expect(over5.statusCode).toBe(413);
    expect(over5.headers['content-type']).toMatch(/application\/problem\+json/);
    // 4 MB gets past the size limit (and then fails validation: it is not a RunResult)
    const four = await t.signed('/internal/runs', undefined, { raw: big(4) });
    expect(four.statusCode).toBe(400);
    const sync2 = await t.signed('/internal/targets/sync', undefined, { raw: big(2) });
    expect(sync2.statusCode).toBe(413);
  });
});

d('admin authentication', () => {
  it('needs the bearer token: none, wrong, and right', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/admin/queue' })).statusCode).toBe(401);
    expect((await t.admin('GET', '/admin/queue', undefined, 'wrong-token-value')).statusCode).toBe(
      401,
    );
    expect((await t.admin('GET', '/admin/queue')).statusCode).toBe(200);
  });

  it('every admin route requires it', async () => {
    for (const [method, url] of [
      ['GET', '/admin/queue'],
      ['POST', '/admin/incidents/00000000-0000-4000-8000-000000000000/confirm'],
      ['POST', '/admin/incidents/00000000-0000-4000-8000-000000000000/false-positive'],
      ['POST', '/admin/tools/chalk-node/disable'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { 'content-type': 'application/json' },
        payload: method === 'POST' ? '{}' : undefined,
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('failures are rate limited hard, per client, even for the right token afterwards', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (
          await t.app.inject({
            method: 'GET',
            url: '/admin/queue',
            headers: { authorization: 'Bearer nope-nope-nope-nope' },
            remoteAddress: '198.51.100.7',
          })
        ).statusCode,
      );
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const right = await t.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      remoteAddress: '198.51.100.7',
    });
    expect(right.statusCode).toBe(429);
    expect(right.headers['retry-after']).toBeDefined();
    const other = await t.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      remoteAddress: '198.51.100.8',
    });
    expect(other.statusCode).toBe(200);
  });
});
