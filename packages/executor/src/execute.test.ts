import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResolved, RunResult, StepIR, type Logger, type Step } from '@qsr/core';
import { DEFAULT_LIMITS } from './docker.js';
import {
  NODE_CHECK_COMMAND,
  NODE_CHECK_SCRIPT,
  PYTHON_CHECK_COMMAND,
  PYTHON_CHECK_SCRIPT,
} from './checks.js';
import {
  executePlan,
  isInstallCommand,
  pickDigest,
  reachedLevel,
  shellQuote,
  type ExecuteInput,
} from './execute.js';
import { FakeDocker, type ExecCall, type FakeExec } from './fake-docker.test-utils.js';

// Unit tests for the executor's logic against a fake Docker. The real-Docker behaviour (isolation,
// OOM, symlinks) is covered by integration.test.ts.

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const shell = (id: string, command: string, expectOver: Partial<typeof EXPECT> = {}): Step => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: { ...EXPECT, ...expectOver },
});
const run = (id: string, command: string, expectOver: Partial<typeof EXPECT> = {}): Step => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: { ...EXPECT, ...expectOver },
});
const write = (id: string, p: string, content: string): Step => ({
  kind: 'write_file',
  id,
  path: p,
  content,
  source: SRC,
});
const append = (id: string, p: string, content: string): Step => ({
  kind: 'append_file',
  id,
  path: p,
  content,
  source: SRC,
});
const setEnv = (id: string, name: string, value: string): Step => ({
  kind: 'set_env',
  id,
  name,
  value,
  source: null,
});
const manual = (id: string): Step => ({ kind: 'manual', id, reason: 'sign up first', source: SRC });
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
  level: 3,
  placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
  expect: { authErrorIsPass: true, timeoutSec: 300 },
  ...over,
});

async function go(
  docker: FakeDocker,
  ir: StepIR,
  over: {
    target?: ExecuteInput['target'];
    image?: string;
    deps?: Partial<Parameters<typeof executePlan>[1]>;
  } = {},
) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-exec-'));
  const input: ExecuteInput = {
    target: over.target ?? target(),
    ir,
    image: over.image ?? 'ghcr.io/aditya-tec/qsr-node:22',
    outDir,
    cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
    attempt: 1,
    planId: null,
    snapshotHash: 'abc',
  };
  const result = await executePlan(input, { docker, runId: 'run-1', ...over.deps });
  return { result, outDir };
}
const names = (r: Awaited<ReturnType<typeof go>>['result']) =>
  r.steps.map((s) => `${s.stepId}:${s.outcome}`);

describe('executePlan: the happy path', () => {
  it('runs shell and run steps through `bash -lc` with a timeout and returns a valid RunResult', async () => {
    // the run step prints the vendor's answer to a dummy key (evidence of reaching it), so the run is a real L3 claim
    const docker = new FakeDocker((c) =>
      c.kind === 'step'
        ? {
            stdout: `ran ${c.command}\n${c.command === 'node index.js' ? 'status code 401\n' : ''}`,
          }
        : undefined,
    );
    const { result } = await go(
      docker,
      plan([
        shell('s1', 'npm install acme'),
        write('s2', 'index.js', 'console.log(1)'),
        run('s3', 'node index.js'),
      ]),
    );

    expect(result.outcome).toBe('PASS');
    expect(result.reachedLevel).toBe(3);
    expect(result.failedStepId).toBeNull();
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:PASS',
    ]);
    expect(result.steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(result.steps.map((s) => s.kind)).toEqual([
      'shell',
      'write_file',
      'harness_check',
      'harness_check',
      'run',
    ]);
    const first = docker.calls.find((c) => c.kind === 'step');
    expect(first?.argv).toEqual([
      'bash',
      '-lc',
      'exec timeout -k 5 "$1" bash -c "$2"',
      '_',
      '180',
      'npm install acme',
    ]);
    expect(docker.stepCommands).toEqual(['npm install acme', 'node index.js']);
    expect(result.steps[0]?.stdoutTail).toBe('ran npm install acme\n');
    expect(RunResult.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      toolSlug: 'acme-node',
      attempt: 1,
      snapshotHash: 'abc',
      planId: null,
    });
  });

  it('starts the container with the image and default limits and removes it exactly once', async () => {
    const docker = new FakeDocker();
    await go(docker, plan([shell('s1', 'true')]));
    expect(docker.started).toHaveLength(1);
    expect(docker.started[0]).toMatchObject({
      name: 'qsr-run-1',
      image: 'ghcr.io/aditya-tec/qsr-node:22',
      limits: DEFAULT_LIMITS,
      labels: { 'qsr.run-id': 'run-1' },
    });
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('lets the caller tighten the resource limits', async () => {
    const docker = new FakeDocker();
    await go(docker, plan([shell('s1', 'true')]), { deps: { limits: { memory: '256m' } } });
    expect(docker.started[0]?.limits).toEqual({ memory: '256m', cpus: '2', pidsLimit: 512 });
  });

  it('writes the full redacted log of each command step under outDir and records its relative path', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step' ? { stdout: 'line one\nline two\n' } : undefined,
    );
    const { result, outDir } = await go(
      docker,
      plan([shell('s1', 'echo hi'), write('s2', 'a.js', 'x')]),
    );
    expect(result.steps[0]?.logFile).toBe('acme-node-1/00-s1.log');
    expect(result.steps[1]?.logFile).toBeNull();
    expect(await readFile(path.join(outDir, 'acme-node-1/00-s1.log'), 'utf8')).toBe(
      'line one\nline two\n',
    );
  });

  it('records timestamps and per-step durations', async () => {
    const docker = new FakeDocker();
    let t = 1000;
    const { result } = await go(docker, plan([shell('s1', 'true')]), {
      deps: { clock: () => (t += 250), now: () => new Date('2026-10-16T00:00:00.000Z') },
    });
    expect(result.startedAt).toBe('2026-10-16T00:00:00.000Z');
    expect(result.steps[0]?.durationMs).toBeGreaterThan(0);
  });
});

