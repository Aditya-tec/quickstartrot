import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { classify, inputFromRunResult } from '@qsr/classifier';
import type { Logger, RunResult } from '@qsr/core';
import type { CliIo } from './commands.js';
import { runCommand } from './run.js';

// The four canaries (spec section 6) through the real pipeline: real Chromium crawl of the fixture
// pages, the committed golden plans, real Docker, and the real npm and PyPI registries. They prove
// the HARNESS gives the known answers. Skipped without Docker unless QSR_REQUIRE_DOCKER=1 (CI).

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TARGETS = path.join(REPO, 'targets');

async function dockerUp(): Promise<boolean> {
  try {
    await run('docker', ['info'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const available = process.env['QSR_SKIP_DOCKER_TESTS'] !== '1' && (await dockerUp());
const required = process.env['QSR_REQUIRE_DOCKER'] === '1';

it.runIf(required && !available)('Docker must be available when QSR_REQUIRE_DOCKER=1', () => {
  expect(available).toBe(true);
});

/** The classifier's verdict on a canary's RunResult (the stored tails; the target asserts no auth-as-pass). */
const classOf = (result: RunResult, language: 'node' | 'python') => {
  const input = inputFromRunResult(result, { language, targetLevel: 3, authErrorIsPass: false });
  return input === null ? null : classify(input);
};

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function qsrRun(
  slug: string,
): Promise<{ code: number; out: string; err: string; result: RunResult }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) };
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-canary-'));
  const code = await runCommand(
    [slug, '--local-images', '--json', '--targets', TARGETS, '--out', outDir],
    quiet,
    io,
  );
  const parsed = JSON.parse(out.join('')) as { result: RunResult };
  return { code, out: out.join(''), err: err.join(''), result: parsed.result };
}

describe.skipIf(!available)('canaries (real Docker, real registries)', () => {
  it('canary-pass-node PASSES at L3 and records the pinned dependency it resolved', async () => {
    const r = await qsrRun('canary-pass-node');
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ outcome: 'PASS', reachedLevel: 3, failedStepId: null });
    expect(classOf(r.result, 'node')).toBeNull(); // a PASS has nothing to classify
    expect(JSON.parse(r.result.runnerEnv['resolved'] ?? '{}')).toEqual({ 'is-number': '7.0.0' });
    expect(r.result.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 600_000);

  it('canary-pass-python PASSES at L3 and records the pinned dependency it resolved', async () => {
    const r = await qsrRun('canary-pass-python');
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
    expect(classOf(r.result, 'python')).toBeNull();
    expect(JSON.parse(r.result.runnerEnv['resolved'] ?? '{}')).toEqual({ six: '1.16.0' });
    expect(r.result.runnerEnv['python']).toMatch(/^Python 3\.12\./);
  }, 600_000);

  it('canary-fail-drift FAILS at the run step: L2 is real (the checks passed) and the classifier says API_DRIFT', async () => {
    const r = await qsrRun('canary-fail-drift');
    expect(r.code).toBe(0); // 0 = the canary gave its expected answer
    expect(r.result).toMatchObject({ outcome: 'FAIL', failedStepId: 's3', reachedLevel: 2 });
    expect(r.result.steps.map((s) => `${s.stepId}:${s.outcome}`)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:FAIL',
    ]);
    expect(r.result.steps.find((s) => s.stepId === 's3')?.stderrTail).toMatch(
      /nonexistentFunction is not a function/,
    );
    expect(classOf(r.result, 'node')).toMatchObject({
      failureClass: 'API_DRIFT',
      ruleId: 'drift.not_a_function',
    });
  }, 600_000);

  it('canary-fail-dep FAILS at the install step with an npm 404: L0, and the classifier says DEPENDENCY_RESOLUTION', async () => {
    const r = await qsrRun('canary-fail-dep');
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ outcome: 'FAIL', failedStepId: 's1', reachedLevel: 0 });
    expect(r.result.steps[0]?.stderrTail).toMatch(/404 Not Found/);
    expect(classOf(r.result, 'node')).toMatchObject({
      failureClass: 'DEPENDENCY_RESOLUTION',
      ruleId: 'dependency.npm_e404',
    });
  }, 600_000);
});
