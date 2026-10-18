import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_VERSION, RunResult, type Step, type StepIR } from '@qsr/core';
import { CHECK_IDS } from './checks.js';
import { executePlan, type ExecuteInput } from './execute.js';
import { FakeDocker, type ExecCall, type FakeExec } from './fake-docker.test-utils.js';
import { parseShadowOutput } from './shadow.js';

// Shadow mode (P9d): the experimental export check runs AFTER the normal checks, in production execute jobs, and its result is
// recorded on the imports-check step. It must change NOTHING else: not the step outcomes, the level reached, the failed step, the
// run outcome (so not the classification, the status engine, an incident, a badge or the public site, which all read those).
// These tests are the executor's half of that guarantee; the API and the web have theirs (apps/api/test/shadow.test.ts).

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const shell = (id: string, command: string): Step => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: EXPECT,
});
const write = (id: string, p: string, content: string): Step => ({
  kind: 'write_file',
  id,
  path: p,
  content,
  source: SRC,
});
const run = (id: string, command: string): Step => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: EXPECT,
});
const plan = (steps: Step[], over: Partial<StepIR> = {}): StepIR => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'none',
  steps,
  maxLevelReachable: 3,
  notes: '',
  ...over,
});
const target = (over: Partial<ExecuteInput['target']> = {}): ExecuteInput['target'] => ({
  slug: 'acme-node',
  language: 'node',
  level: 2,
  placeholders: {},
  expect: { authErrorIsPass: false, timeoutSec: 300 },
  ...over,
});

const isShadowCall = (c: ExecCall): boolean => c.kind === 'check' && c.argv.includes('exports');

async function go(
  docker: FakeDocker,
  ir: StepIR,
  over: { target?: ExecuteInput['target']; shadow?: boolean; exportsCheck?: boolean } = {},
) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-shadow-'));
  return executePlan(
    {
      target: over.target ?? target(),
      ir,
      image: 'ghcr.io/aditya-tec/qsr-node:22',
      outDir,
      cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
      attempt: 1,
      planId: null,
      snapshotHash: 'abc',
    },
    {
      docker,
      runId: 'run-1',
      now: () => new Date('2026-10-18T00:00:00.000Z'),
      clock: () => 0,
      ...(over.shadow === undefined ? {} : { shadowExportCheck: over.shadow }),
      ...(over.exportsCheck === undefined ? {} : { exportsCheck: over.exportsCheck }),
    },
  );
}

const PLAN = (): StepIR =>
  plan(
    [
      shell('s1', 'npm install acme'),
      write('s2', 'index.mjs', "import { A } from 'acme';\nconsole.log(A);"),
    ],
    { maxLevelReachable: 2 },
  );
const shadowAnswers =
  (answer: FakeExec) =>
  (c: ExecCall): FakeExec | undefined =>
    isShadowCall(c) ? answer : undefined;
const SHADOW_FAIL: FakeExec = {
  exitCode: 1,
  stderr: "index.mjs:1: qsr-check-exports: 'acme' does not export 'A' (imported from index.mjs)\n",
};

describe('parseShadowOutput', () => {
  it('exit 0 is a pass, and says which packages could not be checked', () => {
    expect(
      parseShadowOutput({
        exitCode: 0,
        timedOut: false,
        stdout: 'ok exports index.mjs\n',
        stderr: '',
        durationMs: 40,
      }),
    ).toEqual({ outcome: 'pass', missing: [], note: null, durationMs: 40 });
    const note = parseShadowOutput({
      exitCode: 0,
      timedOut: false,
      stdout:
        'qsr-check-exports: not checked, the package could not be loaded here: netty (blocked)\nok exports a.js\n',
      stderr: '',
      durationMs: 1,
    });
    expect(note.outcome).toBe('pass');
    expect(note.note).toMatch(/not checked/);
  });

  it('exit 1 is a fail with the missing names, for every kind of finding', () => {
    const r = parseShadowOutput({
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: [
        "index.mjs:1: qsr-check-exports: 'acme' does not export 'A' (imported from index.mjs)",
        "main.py:2: qsr-check-exports: cannot import name 'Client_qsr' from 'acme' (imported from main.py)",
        "main.py:3: qsr-check-exports: cannot import module 'acme.gone' (No module named 'acme.gone') (imported from main.py)",
        'index.mjs: SyntaxError: nothing to do with exports',
      ].join('\n'),
      durationMs: 5,
    });
    expect(r.outcome).toBe('fail');
    expect(r.missing).toEqual(['acme: A', 'acme: Client_qsr', 'acme.gone']);
  });

  it('a crash, a timeout, or an unreadable answer is skipped, never a fail', () => {
    for (const exitCode of [2, 3, 137, null])
      expect(
        parseShadowOutput({ exitCode, timedOut: false, stdout: '', stderr: 'boom', durationMs: 1 })
          .outcome,
        String(exitCode),
      ).toBe('skipped');
    expect(
      parseShadowOutput({
        exitCode: null,
        timedOut: true,
        stdout: '',
        stderr: '',
        durationMs: 60000,
      }),
    ).toMatchObject({ outcome: 'skipped', note: expect.stringMatching(/timed out/) });
  });

  it('caps the list of names so a hostile or huge answer cannot bloat the record', () => {
    const stderr = Array.from(
      { length: 200 },
      (_, i) => `a.mjs:1: qsr-check-exports: 'p' does not export 'N${i}' (imported from a.mjs)`,
    ).join('\n');
    const r = parseShadowOutput({
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr,
      durationMs: 1,
    });
    expect(r.missing.length).toBeLessThanOrEqual(50);
    expect(RunResult.shape.steps).toBeDefined();
  });
});

