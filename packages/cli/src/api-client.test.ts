import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { signRequest } from '@qsr/core';
import { ApiError, ApiWakeError, createApiClient } from './api-client.js';

// The client the probe workflow uses to talk to the API: HMAC-signed JSON, a wake-up phase for the Render
// free tier (cold start 30-60 s), and retries with backoff on 502/503/504 and network errors. A fake HTTP
// server stands in for the API; `sleep` is injected so the backoff is observable and the tests are fast.

const SECRET = 'test-secret-0123456789abcdef';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
interface Fake {
  url: string;
  seen: Seen[];
  /** Per-request behaviour: status (and body) for the Nth request, counting from 0. */
  script: (n: number, req: Seen) => { status: number; body?: unknown; destroy?: boolean };
  close: () => Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function fake(script: Fake['script']): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const n = seen.push(entry) - 1;
      const reply = script(n, entry);
      if (reply.destroy) return req.socket.destroy();
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    script,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const HEALTH = { status: 'ok', db: true, time: '2026-10-16T12:00:00.000Z' };

/** A sleep that records instead of waiting, plus a clock that moves only when sleep is called. */
function clock(startMs = Date.parse('2026-10-16T12:00:00Z')) {
  const state = { now: startMs, sleeps: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

describe('signing and JSON', () => {
  it('signs timestamp + "." + raw body, sends JSON, and parses the JSON answer', async () => {
    const api = await fake(() => ({ status: 200, body: { cycleId: 'c1' } }));
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    const out = await client.post<{ cycleId: string }>('/internal/cycles', { trigger: 'manual' });
    expect(out).toEqual({ cycleId: 'c1' });
    const req = api.seen[0] as Seen;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/internal/cycles');
    expect(req.headers['content-type']).toBe('application/json');
    const ts = Number(req.headers['x-qsr-timestamp']);
    expect(ts).toBe(Math.floor(c.now() / 1000));
    expect(req.headers['x-qsr-signature']).toBe(
      signRequest(SECRET, ts, Buffer.from(req.body, 'utf8')),
    );
    expect(JSON.parse(req.body)).toEqual({ trigger: 'manual' });
  });

  it('a trailing slash on the base URL does not double up', async () => {
    const api = await fake(() => ({ status: 200 }));
    const client = createApiClient({ baseUrl: `${api.url}/`, secret: SECRET });
    await client.post('/internal/cycles', {});
    expect(api.seen[0]?.url).toBe('/internal/cycles');
  });

  it('never sends the secret itself', async () => {
    const api = await fake(() => ({ status: 200 }));
    const client = createApiClient({ baseUrl: api.url, secret: SECRET });
    await client.post('/internal/cycles', {});
    expect(JSON.stringify(api.seen[0])).not.toContain(SECRET);
  });

  it('GET /health is unsigned', async () => {
    const api = await fake(() => ({ status: 200, body: HEALTH }));
    const client = createApiClient({ baseUrl: api.url, secret: SECRET });
    expect(await client.health()).toEqual(HEALTH);
    expect(api.seen[0]?.method).toBe('GET');
    expect(api.seen[0]?.headers['x-qsr-signature']).toBeUndefined();
  });
});

describe('errors', () => {
  it('a 4xx is an ApiError with the problem+json body, and is NOT retried', async () => {
    const api = await fake(() => ({
      status: 422,
      body: { type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'bad body' },
    }));
    const c = clock();
    const client = createApiClient({ baseUrl: api.url, secret: SECRET, sleep: c.sleep });
    const err = await client.post('/internal/runs', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).detail).toBe('bad body');
    expect(String(err)).not.toContain(SECRET);
    expect(api.seen).toHaveLength(1);
    expect(c.state.sleeps).toEqual([]);
  });

  it('a 500 is not retried either (the request may have been processed)', async () => {
    const api = await fake(() => ({ status: 500 }));
    const client = createApiClient({ baseUrl: api.url, secret: SECRET, sleep: clock().sleep });
    await expect(client.post('/internal/runs', {})).rejects.toBeInstanceOf(ApiError);
    expect(api.seen).toHaveLength(1);
  });

  it('a non-JSON error body still gives a useful ApiError', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
    const err = (await client.post('/internal/cycles', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toContain('401');
  });

  it('a 2xx that is not JSON is an error, not undefined', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200).end('<html>');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET });
    await expect(client.post('/internal/cycles', {})).rejects.toThrow(/not JSON/);
  });
});

