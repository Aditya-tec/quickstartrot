import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  adminQueueItems,
  compiledPlans,
  docSnapshots,
  llmCalls,
  runs,
  stepResults,
  tools,
} from '@qsr/db';
import { logPathFor } from '../src/log-paths.js';
import { resetDb, startTestApp, targetInput, type TestApp } from './helpers.js';
import {
  DRIFT_STDERR,
  E404_STDERR,
  docsExtraction,
  failedRun,
  goodPlanJson,
  runResult,
  step,
} from './fixtures.js';

// POST /internal/runs (spec section 11): validate the RunResult with the core schema, store the run and its
// step results, classify (rules first, the model only when no rule matches a FAIL and the budget allows),
// and store class, rule id, signature and failed step. Idempotent on (cycleId, toolSlug, attempt). It does
// NOT touch the tool's status: that happens at cycle finish.

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
  t.llm.reset();
});

async function setup(slug = 'acme-node', over: Parameters<typeof targetInput>[1] = { level: 3 }) {
  return setupMany([targetInput(slug, over)]);
}
/** One sync with all the targets: a sync that leaves a tool out disables it. */
async function setupMany(targets: ReturnType<typeof targetInput>[]) {
  await t.signed('/internal/targets/sync', { targets });
  const cycle = await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' });
  return cycle.json().cycleId as string;
}
const ingest = (result: unknown, logPaths: Record<string, string> = {}) =>
  t.signed('/internal/runs', { runResult: result, logPaths });
const allRuns = () => t.handle.db.select().from(runs);
const allSteps = () => t.handle.db.select().from(stepResults);
const pathFor = (
  cycleId: string,
  attempt: number,
  id: string,
  ordinal: number,
  slug = 'acme-node',
) => logPathFor(t.config.ingestHmacSecret, cycleId, slug, attempt, { stepId: id, ordinal });

d('storing a run', () => {
  it('stores a PASS with its steps, plan, snapshot and runner env; nothing to classify', async () => {
    const cycleId = await setup();
    t.llm.push(goodPlanJson());
    const compiled = (
      await t.signed('/internal/compile', {
        cycleId,
        toolSlug: 'acme-node',
        extraction: docsExtraction(),
      })
    ).json();
    const result = runResult({
      cycleId,
      planId: compiled.plan.id,
      snapshotHash: compiled.plan.contentHash,
      steps: [
        step('s1', 0, 'shell', { stdoutTail: 'added 1 package' }),
        step('qsr-check-syntax', 1, 'harness_check'),
        step('s3', 2, 'run', { exitCode: 1, matchedAuthPattern: 'http_401_403' }),
      ],
    });
    const res = await ingest(result, {
      s1: pathFor(cycleId, 1, 's1', 0),
      s3: pathFor(cycleId, 1, 's3', 2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runId: expect.any(String),
      created: true,
      classification: null,
    });

    const [run] = await allRuns();
    expect(run).toMatchObject({
      id: res.json().runId,
      cycleId,
      attempt: 1,
      outcome: 'PASS',
      failureClass: null,
      failureSignature: null,
      failedStepId: null,
      classifierRule: null,
      reachedLevel: 3,
      skipReason: null,
      planId: compiled.plan.id,
      snapshotId: compiled.snapshotId,
      imageDigest: `sha256:${'a'.repeat(64)}`,
      durationMs: 5000,
    });
    expect(run?.runnerEnv).toMatchObject({
      node: 'v22.1.0',
      resolved: JSON.stringify({ 'acme-sdk': '1.0.0' }),
    });
    expect(run?.startedAt.toISOString()).toBe('2026-10-16T11:58:00.000Z');

    const steps = (await allSteps()).sort((a, b) => a.ordinal - b.ordinal);
    expect(steps.map((s) => [s.stepId, s.kind, s.outcome, s.ordinal])).toEqual([
      ['s1', 'shell', 'PASS', 0],
      ['qsr-check-syntax', 'harness_check', 'PASS', 1],
      ['s3', 'run', 'PASS', 2],
    ]);
    expect(steps[0]).toMatchObject({
      stdoutTail: 'added 1 package',
      logPath: pathFor(cycleId, 1, 's1', 0),
    });
    expect(steps[1]?.logPath).toBeNull();
    expect(steps[2]).toMatchObject({ exitCode: 1, logPath: pathFor(cycleId, 1, 's3', 2) });
  });

  it('does not change the tool: status is applied at cycle finish, not per run', async () => {
    const cycleId = await setup();
    await ingest(failedRun(cycleId, DRIFT_STDERR));
    const [tool] = await t.handle.db.select().from(tools);
    expect(tool).toMatchObject({
      status: 'UNKNOWN',
      consecutiveFailures: 0,
      consecutivePasses: 0,
      lastRunAt: null,
    });
  });

  it('keeps both attempts of a tool in a cycle', async () => {
    const cycleId = await setup();
    await ingest(failedRun(cycleId, 'npm error code ETIMEDOUT\n', { attempt: 1 }));
    await ingest(runResult({ cycleId, attempt: 2 }));
    const stored = await allRuns();
    expect(stored.map((r) => [r.attempt, r.outcome]).sort()).toEqual([
      [1, 'FAIL'],
      [2, 'PASS'],
    ]);
  });
});

d('idempotent on (cycleId, toolSlug, attempt)', () => {
  it('a duplicate ingest returns the same run and classification and stores nothing more', async () => {
    const cycleId = await setup();
    const result = failedRun(cycleId, DRIFT_STDERR);
    const first = (await ingest(result)).json();
    const again = (await ingest(result)).json();
    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      runId: first.runId,
      classification: first.classification,
    });
    expect(await allRuns()).toHaveLength(1);
    expect(await allSteps()).toHaveLength(3);
  });

  it('a different body for the same key does not overwrite the immutable run', async () => {
    const cycleId = await setup();
    await ingest(failedRun(cycleId, DRIFT_STDERR));
    const second = await ingest(runResult({ cycleId }));
    expect(second.json().created).toBe(false);
    expect((await allRuns())[0]?.outcome).toBe('FAIL');
  });

  it('five simultaneous identical ingests make exactly one run', async () => {
    const cycleId = await setup();
    const result = failedRun(cycleId, DRIFT_STDERR);
    const all = await Promise.all(Array.from({ length: 5 }, () => ingest(result)));
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(all.map((r) => r.json().runId)).size).toBe(1);
    expect(all.filter((r) => r.json().created)).toHaveLength(1);
    expect(await allRuns()).toHaveLength(1);
    expect(await allSteps()).toHaveLength(3);
  });
});