describe('executePlan: stops at the first failing step', () => {
  it('runs nothing after a failure and reports FAIL with the failing step and the level reached', async () => {
    const docker = new FakeDocker((c) =>
      c.command === 'node index.js' ? { stderr: 'boom\n', exitCode: 1 } : undefined,
    );
    const { result } = await go(
      docker,
      plan([
        shell('s1', 'npm i x'),
        write('s2', 'index.js', 'x'),
        run('s3', 'node index.js'),
        shell('s4', 'echo never'),
      ]),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.failedStepId).toBe('s3');
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:FAIL',
    ]);
    expect(result.reachedLevel).toBe(2);
    expect(docker.stepCommands).not.toContain('echo never');
    expect(result.steps[4]).toMatchObject({ exitCode: 1, stderrTail: 'boom\n' });
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('a failing install stops before any file is written (level 0)', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step'
        ? { stderr: 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope\n', exitCode: 1 }
        : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm install nope'), write('s2', 'a.js', 'x')]),
    );
    expect(result).toMatchObject({ outcome: 'FAIL', failedStepId: 's1', reachedLevel: 0 });
    expect(docker.calls.some((c) => c.kind === 'write')).toBe(false);
    expect(result.steps[0]?.stderrTail).toContain('npm ERR! 404');
  });
});

describe('executePlan: auth-error-as-pass', () => {
  const unauthorized = (extra = ''): FakeExec => ({
    stderr: `Error: Request failed with status code 401\n${extra}`,
    exitCode: 1,
  });

  it('passes a run step that fails with an auth error when the step allows it, and records the pattern', async () => {
    const docker = new FakeDocker((c) => (c.kind === 'step' ? unauthorized() : undefined));
    const { result } = await go(
      docker,
      plan([run('s1', 'node index.js', { authErrorIsPass: true })]),
    );
    expect(result.outcome).toBe('PASS');
    expect(result.steps[0]).toMatchObject({
      outcome: 'PASS',
      exitCode: 1,
      matchedAuthPattern: 'http_401_403',
    });
    expect(result.steps[0]?.stderrTail).toContain('auth error treated as pass');
  });

  it('an import error printed after the 401 vetoes it', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step' ? unauthorized('TypeError: client.send is not a function\n') : undefined,
    );
    const { result } = await go(
      docker,
      plan([run('s1', 'node index.js', { authErrorIsPass: true })]),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ outcome: 'FAIL', matchedAuthPattern: 'http_401_403' });
    expect(result.steps[0]?.stderrTail).toMatch(/vetoed by drift pattern "is not a function"/);
  });

  it('without the flag the same output is a plain failure', async () => {
    const docker = new FakeDocker((c) => (c.kind === 'step' ? unauthorized() : undefined));
    const { result } = await go(docker, plan([run('s1', 'node index.js')]));
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]?.matchedAuthPattern).toBeNull();
  });
});

describe('executePlan: an L3 claim needs evidence that a vendor was reached (harness v3)', () => {
  const planWithRun = (authErrorIsPass = false): StepIR =>
    plan([
      shell('s1', 'npm install acme-sdk'),
      write('s2', 'index.js', "console.log('hi')"),
      run('s3', 'node index.js', { authErrorIsPass }),
    ]);
  const reply = (out: FakeExec) =>
    new FakeDocker((c) => (c.kind === 'step' && c.command === 'node index.js' ? out : undefined));

  it('exit 1 with a 401 in the output (the auth-error-as-pass path) is L3, as before', async () => {
    const { result } = await go(
      reply({ stderr: 'Error: Request failed with status code 401\n', exitCode: 1 }),
      planWithRun(true),
      { target: target({ expect: { authErrorIsPass: true, timeoutSec: 300 } }) },
    );
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
    expect(result.runnerEnv['l3']).toBeUndefined();
  });

  it('exit 0 whose output shows a vendor rejecting the key (a snippet that catches the error) is L3 and records the pattern', async () => {
    const { result } = await go(
      reply({
        stderr: "{ error: { message: 'API key is invalid', statusCode: 401 } }\n",
        exitCode: 0,
      }),
      planWithRun(),
    );
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
    expect(result.steps.find((s) => s.stepId === 's3')?.matchedAuthPattern).toBe('http_401_403');
  });

  it('a registered vendor pattern alone is evidence', async () => {
    const { result } = await go(
      reply({ stdout: "message: 'API key is invalid'\n", exitCode: 0 }),
      planWithRun(),
    );
    expect(result.reachedLevel).toBe(3);
    expect(result.steps.find((s) => s.stepId === 's3')?.matchedAuthPattern).toBe(
      'resend:api_key_is_invalid',
    );
  });

  it('exit 0 with NO evidence passes the run but is capped at L2, and says why in runner_env', async () => {
    const { result } = await go(reply({ stdout: 'Hello world!\n', exitCode: 0 }), planWithRun());
    expect(result).toMatchObject({ outcome: 'PASS', failedStepId: null, reachedLevel: 2 });
    expect(result.runnerEnv['l3']).toBe('no_evidence');
  });

  it('a target that declares itself local (no vendor API) is capped the same way, with the reason "local"', async () => {
    const { result } = await go(reply({ stdout: 'Hello world!\n', exitCode: 0 }), planWithRun(), {
      target: target({ expect: { authErrorIsPass: false, timeoutSec: 300, localOnly: true } }),
    });
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    expect(result.runnerEnv['l3']).toBe('local');
  });

  it('a drift error printed beside the evidence takes the evidence away (the step passes by exit code, L3 is not claimed)', async () => {
    const { result } = await go(
      reply({
        stderr: 'status code 401\nTypeError: client.send is not a function\n',
        exitCode: 0,
      }),
      planWithRun(),
    );
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    expect(result.runnerEnv['l3']).toBe('no_evidence');
  });

  it('a run that never reached its run step has no l3 note', async () => {
    const { result } = await go(
      new FakeDocker((c) =>
        c.kind === 'step' && c.command?.startsWith('npm install')
          ? { exitCode: 1, stderr: 'E404' }
          : undefined,
      ),
      planWithRun(),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.runnerEnv['l3']).toBeUndefined();
  });

  it('a plan with no run step has no l3 note', async () => {
    const { result } = await go(new FakeDocker(), plan([shell('s1', 'npm install acme-sdk')]));
    expect(result.runnerEnv['l3']).toBeUndefined();
  });
});

