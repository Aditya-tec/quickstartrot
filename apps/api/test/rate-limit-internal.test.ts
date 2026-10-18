import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import { runResult } from './fixtures.js';

// The per-address rate limiter protects the API from anonymous abuse. A request to /internal/* that carries a valid HMAC signature is
// authenticated: it is the probe's own report, and a report is about two requests per tool, a hundred from one address in a few seconds
// for the targets we track. It must never be rate limited, whatever the limit and however much volume. A request that is NOT validly
// signed is rejected (401) and still counts against the limiter, so the exemption cannot be used to flood the API.

const dbUrl = inject('testDatabaseUrl');
const d = describe.skipIf(dbUrl === null);

const TOOLS = 51; // the targets we track today
const PER_CYCLE = TOOLS * 2 + 2; // an upload and a run for each tool, and the cycle's own calls

let volume: TestApp;
beforeAll(async () => {
  // the production default: 120 a minute per address
  volume = await startTestApp(dbUrl as string, { config: { RATE_LIMIT_PER_MINUTE: '120' } });
  await resetDb(volume.handle);
});
afterAll(async () => {
  await volume?.close();
});

d('a valid signed report is never rate limited', () => {
  it('at three times the volume of a report: every upload, run and cycle call answers 200', async () => {
    const slugs = Array.from(
      { length: TOOLS },
      (_, i) => `tool-${String(i + 1).padStart(2, '0')}-node`,
    );
    // setup (not counted in the volume below): the targets and the cycle
    const sync = await volume.signed('/internal/targets/sync', {
      targets: slugs.map((s) => targetInput(s, { level: 2 })),
    });
    expect(sync.statusCode).toBe(200);
    const cycleBody = { trigger: 'manual', gitSha: 'abcdef1234567', ghRunId: 77, ghRunAttempt: 1 };
    const cycleId = (await volume.signed('/internal/cycles', cycleBody)).json().cycleId as string;

    const statuses: number[] = [];
    const send = async (path: string, body: unknown): Promise<void> => {
      statuses.push((await volume.signed(path, body)).statusCode);
    };
    const rounds = 3;
    for (let round = 0; round < rounds; round += 1) {
      await send('/internal/cycles', cycleBody); // idempotent: the same cycle
      // four tools at a time, as the report job does
      for (let i = 0; i < slugs.length; i += 4) {
        await Promise.all(
          slugs.slice(i, i + 4).flatMap((toolSlug) => [
            send('/internal/uploads', {
              cycleId,
              toolSlug,
              attempt: 1,
              files: [{ stepId: 's1', ordinal: 0 }],
            }),
            send('/internal/runs', {
              runResult: runResult({ cycleId, toolSlug, reachedLevel: 2 }),
              logPaths: {},
            }),
          ]),
        );
      }
      await send('/internal/cycles', cycleBody);
    }
    expect(statuses.length).toBeGreaterThanOrEqual(rounds * PER_CYCLE);
    expect(statuses.length).toBeGreaterThan(120 * 2); // far past what the limiter allows an address
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });
});

d('a request that is not validly signed is rejected and counted', () => {
  const limit = 5;
  let strict: TestApp;
  beforeAll(async () => {
    strict = await startTestApp(dbUrl as string, {
      config: { RATE_LIMIT_PER_MINUTE: String(limit) },
    });
    await resetDb(strict.handle);
  });
  afterAll(async () => {
    await strict?.close();
  });

  const body = JSON.stringify({ targets: [targetInput('acme-node')] });
  const unsigned = () =>
    strict.app.inject({
      method: 'POST',
      url: '/internal/targets/sync',
      headers: { 'content-type': 'application/json' },
      payload: body,
      remoteAddress: '203.0.113.20',
    });
  const badlySigned = () =>
    strict.signed(
      '/internal/targets/sync',
      { targets: [targetInput('acme-node')] },
      { secret: 'not-the-secret-0123456789' },
    );

  it('is a 401 each time, then a 429 once the address has used its allowance, mixing unsigned and badly signed', async () => {
    const out: number[] = [];
    for (let i = 0; i < 8; i += 1)
      out.push((i % 2 === 0 ? await unsigned() : await badlySigned()).statusCode);
    // the badly signed ones come from the default test address, the unsigned from another: count each address on its own
    const unsignedOnly: number[] = [];
    for (let i = 0; i < 8; i += 1) unsignedOnly.push((await unsigned()).statusCode);
    expect(unsignedOnly.slice(0, limit - 4)).toEqual([401]); // the first unsigned requests of the loop above counted
    expect(unsignedOnly.at(-1)).toBe(429);
    expect(out.every((s) => s === 401 || s === 429)).toBe(true);
    expect(out).toContain(401);
  });

  it('a flood of badly signed requests from one address ends in 429s, as any anonymous flood does', async () => {
    const codes: number[] = [];
    for (let i = 0; i < limit + 3; i += 1)
      codes.push(
        (
          await strict.signed(
            '/internal/cycles',
            { trigger: 'manual', gitSha: 'abcdef1234567' },
            { secret: 'still-not-the-secret-012345' },
          )
        ).statusCode,
      );
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(limit);
    expect(codes.slice(-3)).toEqual([429, 429, 429]);
  });

  it('the 429 is a problem document with a Retry-After, like every other refusal', async () => {
    const res = await badlySigned();
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('a validly signed request from the same, exhausted address is still answered', async () => {
    const ok = await strict.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node')],
    });
    expect(ok.statusCode).toBe(200);
    // and a stale signature is a bad one: it is counted, not exempt
    const stale = await strict.signed(
      '/internal/targets/sync',
      { targets: [targetInput('acme-node')] },
      { ts: Math.floor(strict.clock.now.getTime() / 1000) - 10_000 },
    );
    expect([401, 429]).toContain(stale.statusCode);
  });
});

d('the limiter stays on everything else', () => {
  let strict: TestApp;
  beforeAll(async () => {
    strict = await startTestApp(dbUrl as string, { config: { RATE_LIMIT_PER_MINUTE: '5' } });
  });
  afterAll(async () => {
    await strict?.close();
  });

  it('public routes: GET /health', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1)
      codes.push(
        (await strict.app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.30' }))
          .statusCode,
      );
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
  });

  it('admin routes: GET /admin/queue with the right token', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i += 1)
      codes.push(
        (
          await strict.app.inject({
            method: 'GET',
            url: '/admin/queue',
            headers: { authorization: `Bearer ${strict.config.adminToken}` },
            remoteAddress: '203.0.113.31',
          })
        ).statusCode,
      );
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  });
});
