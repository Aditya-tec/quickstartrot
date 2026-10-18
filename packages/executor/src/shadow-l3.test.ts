import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunResult, type Step, type StepIR } from '@qsr/core';
import { CHECK_IDS } from './checks.js';
import { executePlan, type ExecuteInput } from './execute.js';
import { FakeDocker, type ExecCall, type FakeExec } from './fake-docker.test-utils.js';

// Shadow-L3: the L3 step of a shadow target runs ONCE, after every normal step and check, and what it said is RECORDED on the last step.
// It must change nothing else: not the step list, the outcomes, the level reached, the failed step, the run outcome, so not the
// classification, status, incidents, badges or public pages, which all read those. This is the executor's half of that guarantee.

const REASON = 'New L3 step: observed for a week of cycles before it may count';
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
  expect: { ...EXPECT, authErrorIsPass: true },
});
const plan = (steps: Step[]): StepIR => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'none',
  steps,
  maxLevelReachable: 3,
  notes: '',
});
const RUN_CMD = 'node index.mjs';
const WITH_RUN = (): StepIR =>
  plan([
    shell('s1', 'npm install acme'),
    write('s2', 'index.mjs', "import { A } from 'acme';\nconsole.log(A);"),
    run('s3', RUN_CMD),
  ]);
const WITHOUT_RUN = (): StepIR => plan(WITH_RUN().steps.slice(0, 2));

type Target = ExecuteInput['target'];
const shadowTarget = (over: Partial<Target> = {}): Target => ({
  slug: 'acme-node',
  language: 'node',
  level: 3,
  placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
  expect: { authErrorIsPass: true, timeoutSec: 300 },
  l3: { mode: 'shadow', reason: REASON },
  ...over,
});
const normalTarget = (): Target => ({ ...shadowTarget(), l3: undefined });

async function go(
  docker: FakeDocker,
  ir: StepIR,
  over: { target?: Target; exportShadow?: boolean } = {},
) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-sl3-'));
  return executePlan(
    {
      target: over.target ?? shadowTarget(),
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
      ...(over.exportShadow === true ? { shadowExportCheck: true } : {}),
    },
  );
}
const isRun = (c: ExecCall): boolean => c.kind === 'step' && c.command === RUN_CMD;
const answers =
  (out: FakeExec) =>
  (c: ExecCall): FakeExec | undefined =>
    isRun(c) ? out : undefined;
const UNAUTH: FakeExec = {
  exitCode: 1,
  stderr: 'AuthenticationError: Request failed with status code 401 for qsr_dummy_key\n',
};
const recordOf = (r: RunResult) => r.steps.find((s) => s.shadowL3)?.shadowL3;

describe('a target that is NOT in shadow keeps its L3 step in the plan, as before (control)', () => {
  it('the run step runs in sequence and its evidence makes L3', async () => {
    const r = await go(new FakeDocker(answers(UNAUTH)), WITH_RUN(), { target: normalTarget() });
    expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
    expect(r.steps.map((s) => s.stepId)).toContain('s3');
    expect(recordOf(r)).toBeUndefined();
  });
});

