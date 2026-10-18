import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FinishResponse,
  type Manifest,
  RunBody,
  STEP_LOG_MAX_BYTES,
  type PlanFile,
  type RunResult,
  type UploadsBody,
} from '@qsr/core';
import { ApiError } from '../api-client.js';
import { GitHubError } from './github.js';
import {
  REPORT_CONCURRENCY,
  ReportError,
  runReport,
  type ReportDeps,
  type ReportOptions,
} from './report.js';
import {
  CYCLE,
  HASH,
  PLAN_ID,
  canaryTarget,
  readyPlan,
  recordingLogger,
  runResultFor,
  target,
} from './probe.test-utils.js';

// `qsr report` (spec section 12): for each result, get signed upload URLs, upload gzipped logs, POST the run;
// post the pre-failed entries; report a HARNESS_ERROR for a planned tool nobody ran; then finish the cycle.
// Results come from a job that ran docs code, so they are untrusted data: validated, capped, re-redacted.

let dir: string;
let plans: string;
let results: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-report-'));
  plans = path.join(dir, 'plans');
  results = path.join(dir, 'results');
  await mkdir(plans, { recursive: true });
  await mkdir(results, { recursive: true });
});

async function writePlans(files: PlanFile[], over: Partial<Manifest> = {}) {
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
    ...over,
  };
  await writeFile(path.join(plans, 'manifest.json'), JSON.stringify(manifest));
}

/** Writes results/<slug>-<attempt>.json and one log per step (in `dirPath`, default the results dir). */
async function writeResult(
  result: RunResult,
  logs: Record<string, string> = {},
  dirPath = results,
) {
  await mkdir(path.join(dirPath, `${result.toolSlug}-${result.attempt}`), { recursive: true });
  const steps = result.steps.map((s) => ({
    ...s,
    logFile:
      s.stepId in logs
        ? `${result.toolSlug}-${result.attempt}/${String(s.ordinal).padStart(2, '0')}-${s.stepId}.log`
        : null,
  }));
  const withLogs = { ...result, steps };
  for (const s of steps)
    if (s.logFile) await writeFile(path.join(dirPath, s.logFile), logs[s.stepId] as string);
  await writeFile(
    path.join(dirPath, `${result.toolSlug}-${result.attempt}.json`),
    JSON.stringify(withLogs),
  );
  return withLogs;
}

const ok = (slug: string, over: Partial<RunResult> = {}) => runResultFor(slug, over);
const failed = (slug: string, over: Partial<RunResult> = {}) =>
  runResultFor(slug, { outcome: 'FAIL', reachedLevel: 2, failedStepId: 's1', ...over });