describe('executePlan: docker itself failing is not the vendor failing', () => {
  it('exit 125 with a daemon error from `docker exec` is a HARNESS_ERROR, not a failed step', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step'
        ? { exitCode: 125, stderr: 'Error response from daemon: No such container: qsr-run-1\n' }
        : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'npm install x')]));
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 's1' });
    expect(result.steps[0]?.stderrTail).toContain('harness error: docker exec failed');
  });

  it('a program that happens to exit 125 on its own is still an ordinary failure', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step' ? { exitCode: 125, stderr: 'my own error\n' } : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'myprog')]));
    expect(result).toMatchObject({ outcome: 'FAIL', failedStepId: 's1' });
  });
});

describe('executePlan: files', () => {
  it('writes through the container as the runner user, with a trailing newline, never via the host', async () => {
    const docker = new FakeDocker();
    await go(
      docker,
      plan([
        write('s1', 'src/index.ts', 'export const a = 1;'),
        append('s2', 'src/index.ts', 'export const b = 2;'),
      ]),
    );
    const [w, a] = docker.calls.filter((c) => c.kind === 'write');
    expect(w?.stdin).toBe('export const a = 1;\n');
    expect(a?.stdin).toBe('export const b = 2;\n');
    expect(w?.argv.slice(-2)).toEqual(['/work/src/index.ts', 'write']);
    expect(a?.argv.slice(-2)).toEqual(['/work/src/index.ts', 'append']);
    expect(w?.script).toContain('realpath -m');
  });

  it('does not add a second newline to content that already ends with one', async () => {
    const docker = new FakeDocker();
    await go(docker, plan([write('s1', 'a.txt', 'x\n')]));
    expect(docker.calls.find((c) => c.kind === 'write')?.stdin).toBe('x\n');
  });

  it.each(['../escape.txt', '/etc/passwd', '/work/../etc/passwd', '~/x', 'a/../../x', 'a\\b', ''])(
    'refuses %j as a HARNESS_ERROR without touching the container',
    async (bad) => {
      const docker = new FakeDocker();
      const { result } = await go(docker, plan([write('s1', bad, 'x')]));
      expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 's1' });
      expect(docker.calls.filter((c) => c.kind === 'write')).toHaveLength(0);
      expect(result.steps[0]?.outcome).toBe('FAIL');
      expect(result.steps[0]?.stderrTail).toMatch(/harness error: .*path/i);
      expect(docker.removed).toEqual(['qsr-run-1']);
    },
  );

  it('a path that resolves outside /work inside the container (a symlink) is a HARNESS_ERROR', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'write'
        ? { stderr: 'qsr: path resolves outside /work: /etc/pwn\n', exitCode: 97 }
        : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'ln -s /etc evil'), write('s2', 'evil/pwn', 'x')]),
    );
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 's2' });
    expect(result.steps[1]?.stderrTail).toContain('resolves outside /work');
  });

  it('any other write failure is also a HARNESS_ERROR', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'write' ? { stderr: 'disk full\n', exitCode: 1 } : undefined,
    );
    const { result } = await go(docker, plan([write('s1', 'a.txt', 'x')]));
    expect(result.outcome).toBe('HARNESS_ERROR');
  });
});

describe('executePlan: set_env', () => {
  it('appends a single-quoted export to the env file that every later login shell sources', async () => {
    const docker = new FakeDocker();
    await go(docker, plan([setEnv('s1', 'RESEND_API_KEY', "qsr'dummy key; rm -rf /")]));
    const call = docker.calls.find((c) => c.kind === 'env');
    expect(call?.script).toContain('.qsr_env');
    expect(call?.stdin).toBe(`export RESEND_API_KEY='qsr'\\''dummy key; rm -rf /'\n`);
  });

  it('refuses a variable name that is not a plain identifier', async () => {
    const docker = new FakeDocker();
    const { result } = await go(docker, plan([setEnv('s1', 'A; rm -rf /', 'x')]));
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 's1' });
    expect(docker.calls.filter((c) => c.kind === 'env')).toHaveLength(0);
  });

  it('a failing env write is a HARNESS_ERROR', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'env' ? { exitCode: 1, stderr: 'read-only' } : undefined,
    );
    expect((await go(docker, plan([setEnv('s1', 'A', 'x')]))).result.outcome).toBe('HARNESS_ERROR');
  });
});

describe('executePlan: manual steps stop the plan', () => {
  it('stops, marks the step SKIPPED, and reports a SKIPPED run (not FAIL) when the target level was not reached', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm i x'), manual('s2'), shell('s3', 'echo never')]),
      { target: target({ level: 3 }) },
    );
    expect(names(result)).toEqual(['s1:PASS', 's2:SKIPPED']);
    expect(result).toMatchObject({ outcome: 'SKIPPED', failedStepId: 's2', reachedLevel: 1 });
    expect(result.steps[1]).toMatchObject({
      kind: 'manual',
      exitCode: null,
      logFile: null,
      skipReason: 'manual_step',
    });
    expect(docker.stepCommands).toEqual(['npm i x']);
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('only the manual step carries a skipReason', async () => {
    const { result } = await go(new FakeDocker(), plan([shell('s1', 'npm i x'), manual('s2')]));
    expect(result.steps.map((s) => s.skipReason)).toEqual([null, 'manual_step']);
  });

  it('a manual step at the very start is level 0 and SKIPPED', async () => {
    const { result } = await go(new FakeDocker(), plan([manual('s1')]));
    expect(result).toMatchObject({ outcome: 'SKIPPED', failedStepId: 's1', reachedLevel: 0 });
  });

  it('keeps the level reached before the stop: the checks run right after the last write, so a later manual step still leaves L2', async () => {
    const { result } = await go(
      new FakeDocker(),
      plan([
        shell('s1', 'npm i x'),
        write('s2', 'a.js', 'x'),
        manual('s3'),
        run('s4', 'node a.js'),
      ]),
      { target: target({ level: 3 }) },
    );
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:SKIPPED',
    ]);
    expect(result).toMatchObject({ outcome: 'SKIPPED', failedStepId: 's3', reachedLevel: 2 });
  });

  it('is a PASS when the target level was already reached before the manual step', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm i x'), write('s2', 'a.js', 'x'), manual('s3')]),
      { target: target({ level: 2 }) },
    );
    expect(result).toMatchObject({ outcome: 'PASS', failedStepId: null, reachedLevel: 2 });
    expect(result.steps.at(-1)).toMatchObject({ outcome: 'SKIPPED', skipReason: 'manual_step' });
  });
});