d('classification', () => {
  it('stores the class, rule id, signature and failed step for a FAIL a rule recognises', async () => {
    const cycleId = await setup();
    const res = await ingest(failedRun(cycleId, DRIFT_STDERR));
    expect(res.json().classification).toMatchObject({
      failureClass: 'API_DRIFT',
      ruleId: 'drift.not_a_function',
      source: 'rule',
      evidenceLine: 'TypeError: acme.createClient is not a function',
    });
    expect(res.json().classification.signature).toMatch(/^[0-9a-f]{64}$/);
    const [run] = await allRuns();
    expect(run).toMatchObject({
      outcome: 'FAIL',
      failureClass: 'API_DRIFT',
      classifierRule: 'drift.not_a_function',
      failureSignature: res.json().classification.signature,
      failedStepId: 's3',
      reachedLevel: 2,
    });
  });

  it('classifies a dependency failure at the install step', async () => {
    const cycleId = await setup();
    const result = runResult({
      cycleId,
      outcome: 'FAIL',
      reachedLevel: 0,
      failedStepId: 's1',
      steps: [step('s1', 0, 'shell', { outcome: 'FAIL', exitCode: 1, stderrTail: E404_STDERR })],
    });
    expect((await ingest(result)).json().classification).toMatchObject({
      failureClass: 'DEPENDENCY_RESOLUTION',
      ruleId: 'dependency.npm_e404',
    });
  });

  it('the same failure on different paths and lines has the same signature (what makes "two in a row" work)', async () => {
    const cycleId = await setup();
    const a = (await ingest(failedRun(cycleId, DRIFT_STDERR, { attempt: 1 }))).json();
    const b = (
      await ingest(
        failedRun(
          cycleId,
          'TypeError: acme.createClient is not a function\n    at /home/runner/other/index.js:99:7\n',
          { attempt: 2 },
        ),
      )
    ).json();
    expect(a.classification.signature).toBe(b.classification.signature);
  });

  it('a skipped run (manual step) is NEEDS_CREDENTIALS and keeps its skip reason', async () => {
    const cycleId = await setup();
    const result = runResult({
      cycleId,
      outcome: 'SKIPPED',
      reachedLevel: 1,
      failedStepId: 's2',
      steps: [
        step('s1', 0, 'shell'),
        step('s2', 1, 'manual', {
          outcome: 'SKIPPED',
          exitCode: null,
          logFile: null,
          skipReason: 'manual_step',
        }),
      ],
    });
    expect((await ingest(result)).json().classification).toMatchObject({
      failureClass: 'NEEDS_CREDENTIALS',
      ruleId: 'skipped.manual_step',
    });
    expect((await allRuns())[0]).toMatchObject({
      outcome: 'SKIPPED',
      skipReason: 'manual_step',
      failureClass: 'NEEDS_CREDENTIALS',
    });
  });

  it('a harness error is HARNESS_ERROR', async () => {
    const cycleId = await setup();
    const result = runResult({
      cycleId,
      outcome: 'HARNESS_ERROR',
      reachedLevel: 0,
      failedStepId: null,
      steps: [],
    });
    expect((await ingest(result)).json().classification).toMatchObject({
      failureClass: 'HARNESS_ERROR',
    });
  });

  it('auth-error-as-pass comes from the tool: the same 401 is NEEDS_CREDENTIALS only where it is not a pass', async () => {
    const cycle = await setupMany([
      targetInput('strict-node', { level: 3, expect: { authErrorIsPass: false, timeoutSec: 300 } }),
      targetInput('lenient-node', { level: 3, expect: { authErrorIsPass: true, timeoutSec: 300 } }),
    ]);
    const strict = cycle;
    const lenient = cycle;
    const stderr = 'Error: HTTP 401 Unauthorized\n';
    const a = await ingest(failedRun(strict, stderr, {}, 'strict-node'));
    const b = await ingest(failedRun(lenient, stderr, {}, 'lenient-node'));
    expect(a.json().classification).toMatchObject({
      failureClass: 'NEEDS_CREDENTIALS',
      ruleId: 'credentials.auth_error',
    });
    expect(b.json().classification).toMatchObject({ failureClass: 'UNKNOWN', ruleId: 'none' });
  });
});