interface Stored {
  body: RunBody;
  runId: string;
}
function fakeApi(
  opts: {
    runError?: (body: RunBody) => Error | null;
    uploadError?: boolean;
    finish?: Partial<FinishResponse>;
    /** Milliseconds each call takes, so tests can see what overlaps. */
    latencyMs?: (path: string, body: unknown) => number;
  } = {},
) {
  const calls: { path: string; body: unknown }[] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const stored = new Map<string, Stored>();
  const uploads: UploadsBody[] = [];
  let n = 0;
  const api: ReportDeps['api'] = {
    wakeApi: async () => {
      calls.push({ path: 'wake', body: null });
      return { attempts: 1, waitedMs: 0 };
    },
    post: (async (p: string, body: unknown) => {
      calls.push({ path: p, body });
      inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        const wait = opts.latencyMs?.(p, body) ?? 0;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        return await answer(p, body);
      } finally {
        inFlight -= 1;
      }
    }) as ReportDeps['api']['post'],
  };
  const answer = async (p: string, body: unknown): Promise<unknown> => {
    {
      if (p === '/internal/uploads') {
        if (opts.uploadError) throw new ApiError(502, 'Bad Gateway', 'storage', 'POST x');
        const b = body as UploadsBody;
        uploads.push(b);
        return {
          bucket: 'public-artifacts',
          files: b.files.map((f) => ({
            stepId: f.stepId,
            path: `logs/${b.cycleId}/${b.toolSlug}-${b.attempt}-tok/${String(f.ordinal).padStart(2, '0')}-${f.stepId}.log.gz`,
            signedUrl: `https://storage.test/upload/${b.toolSlug}/${b.attempt}/${f.stepId}?token=T`,
            token: 'T',
          })),
        };
      }
      if (p === '/internal/runs') {
        const parsed = RunBody.parse(body);
        const err = opts.runError?.(parsed);
        if (err) throw err;
        const key = `${parsed.runResult.toolSlug}#${parsed.runResult.attempt}`;
        const existing = stored.get(key);
        if (existing) return { runId: existing.runId, created: false, classification: null };
        const runId = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        stored.set(key, { body: parsed, runId });
        const out = parsed.runResult.outcome;
        return {
          runId,
          created: true,
          classification: parsed.preflight
            ? {
                failureClass: parsed.preflight.failureClass,
                ruleId: 'preflight',
                signature: 's',
                evidenceLine: null,
                source: 'rule',
              }
            : out === 'FAIL'
              ? {
                  failureClass: 'API_DRIFT',
                  ruleId: 'r',
                  signature: 's',
                  evidenceLine: null,
                  source: 'rule',
                }
              : null,
        };
      }
      if (p.endsWith('/finish'))
        return FinishResponse.parse({
          cycleId: CYCLE,
          valid: true,
          canaryOk: true,
          canaryProblems: [],
          tools: [],
          ignored: null,
          finishedAt: '2026-10-16T12:30:00.000Z',
          ...opts.finish,
        });
      throw new Error(`fakeApi: unexpected ${p}`);
    }
  };
  return { api, calls, stored, uploads, stats, paths: () => calls.map((c) => c.path) };
}

function fakeStorage(fail = false) {
  const puts: { url: string; headers: Record<string, string>; text: string }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const file = form.get('') as Blob;
    const bytes = Buffer.from(await file.arrayBuffer());
    puts.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      text: gunzipSync(bytes).toString('utf8'),
    });
    if (fail) return new Response('nope', { status: 500 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { puts, fetchFn };
}

interface Run {
  api?: ReturnType<typeof fakeApi>;
  storage?: ReturnType<typeof fakeStorage>;
  github?: ReportDeps['github'];
  options?: Partial<ReportOptions>;
}
async function report(r: Run = {}) {
  const api = r.api ?? fakeApi();
  const storage = r.storage ?? fakeStorage();
  const summaries: string[] = [];
  const logger = recordingLogger();
  const outcome = await runReport(
    { results, plans, cycleId: CYCLE, ...r.options },
    {
      api: api.api,
      fetch: storage.fetchFn,
      github: r.github ?? null,
      writeSummary: async (md) => void summaries.push(md),
      log: logger,
    },
  );
  return { outcome, api, storage, summaries, logger };
}

const a = target('a-node');
const b = target('b-node');
const canaryPass = canaryTarget('canary-pass-node');

describe('posting results', () => {
  it("wakes the API, uploads a tool's logs, posts the run with their paths, and finishes last", async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'npm install ok\n' });
    const { api, storage } = await report();
    expect(api.paths()).toEqual([
      'wake',
      '/internal/uploads',
      '/internal/runs',
      `/internal/cycles/${CYCLE}/finish`,
    ]);
    expect(api.uploads[0]).toEqual({
      cycleId: CYCLE,
      toolSlug: 'a-node',
      attempt: 1,
      files: [{ stepId: 's1', ordinal: 0 }],
    });
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.text).toBe('npm install ok\n');
    const run = [...api.stored.values()][0]?.body as RunBody;
    expect(Object.values(run.logPaths)[0]).toMatch(/^logs\/.*\/00-s1\.log\.gz$/);
    expect(run.preflight).toBeUndefined();
  });

  it('uploads with an upsert header, to the signed URL, and sends the anon key only when it has one', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const { storage } = await report({ options: { anonKey: 'anon-public-key' } });
    expect(storage.puts[0]?.url).toContain('https://storage.test/upload/a-node/1/s1?token=T');
    expect(storage.puts[0]?.headers['x-upsert']).toBe('true');
    expect(storage.puts[0]?.headers['apikey']).toBe('anon-public-key');
    await mkdir(results, { recursive: true });
    const second = await report();
    expect(second.storage.puts[0]?.headers['apikey']).toBeUndefined();
  });

  it('posts every attempt, in order; the summary shows the final one', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(failed('a-node', { attempt: 1 }), { s1: 'timeout' });
    await writeResult(ok('a-node', { attempt: 2 }), { s1: 'fine' });
    const { api, summaries } = await report();
    const runs = api.calls
      .filter((c) => c.path === '/internal/runs')
      .map((c) => (c.body as RunBody).runResult.attempt);
    expect(runs).toEqual([1, 2]);
    expect(summaries[0]).toMatch(/\| a-node \| L3 \/ L3 \| PASS \|/);
  });

  it('posts a run even when it has no logs at all', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const { api } = await report();
    expect(api.paths()).not.toContain('/internal/uploads');
    expect(api.stored.size).toBe(1);
  });

  it('a failed log upload does not lose the run: it is posted without those log paths', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const { api, logger } = await report({ storage: fakeStorage(true) });
    const run = [...api.stored.values()][0]?.body as RunBody;
    expect(run.logPaths).toEqual({});
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('a 409 from the upload endpoint means the cycle is already finished: quietly no uploads, the run still goes in', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const api = fakeApi();
    const real = api.api.post;
    api.api.post = (async (p: string, body: unknown) => {
      if (p === '/internal/uploads')
        throw new ApiError(
          409,
          'Conflict',
          'This cycle is already finished.',
          'POST /internal/uploads',
        );
      return real(p, body);
    }) as typeof real;
    const { logger, storage } = await report({ api });
    expect(storage.puts).toHaveLength(0);
    expect(api.stored.size).toBe(1);
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(0);
  });

  it('an upload-URL failure is the same: the run still goes in', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const { api } = await report({ api: fakeApi({ uploadError: true }) });
    expect(api.stored.size).toBe(1);
  });
});