describe('executePlan: timeouts', () => {
  it('exit 124 from `timeout` fails the step, says so in the log and removes the container', async () => {
    const docker = new FakeDocker((c) => (c.kind === 'step' ? { exitCode: 124 } : undefined));
    const { result } = await go(docker, plan([shell('s1', 'sleep 999', { timeoutSec: 5 })]));
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ exitCode: 124 });
    expect(result.steps[0]?.stderrTail).toContain('timed out after 5s');
    expect(docker.calls.find((c) => c.kind === 'step')?.argv[4]).toBe('5');
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('a host-side deadline (the exec never returned) is a timeout too', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step' ? { exitCode: null, timedOut: true } : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'hang', { timeoutSec: 5 })]));
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]?.stderrTail).toContain('timed out after 5s');
    expect(docker.calls.find((c) => c.kind === 'step')?.options.timeoutMs).toBeGreaterThan(5000);
  });

  it('exit 137 after the full time limit is a timeout (timeout -k had to SIGKILL), not an out-of-memory kill', async () => {
    let t = 0;
    const docker = new FakeDocker((c) => {
      if (c.kind === 'step') t += 5200;
      return c.kind === 'step' ? { exitCode: 137 } : undefined;
    });
    const { result } = await go(docker, plan([shell('s1', 'stubborn', { timeoutSec: 5 })]), {
      deps: { clock: () => t },
    });
    expect(result.steps[0]?.stderrTail).toContain('timed out after 5s');
    expect(result.steps[0]?.stderrTail).not.toContain('memory');
  });

  it('exit 137 well before the limit is reported as a memory-limit kill', async () => {
    const docker = new FakeDocker((c) => (c.kind === 'step' ? { exitCode: 137 } : undefined));
    const { result } = await go(docker, plan([shell('s1', 'alloc')]), {
      deps: { limits: { memory: '256m' } },
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]?.stderrTail).toContain('SIGKILL');
    expect(result.steps[0]?.stderrTail).toContain('memory limit of 256m');
  });

  it("caps each step by the target's overall time budget, and fails a step that starts after it is spent", async () => {
    let t = 0;
    const docker = new FakeDocker((c) => {
      if (c.kind === 'step') t += 7000;
      return undefined;
    });
    const { result } = await go(
      docker,
      plan([shell('s1', 'a'), shell('s2', 'b'), shell('s3', 'c')]),
      {
        target: target({ expect: { authErrorIsPass: false, timeoutSec: 10 } }),
        deps: { clock: () => t },
      },
    );
    const secs = docker.calls.filter((c) => c.kind === 'step').map((c) => c.argv[4]);
    expect(secs).toEqual(['10', '3']); // s1 gets 10 s, s2 only what is left
    expect(result.outcome).toBe('FAIL');
    expect(names(result)).toEqual(['s1:PASS', 's2:PASS', 's3:FAIL']);
    expect(result.steps[2]?.stderrTail).toContain('overall time limit of 10s');
    expect(docker.stepCommands).toEqual(['a', 'b']); // s3 never started
  });
});

describe('executePlan: the container is always removed', () => {
  it('when the executor itself throws mid-plan: HARNESS_ERROR, and the container is removed', async () => {
    const docker = new FakeDocker((c) =>
      c.command === 'second' ? { throws: new Error('docker daemon went away') } : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'first'), shell('s2', 'second'), shell('s3', 'third')]),
    );
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 's2' });
    expect(names(result)).toEqual(['s1:PASS', 's2:FAIL']);
    expect(result.steps[1]?.stderrTail).toContain('harness error: docker daemon went away');
    expect(docker.removed).toEqual(['qsr-run-1']);
    expect(docker.stepCommands).toEqual(['first', 'second']);
  });

  it('when the container cannot be started (and removal is still attempted)', async () => {
    const docker = new FakeDocker();
    docker.startError = new Error('no space left on device');
    const { result } = await go(docker, plan([shell('s1', 'x')]));
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: null, steps: [] });
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('when the image cannot be pulled: HARNESS_ERROR, nothing to remove', async () => {
    const docker = new FakeDocker();
    docker.image = null;
    docker.pullImage = async () => {
      throw new Error('manifest unknown');
    };
    const { result } = await go(docker, plan([shell('s1', 'x')]));
    expect(result.outcome).toBe('HARNESS_ERROR');
    expect(docker.started).toHaveLength(0);
    expect(docker.removed).toEqual([]);
  });

  it('a failure to remove is logged, not thrown, and does not change the result', async () => {
    const docker = new FakeDocker();
    docker.removeError = new Error('rm failed');
    const warnings: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (_f, m) => void warnings.push(m ?? ''),
      error: (_f, m) => void warnings.push(m ?? ''),
    };
    const { result } = await go(docker, plan([shell('s1', 'x')]), { deps: { log } });
    expect(result.outcome).toBe('PASS');
    expect(warnings.join(' ')).toMatch(/could not remove container/);
  });

  it('an abort signal stops the plan between steps as a HARNESS_ERROR and still removes the container', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((c) => {
      if (c.command === 'first') controller.abort();
      return undefined;
    });
    const { result } = await go(docker, plan([shell('s1', 'first'), shell('s2', 'second')]), {
      deps: { signal: controller.signal },
    });
    expect(result.outcome).toBe('HARNESS_ERROR');
    expect(result.steps[result.steps.length - 1]?.stderrTail).toContain('aborted');
    expect(docker.stepCommands).toEqual(['first']);
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('pulls a missing image, once, and records where the digest came from', async () => {
    const docker = new FakeDocker();
    docker.image = null;
    const { result } = await go(docker, plan([shell('s1', 'x')]));
    expect(docker.pulled).toEqual(['ghcr.io/aditya-tec/qsr-node:22']);
    expect(result.runnerEnv['imageSource']).toBe('registry');
    expect(result.imageDigest).toBe(`sha256:${'a'.repeat(64)}`);
  });
});