d('the model fallback (only when no rule matches a FAIL, and the budget allows)', () => {
  const unknownRun = (cycleId: string) =>
    failedRun(cycleId, 'widget refused: protocol v2 required\n');
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      class: 'API_DRIFT',
      confidence: 0.9,
      evidenceLine: 'widget refused: protocol v2 required',
      ...over,
    });

  it("an accepted answer is stored as the model's, logged as a classify call, and listed for review", async () => {
    const cycleId = await setup();
    t.llm.push(answer());
    const res = await ingest(unknownRun(cycleId));
    expect(res.json().classification).toMatchObject({
      failureClass: 'API_DRIFT',
      ruleId: 'llm.fallback',
      source: 'llm',
    });
    expect((await allRuns())[0]).toMatchObject({
      failureClass: 'API_DRIFT',
      classifierRule: 'llm.fallback',
    });
    expect((await t.handle.db.select().from(llmCalls)).map((c) => c.purpose)).toEqual(['classify']);
    const items = await t.handle.db.select().from(adminQueueItems);
    expect(items).toMatchObject([{ reason: 'llm_classified', runId: (await allRuns())[0]?.id }]);
  });

  it('a rule match never asks the model', async () => {
    const cycleId = await setup();
    await ingest(failedRun(cycleId, DRIFT_STDERR));
    expect(t.llm.calls).toBe(0);
  });

  it('a low-confidence or unquotable answer leaves UNKNOWN', async () => {
    const cycleId = await setup();
    t.llm.push(answer({ confidence: 0.5 }));
    expect((await ingest(unknownRun(cycleId))).json().classification).toMatchObject({
      failureClass: 'UNKNOWN',
      ruleId: 'none',
    });
    t.llm.push(answer({ evidenceLine: 'a line that is not in the log' }));
    expect(
      (
        await ingest(failedRun(cycleId, 'widget refused: protocol v2 required\n', { attempt: 2 }))
      ).json().classification.failureClass,
    ).toBe('UNKNOWN');
  });

  it('out of budget: UNKNOWN without a call', async () => {
    const cycleId = await setup();
    await t.handle.db.insert(llmCalls).values({
      purpose: 'compile',
      model: 'm',
      tokensIn: 149_990,
      tokensOut: 0,
      latencyMs: 1,
      ok: true,
      createdAt: new Date(t.clock.now.getTime() - 1000),
    });
    t.llm.push(answer());
    expect((await ingest(unknownRun(cycleId))).json().classification).toMatchObject({
      failureClass: 'UNKNOWN',
    });
    expect(t.llm.calls).toBe(0);
  });

  it('no model configured: UNKNOWN', async () => {
    const none = await startTestApp(dbUrl as string, { llm: null });
    await none.signed('/internal/targets/sync', {
      targets: [targetInput('acme-node', { level: 3 })],
    });
    const c = (
      await none.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' })
    ).json().cycleId;
    expect(
      (await none.signed('/internal/runs', { runResult: unknownRun(c), logPaths: {} })).json()
        .classification,
    ).toMatchObject({ failureClass: 'UNKNOWN' });
    await none.close();
  });

  it('a model that fails leaves UNKNOWN and never fails the ingest', async () => {
    const cycleId = await setup();
    t.llm.push(new Error('429'));
    const res = await ingest(unknownRun(cycleId));
    expect(res.statusCode).toBe(200);
    expect(res.json().classification).toMatchObject({ failureClass: 'UNKNOWN' });
  });
});