describe('logs are untrusted data', () => {
  it('are redacted again before upload, even if the executor missed something', async () => {
    await writePlans([readyPlan(a, 0)]);
    const secret = ['ghp', '_', 'a'.repeat(36)].join('');
    await writeResult(ok('a-node'), {
      s1: `token=${secret}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n`,
    });
    const { storage } = await report();
    expect(storage.puts[0]?.text).not.toContain(secret);
    expect(storage.puts[0]?.text).toContain('[REDACTED]');
  });

  it('are capped at the log size limit', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), { s1: 'x'.repeat(STEP_LOG_MAX_BYTES * 3) });
    const { storage } = await report();
    expect(Buffer.byteLength(storage.puts[0]?.text ?? '')).toBeLessThan(STEP_LOG_MAX_BYTES + 512);
    expect(storage.puts[0]?.text).toMatch(/truncated by the report job/);
  });

  it('a step id that could escape the log path is not uploaded', async () => {
    await writePlans([readyPlan(a, 0)]);
    const evil = ok('a-node', {
      steps: [
        {
          stepId: '../../etc/passwd',
          ordinal: 0,
          kind: 'shell',
          outcome: 'PASS',
          exitCode: 0,
          durationMs: 1,
          stdoutTail: null,
          stderrTail: null,
          logFile: 'a-node-1/00-evil.log',
          matchedAuthPattern: null,
          skipReason: null,
        },
      ],
    });
    await mkdir(path.join(results, 'a-node-1'), { recursive: true });
    await writeFile(path.join(results, 'a-node-1', '00-evil.log'), 'x');
    await writeFile(path.join(results, 'a-node-1.json'), JSON.stringify(evil));
    const { api, storage } = await report();
    expect(storage.puts).toHaveLength(0);
    expect(api.stored.size).toBe(1);
  });

  it('a log file path that points outside the results directory is never read', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeFile(path.join(dir, 'secret.txt'), 'top secret');
    const sneaky = ok('a-node');
    sneaky.steps[0] = {
      ...(sneaky.steps[0] as RunResult['steps'][number]),
      logFile: '../secret.txt',
    };
    await writeFile(path.join(results, 'a-node-1.json'), JSON.stringify(sneaky));
    const { storage } = await report();
    expect(storage.puts).toHaveLength(0);
  });

  it('a result that does not parse is ignored and the tool is reported as a harness error', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeFile(path.join(results, 'a-node-1.json'), '{"outcome":"PASS","evil":true}');
    const { api } = await report();
    const run = [...api.stored.values()][0]?.body as RunBody;
    expect(run.runResult.outcome).toBe('HARNESS_ERROR');
  });

  it('a result for another cycle, or for a tool that was not planned, is ignored', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node', { cycleId: '11111111-1111-4111-8111-111111111111' }), {});
    await writeResult(ok('stranger-node'), {});
    const { api } = await report();
    const posted = api.calls
      .filter((c) => c.path === '/internal/runs')
      .map((c) => (c.body as RunBody).runResult);
    expect(posted.map((r) => r.toolSlug)).toEqual(['a-node']);
    expect(posted[0]?.outcome).toBe('HARNESS_ERROR');
  });

  it('an oversized result file is ignored', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeFile(
      path.join(results, 'a-node-1.json'),
      JSON.stringify({ pad: 'x'.repeat(2_000_000) }),
    );
    const { api } = await report();
    expect([...api.stored.values()][0]?.body.runResult.outcome).toBe('HARNESS_ERROR');
  });
});