describe('executePlan: nothing secret is stored', () => {
  it('redacts dummy keys, env values, tokens, the home path and IPs from the log and both tails', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'step'
        ? {
            stdout: 'using qsr_dummy_key and hunter2-env-value at /home/runner/work\n',
            stderr: 'connect 10.1.2.3 RESEND_API_KEY=0123456789abcdef0123456789abcdef\n',
          }
        : undefined,
    );
    const { result, outDir } = await go(
      docker,
      plan([setEnv('s1', 'SOME_VAR', 'hunter2-env-value'), shell('s2', 'run it')]),
    );
    const log = await readFile(path.join(outDir, 'acme-node-1/01-s2.log'), 'utf8');
    const everything = JSON.stringify(result) + log;
    expect(everything).not.toMatch(
      /qsr_dummy_key|hunter2-env-value|10\.1\.2\.3|0123456789abcdef|\/home\/runner/,
    );
    expect(result.steps[1]?.stdoutTail).toBe('using [REDACTED] and [REDACTED] at ~/work\n');
  });

  it('never passes host environment to the container: the start spec has no env at all', async () => {
    const hostSecret = ['gsk', '_hostsecret1234567890abcdefghij'].join(''); // assembled: not a literal token
    process.env['GROQ_API_KEY'] = hostSecret;
    try {
      const docker = new FakeDocker();
      await go(docker, plan([shell('s1', 'env')]));
      expect(Object.keys(docker.started[0] ?? {}).sort()).toEqual([
        'image',
        'labels',
        'limits',
        'name',
      ]);
      expect(JSON.stringify(docker.calls.map((c) => c.argv))).not.toContain(hostSecret);
    } finally {
      delete process.env['GROQ_API_KEY'];
    }
  });
});

describe('executePlan: log and tail caps', () => {
  it('a step that prints 10 MB leaves a log of at most 256 KB and tails of at most 4 KB', async () => {
    const flood = 'flooding the output with lorem ipsum dolor sit amet\n'.repeat(1000);
    const docker = new FakeDocker((c) => {
      if (c.kind === 'step') for (let i = 0; i < 200; i++) c.options.onStdout(Buffer.from(flood));
      return undefined;
    });
    const { result, outDir } = await go(docker, plan([shell('s1', 'flood')]));
    const file = path.join(outDir, result.steps[0]?.logFile ?? 'missing');
    expect((await stat(file)).size).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(Buffer.byteLength(result.steps[0]?.stdoutTail ?? '')).toBeLessThanOrEqual(4096);
    expect(await readFile(file, 'utf8')).toContain('output truncated');
  });
});

