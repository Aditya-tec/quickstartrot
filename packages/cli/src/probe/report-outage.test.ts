import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FinishResponse,
  RunBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRequest,
  type Manifest,
  type PlanFile,
  type RunResult,
} from '@qsr/core';
import { createApiClient, DEFAULT_RETRY, REPORT_RETRY_STATUSES } from '../api-client.js';
import { ReportError, runReport } from './report.js';
import { CYCLE, readyPlan, recordingLogger, runResultFor, target } from './probe.test-utils.js';

// The API restarts while the report job is posting (Render restarts the service when its health check times out, and a free instance
// sleeps). This runs the REAL API client, with its default retry policy, through the report job against a fake API that goes away,
// in a virtual clock: the report must finish, every run must be stored exactly once even when the API processed a run and the answer
// was lost, and every retry must carry a fresh signature (a long outage must not age a request out of the server's window).

// the real timer, taken before the virtual clock replaces it: real file I/O needs real time between steps of the virtual one
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const SECRET = ['report', 'outage', 'test', 'secret', 'zzzzzzzzzzzz'].join('-');
const LATENCY_MS = 300;
const TOOLS = Array.from({ length: 8 }, (_, i) => `tool-${i + 1}-node`);

let dir: string;
let plans: string;
let results: string;
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-outage-'));
  plans = path.join(dir, 'plans');
  results = path.join(dir, 'results');
  await mkdir(plans, { recursive: true });
  await mkdir(results, { recursive: true });
  const files: PlanFile[] = TOOLS.map((slug, i) => readyPlan(target(slug), i % 2));
  for (const f of files) await writeFile(path.join(plans, `${f.toolSlug}.json`), JSON.stringify(f));
  const manifest: Manifest = {
    version: 1,
    cycleId: CYCLE,
    createdAt: '2026-10-16T12:00:00.000Z',
    shards: 2,
    guards: [],
    tools: files.map((f) => ({
      toolSlug: f.toolSlug,
      state: f.state,
      shard: f.state === 'ready' ? f.shard : null,
      stale: f.state === 'ready' && f.plan.stale,
      isCanary: f.isCanary,
    })),
  };
  await writeFile(path.join(plans, 'manifest.json'), JSON.stringify(manifest));
  for (const slug of TOOLS) {
    const result: RunResult = runResultFor(slug);
    const steps = result.steps.map((s) => ({
      ...s,
      logFile: `${slug}-1/${String(s.ordinal).padStart(2, '0')}-${s.stepId}.log`,
    }));
    await mkdir(path.join(results, `${slug}-1`), { recursive: true });
    for (const s of steps)
      await writeFile(path.join(results, s.logFile), `output of ${s.stepId}\n`);
    await writeFile(path.join(results, `${slug}-1.json`), JSON.stringify({ ...result, steps }));
  }
});
afterEach(() => {
  vi.useRealTimers();
});

const reset = (): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });

interface Server {
  fetch: typeof fetch;
  store: Map<string, string>;
  /** The outcome each stored run carries: a rate limit must never turn a PASS into a HARNESS_ERROR. */
  outcomes: Map<string, string>;
  /** Run requests the API processed, duplicates included. */
  applied: () => number;
  finishes: () => number;
  /** Every request the API received, retries included. */
  requests: () => number;
  /** Requests answered with a failure (reset, 502, 503). */
  failed: () => number;
  health: () => number;
  /** Requests refused for a bad or stale signature. */
  unauthorized: () => number;
}

/**
 * A fake API in virtual time. The outage is tied to events, not to the clock (the virtual clock races ahead while the report does real
 * file I/O): it starts at the first request (`atStart`) or right after the Nth run is stored (`afterRuns`), and lasts `forMs` of virtual
 * time. `loseOnce` tools get their first run applied and the answer lost.
 */