describe('planned tools that did not produce a result', () => {
  it('a missing result becomes a HARNESS_ERROR run, which the API keeps out of every status', async () => {
    await writePlans([readyPlan(a, 0), readyPlan(b, 1)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const { api, summaries } = await report();
    const bRun = [...api.stored.values()]
      .map((s) => s.body)
      .find((x) => x.runResult.toolSlug === 'b-node');
    expect(bRun?.runResult).toMatchObject({
      outcome: 'HARNESS_ERROR',
      attempt: 1,
      cycleId: CYCLE,
      planId: PLAN_ID,
      snapshotHash: HASH,
      steps: [],
    });
    expect(bRun?.runResult.runnerEnv['harness_error']).toMatch(/no result.*shard 1/i);
    expect(bRun?.preflight).toBeUndefined();
    expect(summaries[0]).toMatch(/\| b-node \| - \/ L3 \| HARNESS_ERROR \| HARNESS_ERROR \|/);
  });

  it('a whole shard that never uploaded gives every one of its tools a HARNESS_ERROR run', async () => {
    await writePlans([readyPlan(a, 0), readyPlan(b, 1), readyPlan(target('c-node'), 1)]);
    await writeResult(ok('a-node'), {});
    const { api } = await report();
    const bySlug = Object.fromEntries(
      [...api.stored.values()].map((s) => [s.body.runResult.toolSlug, s.body.runResult.outcome]),
    );
    expect(bySlug).toEqual({
      'a-node': 'PASS',
      'b-node': 'HARNESS_ERROR',
      'c-node': 'HARNESS_ERROR',
    });
  });
});

describe('pre-failed and deferred entries', () => {
  const crawlFailed = (slug: string): PlanFile => ({
    version: 1,
    toolSlug: slug,
    cycleId: CYCLE,
    isCanary: false,
    target: target(slug),
    weightMs: null,
    state: 'pre_failed',
    preflight: {
      stage: 'crawl',
      failureClass: 'CRAWL_ERROR',
      reason: 'no_code_blocks',
      message: 'no code',
    },
    planId: null,
    snapshotHash: null,
  });
  const deferred = (slug: string): PlanFile => ({
    version: 1,
    toolSlug: slug,
    cycleId: CYCLE,
    isCanary: false,
    target: target(slug),
    weightMs: null,
    state: 'deferred',
    reason: 'llm_budget',
  });

  it('posts a pre-failed entry as a synthetic FAIL run with the preflight object', async () => {
    await writePlans([crawlFailed('bad-node')]);
    const { api, summaries } = await report();
    const body = [...api.stored.values()][0]?.body as RunBody;
    expect(body.preflight).toEqual({
      stage: 'crawl',
      failureClass: 'CRAWL_ERROR',
      reason: 'no_code_blocks',
      message: 'no code',
    });
    expect(body.runResult).toMatchObject({
      toolSlug: 'bad-node',
      outcome: 'FAIL',
      reachedLevel: 0,
      failedStepId: null,
      steps: [],
      attempt: 1,
    });
    expect(summaries[0]).toMatch(
      /\| bad-node \| - \/ L3 \| FAIL \| CRAWL_ERROR \|.*no_code_blocks/,
    );
  });

  it('a deferred entry posts nothing and shows as an informational skip', async () => {
    await writePlans([deferred('skip-node')]);
    const { api, summaries } = await report();
    expect(api.stored.size).toBe(0);
    expect(summaries[0]).toMatch(/\| skip-node \|.*\| SKIPPED \|.*deferred: llm_budget/);
  });
});

describe('the canary guard of each shard', () => {
  const guardPlan = readyPlan(canaryPass, 0, { planId: null });
  const guardDir = (n: number) => path.join(results, 'guards', `shard-${n}`);

  it('a guard that PASSED is not posted (the primary canary result already is)', async () => {
    await writePlans([guardPlan, readyPlan(a, 1)], { guards: [1] });
    await writeResult(ok('canary-pass-node', { planId: null }), {});
    await mkdir(guardDir(1), { recursive: true });
    await writeResult(ok('canary-pass-node', { planId: null }), {}, guardDir(1));
    await writeResult(ok('a-node'), {});
    const { api } = await report();
    const canaryRuns = api.calls
      .filter((c) => c.path === '/internal/runs')
      .map((c) => (c.body as RunBody).runResult)
      .filter((r) => r.toolSlug === 'canary-pass-node');
    expect(canaryRuns).toHaveLength(1);
  });

  it('a guard that FAILED is posted as a later attempt, so the canary check fails the cycle', async () => {
    await writePlans([guardPlan, readyPlan(a, 1)], { guards: [1] });
    await writeResult(ok('canary-pass-node', { planId: null }), {});
    await writeResult(
      failed('canary-pass-node', { planId: null }),
      { s1: 'the runner of shard 1 is broken' },
      guardDir(1),
    );
    await writeResult(ok('a-node'), {});
    const { api } = await report();
    const canaryRuns = api.calls
      .filter((c) => c.path === '/internal/runs')
      .map((c) => (c.body as RunBody).runResult)
      .filter((r) => r.toolSlug === 'canary-pass-node');
    expect(canaryRuns.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, 'PASS'],
      [11, 'FAIL'],
    ]);
    expect(canaryRuns[1]?.runnerEnv['shard']).toBe('1');
  });

  it('a shard whose guard result is missing is a warning (its tools are covered by the missing-result rule)', async () => {
    await writePlans([guardPlan, readyPlan(a, 1)], { guards: [1] });
    await writeResult(ok('canary-pass-node', { planId: null }), {});
    const { logger, api } = await report();
    expect(logger.lines.some((l) => l.level === 'warn' && String(l.msg).includes('guard'))).toBe(
      true,
    );
    const canaryRuns = api.calls
      .filter((c) => c.path === '/internal/runs')
      .map((c) => (c.body as RunBody).runResult)
      .filter((r) => r.toolSlug === 'canary-pass-node');
    expect(canaryRuns).toHaveLength(1);
  });
});