describe('executePlan: harness checks (what level 2 means)', () => {
  const checkCalls = (d: FakeDocker) => d.calls.filter((c) => c.kind === 'check');

  it('runs two harness_check steps after the last write, before the run step, with their own ids', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([
        shell('s1', 'npm install acme'),
        write('s2', 'index.js', "const a = require('acme');"),
        run('s3', 'node index.js'),
      ]),
    );
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:PASS',
    ]);
    expect(result.steps.map((x) => x.kind)).toEqual([
      'shell',
      'write_file',
      'harness_check',
      'harness_check',
      'run',
    ]);
    expect(result.steps.map((x) => x.ordinal)).toEqual([0, 1, 2, 3, 4]);
    // the run step printed nothing that shows a vendor was reached: the run passes, the level stays at what the checks proved
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    expect(checkCalls(docker)).toHaveLength(2);
  });

  it('feeds the harness script on stdin and passes the files as plain arguments', async () => {
    const docker = new FakeDocker();
    await go(docker, plan([write('s1', './index.js', 'x'), write('s2', 'lib/b.mjs', 'x')]));
    const [syntax, imports] = checkCalls(docker);
    expect(syntax?.stdin).toBe(NODE_CHECK_SCRIPT);
    expect(imports?.stdin).toBe(NODE_CHECK_SCRIPT);
    expect(syntax?.argv.slice(5)).toEqual([
      ...NODE_CHECK_COMMAND,
      'syntax',
      'index.js',
      'lib/b.mjs',
    ]);
    expect(imports?.argv.slice(5)).toEqual([
      ...NODE_CHECK_COMMAND,
      'imports',
      'index.js',
      'lib/b.mjs',
    ]);
  });

  it('the checks come from the harness: a plan step of kind harness_check does not parse', () => {
    const bad = {
      irVersion: 1,
      language: 'node',
      projectInit: 'none',
      steps: [{ kind: 'harness_check', id: 'x', command: 'true', source: null }],
      maxLevelReachable: 3,
      notes: '',
    };
    expect(StepIR.safeParse(bad).success).toBe(false);
  });

  it('waits for the last install when it comes after the last write', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([write('s1', 'a.js', 'x'), shell('s2', 'npm install acme'), run('s3', 'node a.js')]),
    );
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:PASS',
      's3:PASS',
    ]);
  });

  it('python plans use the python script and interpreter', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([shell('s1', 'pip install acme'), write('s2', 'main.py', 'import acme')], {
        language: 'python',
        projectInit: 'python_venv',
      }),
      { target: target({ language: 'python', level: 2 }) },
    );
    const [syntax, imports] = checkCalls(docker);
    expect(syntax?.stdin).toBe(PYTHON_CHECK_SCRIPT);
    expect(syntax?.argv.slice(5)).toEqual([...PYTHON_CHECK_COMMAND, 'syntax', 'main.py']);
    expect(imports?.argv.slice(5)).toEqual([...PYTHON_CHECK_COMMAND, 'imports', 'main.py']);
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
  });

  it('level 2 is install + checks: a plan that stops after the checks reaches 2', async () => {
    const { result } = await go(
      new FakeDocker(),
      plan([shell('s1', 'npm install acme'), write('s2', 'a.js', 'x')]),
      { target: target({ level: 2 }) },
    );
    expect(result).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
  });

  it('writing a file the harness cannot check (json, md) does not reach level 2', async () => {
    const docker = new FakeDocker();
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm install acme'), write('s2', 'config.json', '{}')]),
      { target: target({ level: 2 }) },
    );
    expect(checkCalls(docker)).toHaveLength(0);
    expect(result.reachedLevel).toBe(1);
  });

  it('a syntax error fails the run as a check failure at level 1; the run step never executes', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'check' && c.argv.includes('syntax')
        ? {
            stderr: 'bad.js:1\nconst x = ;\n          ^\nSyntaxError: Unexpected token ;\n',
            exitCode: 1,
          }
        : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm install acme'), write('s2', 'bad.js', 'x'), run('s3', 'node bad.js')]),
    );
    expect(names(result)).toEqual(['s1:PASS', 's2:PASS', 'qsr-check-syntax:FAIL']);
    expect(result).toMatchObject({
      outcome: 'FAIL',
      failedStepId: 'qsr-check-syntax',
      reachedLevel: 1,
    });
    expect(result.steps[2]).toMatchObject({ kind: 'harness_check', exitCode: 1 });
    expect(result.steps[2]?.stderrTail).toContain('SyntaxError: Unexpected token');
    expect(result.steps[2]?.logFile).toMatch(/02-qsr-check-syntax\.log$/);
    expect(docker.stepCommands).toEqual(['npm install acme']);
    expect(docker.removed).toEqual(['qsr-run-1']);
  });

  it('an unresolved import fails the run at the imports check, level 1', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'check' && c.argv.includes('imports')
        ? { stderr: "a.mjs: Cannot find package 'ghost' imported from /work/a.mjs\n", exitCode: 1 }
        : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'npm install acme'), write('s2', 'a.mjs', 'x'), run('s3', 'node a.mjs')]),
    );
    expect(names(result)).toEqual([
      's1:PASS',
      's2:PASS',
      'qsr-check-syntax:PASS',
      'qsr-check-imports:FAIL',
    ]);
    expect(result).toMatchObject({
      outcome: 'FAIL',
      failedStepId: 'qsr-check-imports',
      reachedLevel: 1,
    });
    expect(result.steps[3]?.stderrTail).toContain("Cannot find package 'ghost'");
  });

  it('a check that crashes (any exit but 0 or 1) is the harness failing, not the docs', async () => {
    for (const exitCode of [2, 3, 124, 127, null]) {
      const docker = new FakeDocker((c) =>
        c.kind === 'check' ? { stderr: 'node: bad option\n', exitCode } : undefined,
      );
      const { result } = await go(docker, plan([write('s1', 'a.js', 'x')]));
      expect(result.outcome, String(exitCode)).toBe('HARNESS_ERROR');
      expect(result.failedStepId).toBe('qsr-check-syntax');
      expect(docker.removed).toEqual(['qsr-run-1']);
    }
  });

  it('a check whose exec throws is a HARNESS_ERROR that names the check', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'check' ? { throws: new Error('daemon went away') } : undefined,
    );
    const { result } = await go(docker, plan([write('s1', 'a.js', 'x')]));
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 'qsr-check-syntax' });
    expect(result.steps.at(-1)?.stderrTail).toContain('daemon went away');
  });

  it('check output is redacted like any other step output', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'check'
        ? { stderr: 'a.js: failed in /home/runner/x with qsr_dummy_key\n', exitCode: 1 }
        : undefined,
    );
    const { result } = await go(docker, plan([write('s1', 'a.js', 'x')]));
    expect(result.steps.at(-1)?.stderrTail).not.toContain('qsr_dummy_key');
  });
});

describe('executePlan: harness project setup', () => {
  const setupCmds = (d: FakeDocker) =>
    d.calls.filter((c) => c.kind === 'setup').map((c) => c.script);

  it('npm_init runs `npm init -y`; python_venv and none run nothing', async () => {
    const node = new FakeDocker();
    await go(node, plan([shell('s1', 'true')], { projectInit: 'npm_init' }));
    expect(setupCmds(node)).toEqual(['npm init -y']);
    const py = new FakeDocker();
    await go(py, plan([shell('s1', 'true')], { language: 'python', projectInit: 'python_venv' }), {
      target: target({ language: 'python' }),
    });
    expect(setupCmds(py)).toEqual([]);
    const none = new FakeDocker();
    await go(none, plan([shell('s1', 'true')], { projectInit: 'none' }));
    expect(setupCmds(none)).toEqual([]);
  });

  it('sets "type": "module" only when a written file uses ESM syntax and the plan writes no package.json', async () => {
    const esm = new FakeDocker();
    await go(
      esm,
      plan([write('s1', 'index.js', "import chalk from 'chalk';\nconsole.log(chalk.red('x'));")], {
        projectInit: 'npm_init',
      }),
    );
    expect(setupCmds(esm)).toEqual(['npm init -y', 'npm pkg set type=module']);

    const cjs = new FakeDocker();
    await go(
      cjs,
      plan([write('s1', 'index.js', "const x = require('x');")], { projectInit: 'npm_init' }),
    );
    expect(setupCmds(cjs)).toEqual(['npm init -y']);

    const ownPkg = new FakeDocker();
    await go(
      ownPkg,
      plan(
        [
          write('s1', 'package.json', '{"type":"module"}'),
          write('s2', 'index.js', 'import x from "x";'),
        ],
        { projectInit: 'npm_init' },
      ),
    );
    expect(setupCmds(ownPkg)).toEqual(['npm init -y']);

    const tsOnly = new FakeDocker();
    await go(
      tsOnly,
      plan([write('s1', 'index.ts', 'import x from "x";')], { projectInit: 'npm_init' }),
    );
    expect(setupCmds(tsOnly)).toEqual(['npm init -y']); // tsx handles ESM syntax in .ts without it
  });

  it('a failing setup command is a HARNESS_ERROR before any step runs', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'setup' ? { exitCode: 1, stderr: 'npm: command not found\n' } : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'x')], { projectInit: 'npm_init' }));
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', steps: [] });
    expect(docker.stepCommands).toEqual([]);
  });
});

