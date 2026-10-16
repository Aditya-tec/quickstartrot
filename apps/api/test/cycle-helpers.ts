import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { tools } from '@qsr/db';
import { CANARY_SLUGS, type RunResult } from '@qsr/core';
import { targetInput, type TestApp } from './helpers.js';
import { DRIFT_STDERR, E404_STDERR, failedRun, runResult, step } from './fixtures.js';

// Whole probe cycles against the test app, for the suites that care about what a cycle leaves behind
// (pre-flight failures, stale plans, the public views). Same shape as the cycle-finish suite.

export const DAY = 24 * 3600 * 1000;
export const BASE = Date.parse('2026-10-16T12:00:00.000Z');
export const at = (day: number, minute = 0): string =>
  new Date(BASE + day * DAY + minute * 60_000).toISOString();

export function stamp(result: RunResult, time: string): RunResult {
  return {
    ...result,
    startedAt: new Date(Date.parse(time) - 5000).toISOString(),
    finishedAt: time,
  };
}

export const pass = (cycleId: string, slug: string, time: string, extra: Partial<RunResult> = {}) =>
  stamp(runResult({ cycleId, toolSlug: slug, ...extra }), time);

export const fail = (
  cycleId: string,
  slug: string,
  stderr: string,
  time: string,
  extra: Partial<RunResult> = {},
) => stamp(failedRun(cycleId, stderr, extra, slug), time);

export function canaryResults(cycleId: string, time: string): RunResult[] {
  return [
    pass(cycleId, 'canary-pass-node', time),
    pass(cycleId, 'canary-pass-python', time),
    fail(cycleId, 'canary-fail-drift', DRIFT_STDERR, time),
    stamp(
      runResult({
        cycleId,
        toolSlug: 'canary-fail-dep',
        outcome: 'FAIL',
        reachedLevel: 0,
        failedStepId: 's1',
        steps: [step('s1', 0, 'shell', { outcome: 'FAIL', exitCode: 1, stderrTail: E404_STDERR })],
      }),
      time,
    ),
  ];
}

/** The four canaries plus these tools, as the sync of one probe cycle would send them. */
export const syncTools = (t: TestApp, ...slugs: string[]) =>
  t.signed('/internal/targets/sync', {
    targets: [...CANARY_SLUGS, ...slugs].map((s) => targetInput(s, { level: 3 })),
  });

export async function newCycle(t: TestApp, day: number): Promise<string> {
  t.clock.now = new Date(BASE + day * DAY);
  const res = await t.signed('/internal/cycles', { trigger: 'manual', gitSha: 'abcdef1234567' });
  return res.json().cycleId as string;
}

export async function postRuns(
  t: TestApp,
  results: RunResult[],
  extra: object = {},
): Promise<void> {
  for (const r of results) {
    const res = await t.signed('/internal/runs', { runResult: r, logPaths: {}, ...extra });
    expect(res.statusCode, `${r.toolSlug}: ${res.body}`).toBe(200);
  }
}

export const finishCycle = (t: TestApp, cycleId: string) =>
  t.signed(`/internal/cycles/${cycleId}/finish`);

export const toolRow = async (t: TestApp, slug: string) =>
  (await t.handle.db.select().from(tools).where(eq(tools.slug, slug)))[0];