describe('finishing the cycle', () => {
  it("returns the API's verdict, and an invalid cycle is called out in the summary", async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const finish = {
      valid: false,
      canaryOk: false,
      canaryProblems: ['canary-pass-node: expected PASS but got FAIL (API_DRIFT)'],
      ignored: 'cycle_ignored: x',
    };
    const { outcome, summaries } = await report({ api: fakeApi({ finish }) });
    expect(outcome.finish.valid).toBe(false);
    expect(summaries[0]).toMatch(/INVALID/);
    expect(summaries[0]).toContain('canary-pass-node: expected PASS but got FAIL (API_DRIFT)');
  });

  it('writes the step summary once, with a link to each run when the web URL is known', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const { summaries } = await report({ options: { webBaseUrl: 'https://qsr.vercel.app' } });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/\[run\]\(https:\/\/qsr\.vercel\.app\/runs\/00000000-/);
  });

  it('marks a stale-plan run in the summary', async () => {
    await writePlans([readyPlan(a, 0, { stale: true })]);
    await writeResult(ok('a-node'), {});
    const { summaries } = await report();
    expect(summaries[0]).toMatch(/\| stale plan \|/);
  });

  it('refuses to report a different cycle than the plans describe', async () => {
    await writePlans([readyPlan(a, 0)]);
    await expect(
      report({ options: { cycleId: '22222222-2222-4222-8222-222222222222' } }),
    ).rejects.toBeInstanceOf(ReportError);
  });
});