describe('shadow mode cannot change what a run says', () => {
  it('stamps the harness version on every run, with or without shadow', async () => {
    const off = await go(new FakeDocker(), PLAN());
    const on = await go(new FakeDocker(), PLAN(), { shadow: true });
    expect(off.harnessVersion).toBe(HARNESS_VERSION);
    expect(on.harnessVersion).toBe(HARNESS_VERSION);
    expect(HARNESS_VERSION).toBe(3);
  });

  it('a shadow FAIL leaves outcome, level, failed step, step ids, outcomes, kinds and exit codes exactly as without shadow', async () => {
    const off = await go(new FakeDocker(), PLAN());
    const on = await go(new FakeDocker(shadowAnswers(SHADOW_FAIL)), PLAN(), { shadow: true });
    expect(on.outcome).toBe('PASS');
    expect(on.outcome).toBe(off.outcome);
    expect(on.reachedLevel).toBe(off.reachedLevel);
    expect(on.reachedLevel).toBe(2);
    expect(on.failedStepId).toBeNull();
    // the same steps, the same everything, except the one field the shadow writes
    const strip = (r: RunResult) => r.steps.map((s) => ({ ...s, shadowExportCheck: undefined }));
    expect(strip(on)).toEqual(strip(off));
    expect(on.steps.map((s) => s.stepId)).toEqual(off.steps.map((s) => s.stepId));
    const withShadow = on.steps.filter((s) => s.shadowExportCheck !== null);
    expect(withShadow.map((s) => s.stepId)).toEqual([CHECK_IDS.imports]);
    expect(withShadow[0]?.shadowExportCheck).toMatchObject({
      outcome: 'fail',
      missing: ['acme: A'],
    });
    expect(
      on.steps.every((s) => s.shadowExportCheck === null || s.stepId === CHECK_IDS.imports),
    ).toBe(true);
  });

  it('is run after every normal step, as the last thing in the container (nothing it does can reach a later step)', async () => {
    const docker = new FakeDocker(shadowAnswers({ exitCode: 0, stdout: 'ok exports index.mjs\n' }));
    const withRun = plan([
      shell('s1', 'npm install acme'),
      write('s2', 'index.mjs', 'console.log(1)'),
      run('s3', 'node index.mjs'),
    ]);
    const r = await go(docker, withRun, { shadow: true });
    expect(r.outcome).toBe('PASS');
    expect(r.reachedLevel).toBe(2); // the run step printed nothing that shows a vendor was reached (harness v3)
    const order = docker.calls
      .filter((c) => c.kind === 'check' || c.kind === 'step')
      .map((c) => (isShadowCall(c) ? 'shadow' : c.kind));
    expect(order.at(-1)).toBe('shadow');
    expect(order.indexOf('shadow')).toBeGreaterThan(order.lastIndexOf('step'));
  });

  it('a crash of the shadow check (exit 2) is recorded as skipped and the run still passes', async () => {
    const r = await go(
      new FakeDocker(shadowAnswers({ exitCode: 2, stderr: 'qsr: harness check crashed' })),
      PLAN(),
      { shadow: true },
    );
    expect(r.outcome).toBe('PASS');
    expect(r.steps.find((s) => s.stepId === CHECK_IDS.imports)?.shadowExportCheck).toMatchObject({
      outcome: 'skipped',
    });
  });

  it('plumbing that throws while the shadow check runs is swallowed: skipped, not a harness error', async () => {
    const r = await go(
      new FakeDocker(shadowAnswers({ throws: new Error('docker went away') })),
      PLAN(),
      { shadow: true },
    );
    expect(r.outcome).toBe('PASS');
    expect(r.steps.find((s) => s.stepId === CHECK_IDS.imports)?.shadowExportCheck).toMatchObject({
      outcome: 'skipped',
      note: expect.stringMatching(/docker went away/),
    });
  });

  it('is not run when the plan already failed (there is nothing to shadow), and records nothing', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'check' && !isShadowCall(c) && c.argv.includes('imports')
        ? { exitCode: 1, stderr: "index.mjs:1: Cannot find module 'x'" }
        : undefined,
    );
    const r = await go(docker, PLAN(), { shadow: true });
    expect(r.outcome).toBe('FAIL');
    expect(docker.calls.some(isShadowCall)).toBe(false);
    expect(r.steps.every((s) => s.shadowExportCheck === null)).toBe(true);
  });

  it('a target that opted out is skipped with its stated reason, and the check is never run', async () => {
    const docker = new FakeDocker(shadowAnswers(SHADOW_FAIL));
    const reason = 'the docs snippet is TypeScript and its types have no run-time export';
    const r = await go(docker, PLAN(), {
      shadow: true,
      target: target({ harness: { skipExportCheck: true, reason } }),
    });
    expect(r.outcome).toBe('PASS');
    expect(docker.calls.some(isShadowCall)).toBe(false);
    expect(r.steps.find((s) => s.stepId === CHECK_IDS.imports)?.shadowExportCheck).toEqual({
      outcome: 'skipped',
      missing: [],
      note: `skipExportCheck: ${reason}`,
      durationMs: 0,
    });
  });

  it('REGRESSION (found in production, probe #13): an opt-out reason at the 300-character limit, plus the "skipExportCheck: " prefix, must not crash the run', async () => {
    // launchdarkly-node's real reason is 286 characters; with the prefix the note was 303 and the result failed validation, which ended
    // the run as a HARNESS_ERROR: a shadow record must never be able to touch the run.
    const reason = 'x'.repeat(300);
    const docker = new FakeDocker(shadowAnswers(SHADOW_FAIL));
    const r = await go(docker, PLAN(), {
      shadow: true,
      target: target({ harness: { skipExportCheck: true, reason } }),
    });
    expect(r.outcome).toBe('PASS');
    const record = r.steps.find((s) => s.stepId === CHECK_IDS.imports)?.shadowExportCheck;
    expect(record?.outcome).toBe('skipped');
    expect(record?.note?.startsWith('skipExportCheck: ')).toBe(true);
    expect(record?.note?.length).toBeLessThanOrEqual(300);
    expect(RunResult.safeParse(r).success).toBe(true);
  });

  it('whatever the check says (a huge note, a hundred missing names, a 5000-character name), the record is valid and the run is untouched', async () => {
    const names = Array.from(
      { length: 100 },
      (_, i) => `acme: ${'n'.repeat(i === 0 ? 5000 : 10)}${i}`,
    );
    const docker = new FakeDocker(
      shadowAnswers({
        exitCode: 1,
        stderr: `${names.map((n) => `qsr-check-exports: 'acme' does not export '${n}'`).join('\n')}\n`,
      }),
    );
    const r = await go(docker, PLAN(), { shadow: true });
    expect(r.outcome).toBe('PASS');
    expect(RunResult.safeParse(r).success).toBe(true);
    const record = r.steps.find((s) => s.stepId === CHECK_IDS.imports)?.shadowExportCheck;
    expect(record?.outcome).toBe('fail');
    expect(record?.missing.length).toBeLessThanOrEqual(50);
    for (const m of record?.missing ?? []) expect(m.length).toBeLessThanOrEqual(200);
  });

  it('the opt-out also holds for the enforcing experiment: an opted-out target gets no export check step at all (found by qsr mutate --exports-check, which failed launchdarkly-node)', async () => {
    const docker = new FakeDocker();
    const reason = 'the docs snippet is TypeScript and its types have no run-time export';
    const r = await go(docker, PLAN(), {
      exportsCheck: true,
      target: target({ harness: { skipExportCheck: true, reason } }),
    });
    expect(docker.calls.some(isShadowCall)).toBe(false);
    expect(r.steps.map((s) => s.stepId)).not.toContain(CHECK_IDS.exports);
  });

  it('is off by default: no shadow call and no shadow field on any step', async () => {
    const docker = new FakeDocker(shadowAnswers(SHADOW_FAIL));
    const r = await go(docker, PLAN());
    expect(docker.calls.some(isShadowCall)).toBe(false);
    expect(r.steps.every((s) => s.shadowExportCheck === null)).toBe(true);
  });

  it('a plan with no source file has no L2 checks and so nothing to shadow', async () => {
    const docker = new FakeDocker(shadowAnswers(SHADOW_FAIL));
    const r = await go(docker, plan([shell('s1', 'npm install acme')], { maxLevelReachable: 1 }), {
      shadow: true,
    });
    expect(r.outcome).toBe('PASS');
    expect(docker.calls.some(isShadowCall)).toBe(false);
  });

  it('the enforcing experiment (exportsCheck) and shadow are separate things: with the enforcing check on, shadow does not run a second time', async () => {
    const docker = new FakeDocker();
    await go(docker, PLAN(), { shadow: true, exportsCheck: true });
    expect(docker.calls.filter(isShadowCall)).toHaveLength(1); // the enforced check, as a normal step
    const r = await go(new FakeDocker(), PLAN(), { shadow: true, exportsCheck: true });
    expect(r.steps.map((s) => s.stepId)).toContain(CHECK_IDS.exports);
  });
});