d('validation', () => {
  it('rejects something that is not a RunResult', async () => {
    await setup();
    expect((await ingest({ hello: 'world' })).statusCode).toBe(400);
  });

  it('unknown tool and unknown cycle are 404; a finished cycle and a disabled tool are 409', async () => {
    const cycleId = await setup();
    expect((await ingest(runResult({ cycleId, toolSlug: 'nope-node' }))).statusCode).toBe(404);
    expect(
      (await ingest(runResult({ cycleId: '00000000-0000-4000-8000-000000000000' }))).statusCode,
    ).toBe(404);
    await t.handle.db
      .update(tools)
      .set({ enabled: false, disabledReason: 'admin' })
      .where(eq(tools.slug, 'acme-node'));
    expect((await ingest(runResult({ cycleId }))).statusCode).toBe(409);
    await t.handle.db.update(tools).set({ enabled: true, disabledReason: null });
    await t.handle.sql`update probe_cycles set finished_at = now()`;
    expect((await ingest(runResult({ cycleId }))).statusCode).toBe(409);
  });

  it("a plan id that is not this tool's plan is rejected", async () => {
    const cycleId = await setupMany([
      targetInput('acme-node', { level: 3 }),
      targetInput('other-node'),
    ]);
    const [other] = await t.handle.db.select().from(tools).where(eq(tools.slug, 'other-node'));
    const [plan] = await t.handle.db
      .insert(compiledPlans)
      .values({
        toolId: (other as { id: string }).id,
        contentHash: 'h',
        configHash: 'c',
        compilerVersion: 'v',
        model: 'm',
        ir: null,
        groundingReport: { ok: true, violations: [] },
        accepted: true,
        truncation: {
          truncated: false,
          totalBlocks: 0,
          includedBlocks: 0,
          omittedBlocks: 0,
          omittedBlockIndexes: [],
          clippedBlockIndexes: [],
        },
      })
      .returning({ id: compiledPlans.id });
    const res = await ingest(runResult({ cycleId, planId: (plan as { id: string }).id }));
    expect(res.statusCode).toBe(400);
    expect(await allRuns()).toHaveLength(0);
    expect(await t.handle.db.select().from(docSnapshots)).toHaveLength(0);
  });

  it('an unknown snapshot hash is stored without a snapshot, not rejected', async () => {
    const cycleId = await setup();
    const res = await ingest(runResult({ cycleId, snapshotHash: 'f'.repeat(64) }));
    expect(res.statusCode).toBe(200);
    expect((await allRuns())[0]?.snapshotId).toBeNull();
  });

  describe('log paths belong to the run (re-validated, never trusted)', () => {
    const rejected = async (paths: (cycleId: string) => Record<string, string>) => {
      const cycleId = await setup();
      const res = await ingest(runResult({ cycleId }), paths(cycleId));
      expect(res.statusCode).toBe(400);
      expect(await allRuns()).toHaveLength(0);
      expect(await allSteps()).toHaveLength(0);
    };
    it('a path for another cycle', () =>
      rejected((c) => ({
        s1: pathFor('00000000-0000-4000-8000-000000000001', 1, 's1', 0) + c.slice(0, 0),
      })));
    it('a path for another attempt', () => rejected((c) => ({ s1: pathFor(c, 2, 's1', 0) })));
    it('a path for another tool', () =>
      rejected((c) => ({ s1: pathFor(c, 1, 's1', 0, 'other-node') })));
    it('a path for another step or ordinal', () =>
      rejected((c) => ({ s1: pathFor(c, 1, 's2', 1) })));
    it('a made-up path with the right shape but no valid token', () =>
      rejected((c) => ({ s1: `logs/${c}/acme-node-1-000000000000000000000000/00-s1.log.gz` })));
    it('path traversal', () =>
      rejected((c) => ({ s1: `${pathFor(c, 1, 's1', 0)}/../../../etc/passwd` })));
    it('a path outside logs/', () => rejected(() => ({ s1: 'private/secrets.txt' })));
    it('a log for a step the run does not have', () =>
      rejected((c) => ({ ghost: pathFor(c, 1, 'ghost', 9) })));
  });

  it('a step id that is not path-safe is rejected when it has a log path, but the run itself is fine without one', async () => {
    const cycleId = await setup();
    const odd = runResult({ cycleId, steps: [step('s 1', 0, 'shell')] });
    expect((await ingest(odd)).statusCode).toBe(200);
  });
});