describe('concurrency: tools are reported four at a time (the ingest is idempotent)', () => {
  const slugs = Array.from({ length: 12 }, (_, i) => 't' + String(i).padStart(2, '0') + '-node');
  async function twelve() {
    await writePlans(slugs.map((slug, i) => readyPlan(target(slug), i % 2)));
    for (const slug of slugs)
      await writeResult(ok(slug), { s1: 'npm install ok' + String.fromCharCode(10) });
  }
  const FIVE = (p: string) => (p === '/internal/uploads' || p === '/internal/runs' ? 25 : 0);

  it('never has more than four tools in flight, and really overlaps them', async () => {
    await twelve();
    const api = fakeApi({ latencyMs: FIVE });
    await report({ api });
    expect(REPORT_CONCURRENCY).toBe(4);
    expect(api.stats.maxInFlight).toBeLessThanOrEqual(REPORT_CONCURRENCY);
    expect(api.stats.maxInFlight).toBeGreaterThanOrEqual(3);
    expect(api.stored.size).toBe(12);
  });

  it('reports one tool at a time when asked for a concurrency of 1 (the pre-P9a behaviour)', async () => {
    await twelve();
    const api = fakeApi({ latencyMs: FIVE });
    await report({ api, options: { concurrency: 1 } });
    expect(api.stats.maxInFlight).toBe(1);
    expect(api.stored.size).toBe(12);
  });

  it('keeps the calls of one tool in order: its uploads, then its run; attempts in order', async () => {
    await writePlans(slugs.slice(0, 6).map((slug, i) => readyPlan(target(slug), i % 2)));
    for (const slug of slugs.slice(0, 6)) {
      await writeResult(failed(slug, { attempt: 1 }), { s1: 'one' });
      await writeResult(ok(slug, { attempt: 2 }), { s1: 'two' });
    }
    const api = fakeApi({ latencyMs: FIVE });
    await report({ api });
    for (const slug of slugs.slice(0, 6)) {
      const mine = api.calls
        .filter(
          (c) =>
            (c.body as { toolSlug?: string; runResult?: { toolSlug: string } })?.toolSlug ===
              slug ||
            (c.body as { runResult?: { toolSlug: string } })?.runResult?.toolSlug === slug,
        )
        .map(
          (c) =>
            c.path.replace('/internal/', '') +
            ((c.body as { attempt?: number }).attempt ??
              (c.body as { runResult?: { attempt: number } }).runResult?.attempt ??
              ''),
        );
      expect(mine, slug).toEqual(['uploads1', 'runs1', 'uploads2', 'runs2']);
    }
  });

  it('finishes the cycle last, after every run was posted', async () => {
    await twelve();
    const api = fakeApi({ latencyMs: FIVE });
    await report({ api });
    expect(api.paths().at(-1)).toBe('/internal/cycles/' + CYCLE + '/finish');
    expect(api.paths().filter((p) => p.endsWith('/finish'))).toHaveLength(1);
    expect(api.paths().filter((p) => p === '/internal/runs')).toHaveLength(12);
  });

  it('writes the same summary whatever order the answers arrive in', async () => {
    await twelve();
    const forward = await report({
      api: fakeApi({
        latencyMs: (p, b) =>
          p === '/internal/runs'
            ? 5 + (Number((b as RunBody).runResult.toolSlug.slice(1, 3)) % 4) * 9
            : 0,
      }),
    });
    const backward = await report({
      api: fakeApi({
        latencyMs: (p, b) =>
          p === '/internal/runs'
            ? 5 + (3 - (Number((b as RunBody).runResult.toolSlug.slice(1, 3)) % 4)) * 9
            : 0,
      }),
    });
    expect(forward.summaries).toEqual(backward.summaries);
    expect(forward.outcome.rows.map((r) => r.slug)).toEqual(
      backward.outcome.rows.map((r) => r.slug),
    );
    expect(forward.outcome.rows.map((r) => r.slug)).toEqual(slugs);
  });

  it('is clearly faster than one tool at a time (12 tools, 25 ms per call)', async () => {
    // Measured against a sequential run on the same machine and in the same test, never against a fixed number of
    // milliseconds: a loaded CI runner slows both and the ratio holds (the fixed bound failed once on CI at 423 ms).
    await twelve();
    const t0 = Date.now();
    await report({ api: fakeApi({ latencyMs: FIVE }), options: { concurrency: 1 } });
    const sequential = Date.now() - t0;
    const t1 = Date.now();
    await report({ api: fakeApi({ latencyMs: FIVE }) });
    const concurrent = Date.now() - t1;
    // one at a time is 12 x 2 calls x 25 ms = 600 ms; four at a time is about a quarter of that
    expect(concurrent).toBeLessThan(sequential * 0.75);
  });

  it('one failing run stops the report before finishing, and no tool still queued is started after it', async () => {
    await twelve();
    const api = fakeApi({
      latencyMs: FIVE,
      runError: (body) =>
        body.runResult.toolSlug === 't01-node'
          ? new ApiError(503, 'x', undefined, 'POST /internal/runs')
          : null,
    });
    await expect(report({ api })).rejects.toBeInstanceOf(ReportError);
    expect(api.paths().some((p) => p.endsWith('/finish'))).toBe(false);
    // t01 was in the first four, so most of the twelve were never started
    expect(api.paths().filter((p) => p === '/internal/runs').length).toBeLessThan(12);
  });

  it('a re-run after that failure completes the cycle without duplicating anything', async () => {
    await twelve();
    const api = fakeApi({ latencyMs: FIVE });
    await expect(
      report({
        api: fakeApi({
          runError: (b) =>
            b.runResult.toolSlug === 't05-node' ? new Error('Could not reach the API') : null,
        }),
      }),
    ).rejects.toBeInstanceOf(ReportError);
    await report({ api });
    expect(api.stored.size).toBe(12);
  });
});

