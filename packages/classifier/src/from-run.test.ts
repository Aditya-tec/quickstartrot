import { describe, expect, it } from 'vitest';
import { RunResult } from '@qsr/core';
import { inputFromRunResult } from './from-run.js';

const base = (over: Partial<RunResult> = {}): RunResult =>
  RunResult.parse({
    toolSlug: 'acme-node',
    cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
    attempt: 1,
    planId: null,
    snapshotHash: null,
    outcome: 'FAIL',
    reachedLevel: 2,
    failedStepId: 's3',
    steps: [
      {
        stepId: 's1',
        ordinal: 0,
        kind: 'shell',
        outcome: 'PASS',
        exitCode: 0,
        durationMs: 1,
        stdoutTail: null,
        stderrTail: null,
        logFile: null,
      },
      {
        stepId: 's3',
        ordinal: 2,
        kind: 'run',
        outcome: 'FAIL',
        exitCode: 1,
        durationMs: 5,
        stdoutTail: 'out tail',
        stderrTail: 'err tail',
        logFile: 'acme-1/02-s3.log',
      },
    ],
    imageDigest: 'sha256:abc',
    runnerEnv: {},
    startedAt: '2026-10-16T00:00:00.000Z',
    finishedAt: '2026-10-16T00:00:01.000Z',
    ...over,
  });
const info = {
  language: 'node' as const,
  targetLevel: 3,
  authErrorIsPass: false,
  logs: { s3: 'the full log' },
  commands: { s3: 'node index.js' },
};

describe('inputFromRunResult', () => {
  it('has nothing to classify for a passing run', () => {
    expect(inputFromRunResult(base({ outcome: 'PASS', failedStepId: null }), info)).toBeNull();
  });

  it('takes the failing step, its tails, its full log and its command', () => {
    expect(inputFromRunResult(base(), info)).toEqual({
      step: {
        id: 's3',
        kind: 'run',
        command: 'node index.js',
        exitCode: 1,
        stdoutTail: 'out tail',
        stderrTail: 'err tail',
        log: 'the full log',
      },
      run: {
        language: 'node',
        targetLevel: 3,
        reachedLevel: 2,
        outcome: 'FAIL',
        skipReason: null,
        authErrorIsPass: false,
      },
    });
  });

  it('works without logs or commands', () => {
    const input = inputFromRunResult(base(), {
      language: 'python',
      targetLevel: 2,
      authErrorIsPass: true,
    });
    expect(input?.step).toMatchObject({ log: null, command: null });
    expect(input?.run).toMatchObject({ language: 'python', authErrorIsPass: true });
  });

  it('carries the skip reason of a skipped run, from its manual step', () => {
    const skipped = base({
      outcome: 'SKIPPED',
      reachedLevel: 1,
      failedStepId: 's2',
      steps: [
        {
          stepId: 's2',
          ordinal: 1,
          kind: 'manual',
          outcome: 'SKIPPED',
          exitCode: null,
          durationMs: 0,
          stdoutTail: null,
          stderrTail: null,
          logFile: null,
          matchedAuthPattern: null,
          skipReason: 'manual_step',
        },
      ],
    });
    const input = inputFromRunResult(skipped, info);
    expect(input?.run).toMatchObject({
      outcome: 'SKIPPED',
      skipReason: 'manual_step',
      reachedLevel: 1,
    });
    expect(input?.step?.kind).toBe('manual');
  });

  it('a harness error outside any step has no failing step', () => {
    const input = inputFromRunResult(
      base({ outcome: 'HARNESS_ERROR', failedStepId: null, steps: [] }),
      info,
    );
    expect(input?.step).toBeNull();
    expect(input?.run.outcome).toBe('HARNESS_ERROR');
  });

  it('a failed step id that matches no step is also treated as no step', () => {
    expect(inputFromRunResult(base({ failedStepId: 'gone' }), info)?.step).toBeNull();
  });
});