describe('executePlan: runner_env', () => {
  const envOutput =
    'node=v22.1.0\nnpm=10.9.0\nregistry=https://registry.npmjs.org/\nos=Debian GNU/Linux 12 (bookworm)\n';
  const npmLs = JSON.stringify({
    dependencies: { chalk: { version: '5.3.0' }, 'is-number': { version: '7.0.0' } },
  });
  const handler = (c: ExecCall): FakeExec | undefined =>
    c.kind === 'capture-env'
      ? { stdout: envOutput }
      : c.kind === 'capture-resolved'
        ? { stdout: npmLs }
        : undefined;

  it('records versions, registry, OS, image, docker version, limits and the resolved dependencies', async () => {
    const docker = new FakeDocker(handler);
    docker.image = {
      id: `sha256:${'1'.repeat(64)}`,
      repoDigests: [`ghcr.io/aditya-tec/qsr-node@sha256:${'b'.repeat(64)}`],
    };
    const { result } = await go(docker, plan([shell('s1', 'npm install chalk is-number')]));
    expect(result.imageDigest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(result.runnerEnv).toMatchObject({
      node: 'v22.1.0',
      npm: '10.9.0',
      registry: 'https://registry.npmjs.org/',
      os: 'Debian GNU/Linux 12 (bookworm)',
      imageRef: 'ghcr.io/aditya-tec/qsr-node:22',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      imageSource: 'registry',
      dockerServer: '29.0.0-fake',
      memoryLimit: '2g',
      cpus: '2',
    });
    expect(parseResolved(result.runnerEnv)).toEqual({ chalk: '5.3.0', 'is-number': '7.0.0' });
    expect(RunResult.safeParse(result).success).toBe(true);
  });

  it('captures the resolved dependencies right after the LAST install step, before later steps run', async () => {
    const docker = new FakeDocker(handler);
    await go(
      docker,
      plan([
        shell('s1', 'npm install a'),
        shell('s2', 'npm install b'),
        write('s3', 'i.js', 'x'),
        run('s4', 'node i.js'),
      ]),
    );
    const order = docker.calls.map((c) => (c.kind === 'step' ? `step:${c.command}` : c.kind));
    expect(order.indexOf('capture-resolved')).toBe(order.indexOf('step:npm install b') + 1);
    expect(order.filter((k) => k === 'capture-resolved')).toHaveLength(1);
  });

  it('captures even when the install step itself failed (the evidence is still useful)', async () => {
    const docker = new FakeDocker((c) =>
      c.command === 'npm install broken' ? { exitCode: 1 } : handler(c),
    );
    const { result } = await go(docker, plan([shell('s1', 'npm install broken')]));
    expect(result.outcome).toBe('FAIL');
    expect(parseResolved(result.runnerEnv)).toEqual({ chalk: '5.3.0', 'is-number': '7.0.0' });
  });

  it('with no install step it still captures once, at the end', async () => {
    const docker = new FakeDocker(handler);
    await go(docker, plan([write('s1', 'a.js', 'x'), run('s2', 'node a.js')]));
    const kinds = docker.calls.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'capture-resolved')).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe('capture-resolved');
  });

  it('python: reads `pip freeze` and the python/pip versions', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'capture-env'
        ? {
            stdout:
              'python=Python 3.12.15\npip=25.0.1\nregistry=https://pypi.org/simple\nos=Debian GNU/Linux 12 (bookworm)\n',
          }
        : c.kind === 'capture-resolved'
          ? { stdout: 'loguru==0.7.3\nsix @ file:///tmp/six\n# comment\n\nrequests==2.32.0\n' }
          : undefined,
    );
    const { result } = await go(
      docker,
      plan([shell('s1', 'pip install loguru')], { language: 'python' }),
      { target: target({ language: 'python' }), image: 'ghcr.io/aditya-tec/qsr-python:3.12' },
    );
    expect(result.runnerEnv).toMatchObject({ python: 'Python 3.12.15', pip: '25.0.1' });
    expect(parseResolved(result.runnerEnv)).toEqual({
      loguru: '0.7.3',
      requests: '2.32.0',
      six: 'file:///tmp/six',
    });
    expect(docker.calls.some((c) => c.script.includes('pip freeze'))).toBe(true);
  });

  it('tolerates capture failures and garbage: the run result is still produced', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'capture-env'
        ? { exitCode: 1 }
        : c.kind === 'capture-resolved'
          ? { stdout: 'not json at all' }
          : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'npm i x')]));
    expect(result.outcome).toBe('PASS');
    expect(parseResolved(result.runnerEnv)).toEqual({});
  });

  it('npm ls output without a dependencies map yields nothing', async () => {
    const docker = new FakeDocker((c) =>
      c.kind === 'capture-resolved' ? { stdout: '{"name":"work"}' } : undefined,
    );
    const { result } = await go(docker, plan([shell('s1', 'npm i x')]));
    expect(parseResolved(result.runnerEnv)).toEqual({});
  });
});