describe('idempotency: running the report twice changes nothing', () => {
  it('the second run creates no duplicate runs and finishes with the same answer', async () => {
    await writePlans([readyPlan(a, 0), readyPlan(b, 1)]);
    await writeResult(ok('a-node'), { s1: 'x' });
    const api = fakeApi();
    const first = await report({ api });
    const second = await report({ api });
    expect(api.stored.size).toBe(2); // a-node and the synthetic b-node HARNESS_ERROR
    expect(first.outcome.finish).toEqual(second.outcome.finish);
    const runCalls = api.calls.filter((c) => c.path === '/internal/runs');
    expect(runCalls).toHaveLength(4); // 2 per report, the API deduplicates
  });
});

describe('failures of the API', () => {
  it('a 4xx on one run replaces it with a HARNESS_ERROR run: one bad result cannot stop the cycle', async () => {
    await writePlans([readyPlan(a, 0), readyPlan(b, 0)]);
    await writeResult(ok('a-node'), {});
    await writeResult(ok('b-node'), {});
    const api = fakeApi({
      runError: (body) =>
        body.runResult.toolSlug === 'a-node' && body.runResult.outcome === 'PASS'
          ? new ApiError(
              400,
              'Bad Request',
              'The plan id is not a plan of this tool.',
              'POST /internal/runs',
            )
          : null,
    });
    const { api: used } = await report({ api });
    const a1 = [...used.stored.values()]
      .map((s) => s.body.runResult)
      .find((r) => r.toolSlug === 'a-node');
    expect(a1?.outcome).toBe('HARNESS_ERROR');
    expect(a1?.runnerEnv['harness_error']).toMatch(/API rejected/i);
    expect(used.paths().at(-1)).toMatch(/finish$/);
  });

  it('a 5xx that outlasts the client retries stops the report BEFORE finishing, so a re-run can complete it', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const api = fakeApi({
      runError: () => new ApiError(503, 'Service Unavailable', undefined, 'POST /internal/runs'),
    });
    await expect(report({ api })).rejects.toBeInstanceOf(ReportError);
    expect(api.paths().some((p) => p.endsWith('/finish'))).toBe(false);
  });

  it('a network error posting a run also stops the report', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const api = fakeApi({ runError: () => new Error('Could not reach https://api.test') });
    await expect(report({ api })).rejects.toBeInstanceOf(ReportError);
  });

  it('a finish that fails is a report failure', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const api = fakeApi();
    const real = api.api.post;
    api.api.post = (async (p: string, body: unknown) => {
      if (p.endsWith('/finish'))
        throw new ApiError(500, 'Internal Server Error', undefined, 'POST finish');
      return real(p, body);
    }) as typeof real;
    await expect(report({ api })).rejects.toBeInstanceOf(ReportError);
  });
});