describe('retries', () => {
  it.each([502, 503, 504])('retries a %i with backoff until it succeeds', async (code) => {
    const api = await fake((n) =>
      n < 3 ? { status: code } : { status: 200, body: { cycleId: 'c1' } },
    );
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    expect(await client.post('/internal/cycles', {})).toEqual({ cycleId: 'c1' });
    expect(api.seen).toHaveLength(4);
    // exponential, capped
    expect(c.state.sleeps).toHaveLength(3);
    expect(c.state.sleeps[1] as number).toBeGreaterThan(c.state.sleeps[0] as number);
    expect(c.state.sleeps[2] as number).toBeGreaterThan(c.state.sleeps[1] as number);
  });

  it('re-signs every attempt with a fresh timestamp, so a long outage cannot age a request out of the window', async () => {
    const api = await fake((n) => (n < 4 ? { status: 503 } : { status: 200 }));
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
      retry: { attempts: 6, baseDelayMs: 40_000, maxDelayMs: 120_000 },
    });
    await client.post('/internal/cycles', { a: 1 });
    const stamps = api.seen.map((s) => Number(s.headers['x-qsr-timestamp']));
    expect(new Set(stamps).size).toBe(stamps.length);
    for (const s of api.seen) {
      const ts = Number(s.headers['x-qsr-timestamp']);
      expect(s.headers['x-qsr-signature']).toBe(signRequest(SECRET, ts, Buffer.from(s.body)));
    }
    // the body is byte-identical on every attempt
    expect(new Set(api.seen.map((s) => s.body)).size).toBe(1);
  });

  it('survives an outage of N seconds (fake clock) and gives up with a clear error after the attempts run out', async () => {
    const c = clock();
    const downUntil = c.now() + 45_000;
    const api = await fake(() =>
      c.now() < downUntil ? { status: 503 } : { status: 200, body: { ok: 1 } },
    );
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
      retry: { attempts: 6, baseDelayMs: 2_000, maxDelayMs: 30_000 },
    });
    // 2 + 4 + 8 + 16 + 30 = 60 s of waiting covers a 45 s cold start
    expect(await client.post('/internal/cycles', {})).toEqual({ ok: 1 });

    const dead = await fake(() => ({ status: 503 }));
    const c2 = clock();
    const client2 = createApiClient({
      baseUrl: dead.url,
      secret: SECRET,
      now: c2.now,
      sleep: c2.sleep,
      retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });
    const err = (await client2.post('/internal/cycles', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(dead.seen).toHaveLength(3);
  });

  it('retries network errors (connection reset) and then succeeds', async () => {
    const api = await fake((n) =>
      n < 2 ? { status: 200, destroy: true } : { status: 200, body: { ok: 1 } },
    );
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    expect(await client.post('/internal/cycles', {})).toEqual({ ok: 1 });
    expect(api.seen).toHaveLength(3);
  });

  it('a network error that never clears surfaces as an error that names the URL, not the secret', async () => {
    const api = await fake(() => ({ status: 200 }));
    const url = api.url;
    await api.close();
    const c = clock();
    const client = createApiClient({
      baseUrl: url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const err = (await client.post('/internal/cycles', {}).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(url);
    expect(err.message).not.toContain(SECRET);
    expect(c.state.sleeps).toHaveLength(1);
  });

  it('honours Retry-After on a 503 when it is longer than the backoff', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (seenCount++ === 0) res.writeHead(503, { 'retry-after': '7' }).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    let seenCount = 0;
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const c = clock();
    const client = createApiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
      retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    });
    await client.post('/internal/cycles', {});
    expect(c.state.sleeps).toEqual([7000]);
  });

  it('works with the real clock and a real 503 window', async () => {
    const started = Date.now();
    const api = await fake(() =>
      Date.now() - started < 250 ? { status: 503 } : { status: 200, body: { ok: 1 } },
    );
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      retry: { attempts: 8, baseDelayMs: 40, maxDelayMs: 120 },
    });
    expect(await client.post('/internal/cycles', {})).toEqual({ ok: 1 });
    expect(api.seen.length).toBeGreaterThan(2);
  });
});

describe('wakeApi', () => {
  it('returns at once when the API is already up', async () => {
    const api = await fake(() => ({ status: 200, body: HEALTH }));
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    const r = await client.wakeApi();
    expect(r.attempts).toBe(1);
    expect(c.state.sleeps).toEqual([]);
  });

  it('polls /health every 10 s through a cold start and then proceeds', async () => {
    const c = clock();
    const upAt = c.now() + 45_000;
    const api = await fake(() =>
      c.now() < upAt ? { status: 503 } : { status: 200, body: HEALTH },
    );
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    const r = await client.wakeApi();
    expect(c.state.sleeps).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(r.attempts).toBe(6);
    expect(r.waitedMs).toBe(50_000);
    expect(api.seen.every((s) => s.url === '/health')).toBe(true);
  });

  it('treats a connection error and a 200 with the wrong body as "not awake yet"', async () => {
    const api = await fake((n) =>
      n === 0
        ? { status: 200, destroy: true }
        : n === 1
          ? { status: 200, body: { hello: 1 } }
          : { status: 200, body: HEALTH },
    );
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    expect((await client.wakeApi()).attempts).toBe(3);
  });

  it('fails after 3 minutes with a message that says what to check', async () => {
    const api = await fake(() => ({ status: 503 }));
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
    });
    const err = (await client.wakeApi().catch((e: unknown) => e)) as ApiWakeError;
    expect(err).toBeInstanceOf(ApiWakeError);
    expect(err.message).toContain(api.url);
    expect(err.message).toMatch(/3 minutes/);
    expect(err.message).toMatch(/API_BASE_URL/);
    expect(err.message).toContain('503');
    expect(c.state.now - Date.parse('2026-10-16T12:00:00Z')).toBeGreaterThanOrEqual(180_000);
    expect(c.state.now - Date.parse('2026-10-16T12:00:00Z')).toBeLessThan(200_000);
  });

  it('the interval and the limit are configurable', async () => {
    const api = await fake(() => ({ status: 503 }));
    const c = clock();
    const client = createApiClient({
      baseUrl: api.url,
      secret: SECRET,
      now: c.now,
      sleep: c.sleep,
      wake: { intervalMs: 1_000, timeoutMs: 3_000 },
    });
    await expect(client.wakeApi()).rejects.toBeInstanceOf(ApiWakeError);
    expect(c.state.sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});