describe('pure helpers', () => {
  const step = (
    stepId: string,
    kind: string,
    outcome: 'PASS' | 'FAIL' | 'SKIPPED' = 'PASS',
    evidence: string | null = null,
  ) => ({
    stepId,
    ordinal: 0,
    kind,
    outcome,
    exitCode: 0,
    durationMs: 1,
    stdoutTail: null,
    stderrTail: null,
    logFile: null,
    matchedAuthPattern: evidence,
    skipReason: null,
    shadowExportCheck: null,
  });

  const ids = (...x: string[]) => new Set(x);

  it('reachedLevel: L1 needs every install step to have passed', () => {
    expect(reachedLevel([], ids())).toBe(0);
    expect(reachedLevel([step('a', 'shell')], ids('a'))).toBe(1);
    expect(reachedLevel([step('a', 'shell', 'FAIL')], ids('a'))).toBe(0);
    // two installs, the second never ran: not L1
    expect(reachedLevel([step('a', 'shell')], ids('a', 'b'))).toBe(0);
    // a passed non-install shell step does not rescue a failed install
    expect(reachedLevel([step('a', 'shell', 'FAIL'), step('b', 'shell')], ids('a'))).toBe(0);
    // no install steps in the plan: any executed passing step proves the container works
    expect(reachedLevel([step('a', 'shell')], ids())).toBe(1);
    expect(reachedLevel([step('a', 'set_env'), step('b', 'manual', 'SKIPPED')], ids())).toBe(0);
  });

  it('reachedLevel: writing files is NOT level 2; a passed harness check is', () => {
    const written = [step('i', 'shell'), step('w', 'write_file')];
    expect(reachedLevel(written, ids('i'))).toBe(1);
    expect(reachedLevel([...written, step('c1', 'harness_check')], ids('i'))).toBe(2);
    expect(
      reachedLevel(
        [...written, step('c1', 'harness_check'), step('c2', 'harness_check')],
        ids('i'),
      ),
    ).toBe(2);
  });

  it('reachedLevel: a failed harness check caps the level at 1', () => {
    const steps = [
      step('i', 'shell'),
      step('w', 'write_file'),
      step('c1', 'harness_check'),
      step('c2', 'harness_check', 'FAIL'),
    ];
    expect(reachedLevel(steps, ids('i'))).toBe(1);
  });

  it('reachedLevel: L3 is a passed run step WITH auth evidence and no failed check; it does not need a check to exist', () => {
    const base = [step('i', 'shell'), step('w', 'write_file')];
    const E = 'http_401_403';
    expect(
      reachedLevel([...base, step('c', 'harness_check'), step('r', 'run', 'PASS', E)], ids('i')),
    ).toBe(3);
    expect(reachedLevel([...base, step('r', 'run', 'PASS', E)], ids('i'))).toBe(3);
    expect(reachedLevel([step('i', 'shell'), step('r', 'run', 'PASS', E)], ids('i'))).toBe(3);
    expect(
      reachedLevel([...base, step('c', 'harness_check'), step('r', 'run', 'FAIL', E)], ids('i')),
    ).toBe(2);
    expect(reachedLevel([...base, step('c', 'harness_check', 'FAIL')], ids('i'))).toBe(1);
  });

  it('reachedLevel: a run step that passed WITHOUT evidence of reaching a vendor does not make L3 (harness v3): the level stays what the checks proved', () => {
    const base = [step('i', 'shell'), step('w', 'write_file')];
    expect(
      reachedLevel([...base, step('c', 'harness_check'), step('r', 'run', 'PASS', null)], ids('i')),
    ).toBe(2);
    expect(reachedLevel([...base, step('r', 'run', 'PASS', null)], ids('i'))).toBe(1);
    expect(reachedLevel([step('i', 'shell'), step('r', 'run', 'PASS', null)], ids('i'))).toBe(1);
  });

  it('reachedLevel: a run with a failed install is not L3 even if a later run step somehow passed', () => {
    expect(
      reachedLevel(
        [step('i', 'shell', 'FAIL'), step('r', 'run', 'PASS', 'http_401_403')],
        ids('i'),
      ),
    ).toBe(0);
  });

  it('isInstallCommand recognises the common package managers', () => {
    for (const c of [
      'npm install x',
      'npm i x',
      'npm ci',
      'npm add x',
      'pnpm add x',
      'yarn add x',
      'bun add x',
      'pip install x',
      'pip3 install -U x',
      'python -m pip install x',
      'uv pip install x',
      'poetry add x',
      'cd app && npm install',
    ]) {
      expect(isInstallCommand(c), c).toBe(true);
    }
    for (const c of ['npm run build', 'node index.js', 'echo npm', 'pip --version', 'ls'])
      expect(isInstallCommand(c), c).toBe(false);
  });

  it('pickDigest prefers a digest pinned in the reference, then the registry digest, then the local image id', () => {
    const local = { id: `sha256:${'1'.repeat(64)}`, repoDigests: [] as string[] };
    expect(pickDigest(`ghcr.io/x/y@sha256:${'c'.repeat(64)}`, local)).toEqual({
      digest: `sha256:${'c'.repeat(64)}`,
      source: 'registry',
    });
    expect(
      pickDigest('ghcr.io/x/y:22', {
        ...local,
        repoDigests: [`ghcr.io/x/y@sha256:${'d'.repeat(64)}`],
      }),
    ).toEqual({ digest: `sha256:${'d'.repeat(64)}`, source: 'registry' });
    expect(pickDigest('qsr-node:local', local)).toEqual({ digest: local.id, source: 'local' });
    // Docker Desktop's image store invents a repo digest for locally built images: the reference
    // (no registry host) decides, not the presence of a digest.
    const synthesized = { ...local, repoDigests: [`qsr-node@sha256:${'e'.repeat(64)}`] };
    expect(pickDigest('qsr-node:local', synthesized)).toEqual({
      digest: local.id,
      source: 'local',
    });
    expect(
      pickDigest('localhost:5000/qsr-node:22', {
        ...local,
        repoDigests: [`localhost:5000/qsr-node@sha256:${'f'.repeat(64)}`],
      }),
    ).toEqual({ digest: `sha256:${'f'.repeat(64)}`, source: 'registry' });
    expect(pickDigest('ghcr.io/x/y:22', local)).toEqual({ digest: local.id, source: 'registry' }); // registry image, no digest listed
  });

  it('shellQuote single-quotes anything, including quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('outDir', () => {
  it('creates a directory per run attempt and nothing else', async () => {
    const { outDir } = await go(new FakeDocker(), plan([shell('s1', 'true')]));
    expect(await readdir(outDir)).toEqual(['acme-node-1']);
  });
});