function fakeServer(
  opts: {
    outage?: { forMs: number; atStart?: true; afterRuns?: number; status?: 429 };
    loseOnce?: string[];
  } = {},
): Server {
  let down: [number, number] | null = null;
  const store = new Map<string, string>();
  const outcomes = new Map<string, string>();
  const lost = new Set(opts.loseOnce ?? []);
  let applied = 0;
  let finishes = 0;
  let failed = 0;
  let requests = 0;
  let health = 0;
  let unauthorized = 0;
  let n = 0;
  const KINDS = ['reset', '502', '503'] as const;

  const apply = (raw: Buffer): { runId: string; created: boolean } => {
    const body = RunBody.parse(JSON.parse(raw.toString('utf8')));
    applied += 1;
    const key = `${body.runResult.toolSlug}#${body.runResult.attempt}`;
    const existing = store.get(key);
    if (existing) return { runId: existing, created: false };
    const runId = `00000000-0000-4000-8000-${String(store.size + 1).padStart(12, '0')}`;
    store.set(key, runId);
    outcomes.set(key, body.runResult.outcome);
    if (opts.outage?.afterRuns === store.size && down === null)
      down = [Date.now(), Date.now() + opts.outage.forMs]; // the API goes away right after this run was stored
    return { runId, created: true };
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (opts.outage?.atStart && down === null) down = [Date.now(), Date.now() + opts.outage.forMs];
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    const now = Date.now();
    const raw = init?.body ? Buffer.from(init.body as Buffer) : Buffer.alloc(0);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (down && now >= down[0] && now < down[1]) {
      failed += 1;
      if (url.pathname === '/health') health += 1;
      if (opts.outage?.status === 429)
        return new Response('{"title":"Too Many Requests"}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '8' },
        });
      const kind = KINDS[n++ % KINDS.length];
      if (kind === 'reset') throw reset();
      return new Response(kind === '502' ? 'Bad Gateway' : '{"title":"Service Unavailable"}', {
        status: kind === '502' ? 502 : 503,
        headers: { 'content-type': kind === '502' ? 'text/plain' : 'application/json' },
      });
    }

    if (method === 'POST') {
      const verdict = verifyRequest({
        secret: SECRET,
        timestampHeader: headers[TIMESTAMP_HEADER],
        signatureHeader: headers[SIGNATURE_HEADER],
        rawBody: raw,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!verdict.ok) {
        unauthorized += 1;
        return new Response('{"title":"Unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/health') {
      health += 1;
      return json({ status: 'ok', time: new Date().toISOString() });
    }
    if (url.pathname === '/internal/uploads') {
      const b = JSON.parse(raw.toString('utf8')) as {
        toolSlug: string;
        attempt: number;
        files: { stepId: string; ordinal: number }[];
      };
      return json({
        bucket: 'public-artifacts',
        files: b.files.map((f) => ({
          stepId: f.stepId,
          path: `logs/${CYCLE}/${b.toolSlug}-${b.attempt}/${String(f.ordinal).padStart(2, '0')}-${f.stepId}.log.gz`,
          signedUrl: `https://storage.test/upload/${b.toolSlug}/${f.stepId}?token=T`,
          token: 'T',
        })),
      });
    }
    if (url.pathname === '/internal/runs') {
      const tool = (JSON.parse(raw.toString('utf8')) as { runResult: { toolSlug: string } })
        .runResult.toolSlug;
      const done = apply(raw);
      if (lost.delete(tool)) {
        failed += 1; // the API processed the run; the connection died before the answer arrived
        throw reset();
      }
      return json({ ...done, classification: null });
    }
    if (url.pathname.endsWith('/finish')) {
      finishes += 1;
      return json(
        FinishResponse.parse({
          cycleId: CYCLE,
          valid: true,
          canaryOk: true,
          canaryProblems: [],
          tools: [],
          ignored: null,
          finishedAt: '2026-10-16T12:30:00.000Z',
        }),
      );
    }
    return new Response('{"title":"Not Found"}', { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    store,
    outcomes,
    applied: () => applied,
    finishes: () => finishes,
    failed: () => failed,
    requests: () => requests,
    health: () => health,
    unauthorized: () => unauthorized,
  };
}

const storage = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

function startReport(server: Server) {
  // the client as the report command builds it
  const api = createApiClient({
    baseUrl: 'https://api.test',
    secret: SECRET,
    fetch: server.fetch,
    retryStatuses: REPORT_RETRY_STATUSES,
  });
  const outcome: { value?: Awaited<ReturnType<typeof runReport>>; error?: unknown; done: boolean } =
    {
      done: false,
    };
  void runReport(
    { results, plans, cycleId: CYCLE },
    {
      api,
      fetch: storage,
      github: null,
      writeSummary: async () => undefined,
      log: recordingLogger(),
    },
  ).then(
    (value) => Object.assign(outcome, { value, done: true }),
    (error: unknown) => Object.assign(outcome, { error, done: true }),
  );
  return outcome;
}

/** Moves the virtual clock until the report settles, letting real file I/O progress between steps. */
async function untilDone(outcome: { done: boolean }, limitMs = 30 * 60_000): Promise<number> {
  const start = Date.now();
  while (!outcome.done && Date.now() - start < limitMs) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise<void>((r) => realSetTimeout(r, 1));
  }
  if (!outcome.done) throw new Error('the report did not settle in the virtual time allowed');
  return Date.now() - start;
}

describe('the retry policy the report job uses', () => {
  it('waits long enough in total for an instance that is restarting (a cold start is 30 to 60 seconds)', () => {
    const waits = Array.from({ length: DEFAULT_RETRY.attempts - 1 }, (_, i) =>
      Math.min(DEFAULT_RETRY.maxDelayMs, DEFAULT_RETRY.baseDelayMs * 2 ** i),
    );
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });
});

// The volume of a report, from one address: the API's rate limit exempts a validly signed request (apps/api test/rate-limit-internal.test.ts
// sends three times this volume), so what matters is that the volume does not grow without anyone noticing.
describe('the volume of a report', () => {
  it('is two requests per tool plus the wake-up poll and the finish: an upload and a run each', async () => {
    const server = fakeServer();
    const outcome = startReport(server);
    await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(server.requests()).toBe(TOOLS.length * 2 + 2);
    expect(server.failed()).toBe(0);
  });
});

describe('the API goes away while the report is posting', () => {
  it('for 60 seconds (resets, 502 and 503): the report finishes, every run is stored once, the cycle is finished once', async () => {
    const server = fakeServer({ outage: { afterRuns: 4, forMs: 60_000 } });
    const outcome = startReport(server);
    const took = await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.finish.valid).toBe(true);
    expect([...server.store.keys()].sort()).toEqual(TOOLS.map((t) => `${t}#1`).sort());
    expect(server.finishes()).toBe(1);
    expect(server.failed(), 'the outage was really exercised').toBeGreaterThanOrEqual(4);
    expect(took).toBeGreaterThan(60_000);
    expect(server.unauthorized(), 'a retry after the outage carried a stale signature').toBe(0);
  });

  it('a run the API processed whose answer was lost is stored once, not twice', async () => {
    const server = fakeServer({ loseOnce: ['tool-1-node', 'tool-2-node', 'tool-5-node'] });
    const outcome = startReport(server);
    await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(server.store.size).toBe(TOOLS.length);
    expect(server.applied(), 'the API saw the lost runs again').toBeGreaterThanOrEqual(
      TOOLS.length + 3,
    );
    expect(server.finishes()).toBe(1);
  });

  it('both at once: an outage, and answers lost around it', async () => {
    const server = fakeServer({
      outage: { afterRuns: 4, forMs: 60_000 },
      loseOnce: ['tool-1-node', 'tool-3-node', 'tool-6-node', 'tool-8-node'],
    });
    const outcome = startReport(server);
    await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(server.store.size).toBe(TOOLS.length);
    expect(server.finishes()).toBe(1);
    expect(server.unauthorized()).toBe(0);
  });

  it('asleep when the report starts: the wake-up poll waits for it, then the report runs', async () => {
    const server = fakeServer({ outage: { atStart: true, forMs: 60_000 } });
    const outcome = startReport(server);
    await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(server.health(), 'the wake poll tried more than once').toBeGreaterThanOrEqual(5);
    expect(server.store.size).toBe(TOOLS.length);
    expect(server.finishes()).toBe(1);
  });

  it('the rate limiter answers 429 for a while (a retry storm after a restart): the report waits its Retry-After and every run is stored as it ran', async () => {
    const server = fakeServer({ outage: { afterRuns: 4, forMs: 25_000, status: 429 } });
    const outcome = startReport(server);
    await untilDone(outcome);
    expect(outcome.error).toBeUndefined();
    expect(server.failed(), 'the limiter really answered').toBeGreaterThanOrEqual(4);
    expect(server.store.size).toBe(TOOLS.length);
    expect([...server.outcomes.values()]).toEqual(Array(TOOLS.length).fill('PASS'));
    expect(server.finishes()).toBe(1);
  });

  it('for longer than the client waits: the report stops BEFORE finishing the cycle, and a re-run completes it without duplicates', async () => {
    const server = fakeServer({ outage: { afterRuns: 4, forMs: 400_000 } });
    const first = startReport(server);
    await untilDone(first);
    expect(first.error).toBeInstanceOf(ReportError);
    expect(server.finishes(), 'a cycle must not be finished with results missing').toBe(0);
    const storedBefore = server.store.size;
    expect(
      storedBefore,
      'the first runs were stored before the API went away',
    ).toBeGreaterThanOrEqual(4);
    expect(storedBefore).toBeLessThan(TOOLS.length);

    await vi.advanceTimersByTimeAsync(400_000); // the API is back
    const second = startReport(server);
    await untilDone(second);
    expect(second.error).toBeUndefined();
    expect(server.store.size).toBe(TOOLS.length);
    expect(server.finishes()).toBe(1);
    expect(server.unauthorized()).toBe(0);
  });
});