describe('shadow-L3: what the run step says is recorded and changes nothing', () => {
  it('the run step is NOT a step of the run: the level is what the checks proved, and the run request is made once, after the checks', async () => {
    const docker = new FakeDocker(answers(UNAUTH));
    const r = await go(docker, WITH_RUN());
    expect(r).toMatchObject({ outcome: 'PASS', failedStepId: null, reachedLevel: 2 });
    expect(r.steps.map((s) => s.stepId)).toEqual(['s1', 's2', CHECK_IDS.syntax, CHECK_IDS.imports]);
    const order = docker.calls.filter((c) => c.kind === 'check' || isRun(c)).map((c) => c.kind);
    expect(order).toEqual(['check', 'check', 'step']);
    expect(docker.calls.filter(isRun)).toHaveLength(1); // the request budget: at most one per cycle
  });

  it('records the verdict, the pattern, the exit code and the observed line, on the last step only', async () => {
    const r = await go(new FakeDocker(answers(UNAUTH)), WITH_RUN());
    const record = recordOf(r);
    expect(record).toMatchObject({ verdict: 'evidence', pattern: 'http_401_403', exitCode: 1 });
    expect(record?.observed).toMatch(/status code 401/);
    expect(r.steps.filter((s) => s.shadowL3)).toHaveLength(1);
    expect(r.steps.at(-1)?.shadowL3).toBeTruthy();
    expect(RunResult.safeParse(r).success).toBe(true);
  });

  it('the run is identical to the same plan without the run step: same outcome, level, failed step, step ids, outcomes and exit codes', async () => {
    const on = await go(new FakeDocker(answers(UNAUTH)), WITH_RUN());
    const off = await go(new FakeDocker(), WITHOUT_RUN(), { target: normalTarget() });
    const strip = (r: RunResult) =>
      r.steps.map(({ stepId, kind, outcome, exitCode }) => ({ stepId, kind, outcome, exitCode }));
    expect(on.outcome).toBe(off.outcome);
    expect(on.reachedLevel).toBe(off.reachedLevel);
    expect(on.failedStepId).toBe(off.failedStepId);
    expect(strip(on)).toEqual(strip(off));
    expect(on.runnerEnv['l3']).toBeUndefined(); // no "L3 was not claimed" note: the run step never counted
  });

  it.each([
    [
      'exit 0, nothing that shows a vendor',
      { exitCode: 0, stdout: 'Hello world!\n' },
      'no_evidence',
      null,
    ],
    [
      'exit 0 with a vendor rejecting the key (a snippet that catches it)',
      { exitCode: 0, stderr: "message: 'API key is invalid'\n" },
      'evidence',
      'resend:api_key_is_invalid',
    ],
    [
      'a failure with no auth pattern (a break, or the network)',
      { exitCode: 1, stderr: 'Error: connect ECONNREFUSED 127.0.0.1:443\n' },
      'error_no_evidence',
      null,
    ],
    [
      'evidence beside an import error',
      { exitCode: 1, stderr: 'status code 401\nTypeError: client.send is not a function\n' },
      'vetoed',
      'http_401_403',
    ],
    ['a timeout', { exitCode: null, timedOut: true }, 'timeout', null],
  ] as [string, FakeExec, string, string | null][])(
    '%s: verdict %s',
    async (_name, out, verdict, pattern) => {
      const r = await go(new FakeDocker(answers(out)), WITH_RUN());
      expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 }); // never touched
      expect(recordOf(r)).toMatchObject({ verdict, pattern });
    },
  );

  it('a crash of the executor plumbing while running it is recorded as "skipped" and the run is untouched', async () => {
    const r = await go(
      new FakeDocker((c) => (isRun(c) ? { throws: new Error('docker exec exploded') } : undefined)),
      WITH_RUN(),
    );
    expect(r).toMatchObject({ outcome: 'PASS', failedStepId: null, reachedLevel: 2 });
    expect(recordOf(r)).toMatchObject({ verdict: 'skipped' });
    expect(recordOf(r)?.note).toMatch(/docker exec exploded/);
  });

  it('observed carries the error line AND the evidence line even when a long stack trace follows (they are not in the 4 KB tail)', async () => {
    const noise = Array.from(
      { length: 300 },
      (_, i) => `    at frame ${i} (file:///work/node_modules/x.js:${i}:1)\n`,
    ).join('');
    const r = await go(
      new FakeDocker(
        answers({
          exitCode: 1,
          stderr: `UnauthorizedResponseError: Missing Authentication header\n  statusCode: 401,\n${noise}`,
        }),
      ),
      WITH_RUN(),
    );
    expect(recordOf(r)).toMatchObject({ verdict: 'evidence', pattern: 'http_401_403' });
    expect(recordOf(r)?.observed).toBe(
      'UnauthorizedResponseError: Missing Authentication header | statusCode: 401,',
    );
  });

  it('is not run at all when an earlier step failed: no vendor request, and nothing recorded', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step' && c.command === 'npm install acme'
        ? { exitCode: 1, stderr: 'E404' }
        : undefined,
    );
    const r = await go(docker, WITH_RUN());
    expect(r.outcome).toBe('FAIL');
    expect(docker.calls.filter(isRun)).toHaveLength(0);
    expect(recordOf(r)).toBeUndefined();
  });

  it('a plan with no run step records nothing', async () => {
    const r = await go(new FakeDocker(), WITHOUT_RUN());
    expect(recordOf(r)).toBeUndefined();
    expect(r.outcome).toBe('PASS');
  });

  it('secrets are redacted from what is observed, and the record is bounded to what the schema allows', async () => {
    const long = `status code 401 ${'x'.repeat(2000)} qsr_dummy_key\n`;
    const r = await go(new FakeDocker(answers({ exitCode: 1, stderr: long })), WITH_RUN());
    const record = recordOf(r);
    expect(record?.observed?.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(record)).not.toContain('qsr_dummy_key');
    expect(RunResult.safeParse(r).success).toBe(true);
  });

  it('coexists with the shadow export check: both are recorded, neither changes the run', async () => {
    const docker = new FakeDocker((c) => {
      if (c.kind === 'check' && c.argv.includes('exports'))
        return { exitCode: 0, stdout: 'ok exports index.mjs\n' };
      return isRun(c) ? UNAUTH : undefined;
    });
    const r = await go(docker, WITH_RUN(), { exportShadow: true });
    expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    expect(r.steps.find((s) => s.shadowExportCheck)?.shadowExportCheck?.outcome).toBe('pass');
    expect(recordOf(r)?.verdict).toBe('evidence');
  });
});