describe('the alert channel', () => {
  const calls: { title: string; body: string }[] = [];
  const github: NonNullable<ReportDeps['github']> = async (problem) => {
    calls.push(problem);
    return { action: 'created', url: 'https://github.com/o/r/issues/1' };
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it('a valid cycle with no harness errors raises nothing', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    await report({ github });
    expect(calls).toHaveLength(0);
  });

  it('an invalid cycle opens (or comments on) the harness issue, with the canary problems', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    await report({
      github,
      api: fakeApi({
        finish: {
          valid: false,
          canaryOk: false,
          canaryProblems: ['canary-fail-dep: no result in this cycle'],
        },
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('canary-fail-dep: no result in this cycle');
    expect(calls[0]?.body).toContain(CYCLE);
    expect(calls[0]?.title).toMatch(/invalid/i);
  });

  it('a harness error rate above 5% raises it; the canaries do not count in the rate', async () => {
    const real = Array.from({ length: 10 }, (_, i) => target(`t${i}-node`));
    await writePlans([
      ...real.map((t) => readyPlan(t, 0)),
      readyPlan(canaryPass, 0, { planId: null }),
    ]);
    for (const t of real.slice(1)) await writeResult(ok(t.slug), {});
    await writeResult(ok('canary-pass-node', { planId: null }), {});
    // t0 has no result: 1 harness error out of 10 tools = 10%
    const { outcome } = await report({ github });
    expect(outcome.harnessRate).toBeCloseTo(0.1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.title).toMatch(/harness/i);
  });

  it('exactly 5% does not raise it (the rule is "exceeds")', async () => {
    const real = Array.from({ length: 20 }, (_, i) =>
      target(`t${String(i).padStart(2, '0')}-node`),
    );
    await writePlans(real.map((t) => readyPlan(t, 0)));
    for (const t of real.slice(1)) await writeResult(ok(t.slug), {});
    const { outcome } = await report({ github });
    expect(outcome.harnessRate).toBeCloseTo(0.05);
    expect(calls).toHaveLength(0);
  });

  it('a GitHub failure is logged and never fails the report', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const boom: NonNullable<ReportDeps['github']> = async () => {
      throw new GitHubError('403 forbidden');
    };
    const { outcome, logger } = await report({
      github: boom,
      api: fakeApi({ finish: { valid: false, canaryOk: false, canaryProblems: ['x'] } }),
    });
    expect(outcome.finish.valid).toBe(false);
    expect(logger.lines.some((l) => l.level === 'error' && String(l.msg).includes('issue'))).toBe(
      true,
    );
  });

  it('with no token (a local run) the problem is only logged', async () => {
    await writePlans([readyPlan(a, 0)]);
    await writeResult(ok('a-node'), {});
    const { logger } = await report({
      github: null,
      api: fakeApi({ finish: { valid: false, canaryOk: false, canaryProblems: ['x'] } }),
    });
    expect(logger.lines.some((l) => l.level === 'warn' && String(l.msg).includes('harness'))).toBe(
      true,
    );
  });
});
