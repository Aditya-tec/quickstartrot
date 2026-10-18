import { execFile } from 'node:child_process';
import { readFile, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunResult, Step, StepIR } from '@qsr/core';
import type { DockerClient } from './docker.js';
import { createDockerCli } from './docker-cli.js';
import { executePlan } from './execute.js';

// INTEGRATION tests against the real Docker daemon: they prove the sandbox does what the spec says,
// which a fake cannot. They skip when Docker is not installed, unless QSR_REQUIRE_DOCKER=1 (set in
// CI, where Docker is preinstalled) - then a missing Docker is a test failure, not a silent skip.

// Token-shaped values are assembled at runtime so scanners cannot mistake them for real credentials.
const fake = (...parts: string[]): string => parts.join('');

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const IMAGE = 'qsr-node:local';

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

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 60 };
const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const shell = (id: string, command: string, over: Partial<typeof EXPECT> = {}): Step => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: { ...EXPECT, ...over },
});
const runStep = (id: string, command: string, over: Partial<typeof EXPECT> = {}): Step => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: { ...EXPECT, ...over },
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
const plan = (steps: Step[]): StepIR => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'none',
  steps,
  maxLevelReachable: 3,
  notes: '',
});

let runCounter = 0;
async function execute(
  ir: StepIR,
  over: { docker?: DockerClient; memory?: string; level?: number; budget?: number } = {},
) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-int-'));
  const runId = `it${process.pid}x${++runCounter}`;
  const result = await executePlan(
    {
      target: {
        slug: 'it-node',
        language: 'node',
        level: over.level ?? 3,
        placeholders: {},
        expect: { authErrorIsPass: true, timeoutSec: over.budget ?? 300 },
      },
      ir,
      image: IMAGE,
      outDir,
      cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
      attempt: 1,
      planId: null,
      snapshotHash: null,
    },
    {
      docker: over.docker ?? createDockerCli(),
      runId,
      ...(over.memory ? { limits: { memory: over.memory } } : {}),
    },
  );
  return { result, outDir, runId, container: `qsr-${runId}` };
}
const exists = async (container: string): Promise<boolean> => {
  const { stdout } = await run('docker', [
    'ps',
    '-a',
    '--filter',
    `name=^${container}$`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.trim() !== '';
};
const stdoutOf = (r: RunResult, id: string): string =>
  r.steps.find((s) => s.stepId === id)?.stdoutTail ?? '';

describe.skipIf(!available)('sandbox (real Docker)', () => {
  beforeAll(async () => {
    try {
      await run('docker', ['image', 'inspect', IMAGE]);
    } catch {
      await run(
        'docker',
        [
          'build',
          '-q',
          '-f',
          path.join(REPO, 'docker/node.Dockerfile'),
          '-t',
          IMAGE,
          path.join(REPO, 'docker'),
        ],
        { timeout: 600_000 },
      );
    }
  }, 700_000);

  it('runs as uid 1001 with every capability dropped, no-new-privileges, and the memory and pid limits', async () => {
    const { result } = await execute(
      plan([
        shell('uid', 'id -u'),
        shell('caps', "grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/self/status"),
        shell('cwd', 'pwd'),
        shell(
          'limits',
          'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max 2>/dev/null || echo cgroup-v1',
        ),
      ]),
    );
    expect(result.outcome).toBe('PASS');
    expect(stdoutOf(result, 'uid').trim()).toBe('1001');
    expect(stdoutOf(result, 'caps')).toMatch(/CapEff:\s+0{16}/);
    expect(stdoutOf(result, 'caps')).toMatch(/CapBnd:\s+0{16}/);
    expect(stdoutOf(result, 'caps')).toMatch(/NoNewPrivs:\s+1/);
    expect(stdoutOf(result, 'cwd').trim()).toBe('/work');
    const limits = stdoutOf(result, 'limits').trim();
    if (limits !== 'cgroup-v1') expect(limits.split('\n')).toEqual(['2147483648', '512']);
  }, 120_000);

  it('SECRET ISOLATION: host secrets never reach the container or any stored log', async () => {
    const planted = {
      GROQ_API_KEY: fake('gsk', '_PLANTED0123456789abcdefghijklmnopqrstuv'),
      SUPABASE_SERVICE_ROLE_KEY: fake(
        'ey',
        'JPLANTED0123456789.',
        'ey',
        'JPLANTED0123456789.PLANTED0123456789sig',
      ),
      INGEST_HMAC_SECRET: 'deadbeefPLANTED0123456789cafebabe0123456789abcdef',
      ADMIN_TOKEN: 'PLANTED-admin-token-0123456789',
      DATABASE_URL: 'postgresql://postgres.x:PLANTEDpassword@db.example/postgres',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const { result, outDir } = await execute(
        plan([
          shell('env', 'env'),
          shell('printenv', 'printenv'),
          shell('init', "tr '\\0' '\\n' < /proc/1/environ"),
          shell('self', "tr '\\0' '\\n' < /proc/self/environ"),
          shell('grep', 'env | grep -ciE "groq|supabase|ingest|admin_token|database_url" || true'),
        ]),
      );
      expect(result.outcome).toBe('PASS');
      expect(stdoutOf(result, 'grep').trim()).toBe('0');
      const files = result.steps.flatMap((s) => (s.logFile ? [s.logFile] : []));
      expect(files).toHaveLength(5);
      const everything =
        JSON.stringify(result) +
        (await Promise.all(files.map((f) => readFile(path.join(outDir, f), 'utf8')))).join('\n');
      for (const value of Object.values(planted)) {
        expect(everything).not.toContain(value);
        expect(everything).not.toContain(value.slice(8, 30)); // not even a fragment
      }
      for (const name of Object.keys(planted)) expect(everything).not.toContain(name);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }, 120_000);

  it.each([
    ['../escape.txt'],
    ['/etc/passwd'],
    ['/work/../etc/escape.txt'],
    ['a/../../escape.txt'],
    ['~/escape.txt'],
  ])(
    'refuses to write %j (outside /work) as a HARNESS_ERROR',
    async (bad) => {
      const { result, container } = await execute(plan([write('w', bad, 'pwned')]));
      expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 'w' });
      expect(await exists(container)).toBe(false);
    },
    120_000,
  );

  it('refuses to write through a symlink that points outside /work, even though the path looks fine', async () => {
    const { result, container } = await execute(
      plan([
        shell('link', 'ln -s /tmp evil && ln -s /etc/passwd victim'),
        write('viaDir', 'evil/pwned.txt', 'pwned'),
        write('viaFile', 'victim', 'pwned'),
      ]),
    );
    expect(result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 'viaDir' });
    expect(result.steps.at(-1)?.stderrTail).toContain('resolves outside /work');
    expect(await exists(container)).toBe(false);

    // The second symlink (to a file) is refused too.
    const second = await execute(
      plan([shell('link', 'ln -s /etc/passwd victim'), write('viaFile', 'victim', 'pwned')]),
    );
    expect(second.result).toMatchObject({ outcome: 'HARNESS_ERROR', failedStepId: 'viaFile' });

    // And nothing was written where the symlink pointed.
    const check = await execute(plan([shell('look', 'ls /tmp/pwned.txt 2>&1 || echo absent')]));
    expect(stdoutOf(check.result, 'look')).toContain('absent');
  }, 180_000);

  it('files written by the harness belong to the runner user, so later steps can append to and rewrite them', async () => {
    const { result } = await execute(
      plan([
        write('w', 'src/deep/a.txt', 'one'),
        append('a', 'src/deep/a.txt', 'two'),
        shell(
          'own',
          'stat -c "%u:%g" src/deep/a.txt && cat src/deep/a.txt && echo three >> src/deep/a.txt && wc -l < src/deep/a.txt',
        ),
      ]),
    );
    expect(result.outcome).toBe('PASS');
    expect(stdoutOf(result, 'own')).toBe('1001:1001\none\ntwo\n3\n');
  }, 120_000);

  it('set_env variables reach every later step, quoted safely', async () => {
    const { result } = await execute(
      plan([
        setEnv('e', 'GREETING', "hello 'big' world; echo INJECTED $(whoami)"),
        shell(
          't',
          'test "$GREETING" = "hello \'big\' world; echo INJECTED \\$(whoami)" && echo MATCH',
        ),
      ]),
    );
    expect(result.outcome).toBe('PASS');
    expect(stdoutOf(result, 't')).toContain('MATCH');
  }, 120_000);

  it('SILENT FAILURE (loops-node, probe #13): a failing pipeline that writes nothing says so, and a failing pipeline that writes something keeps it', async () => {
    const silent = await execute(
      plan([shell('quiet', 'curl -fsS http://127.0.0.1:9/x 2>/dev/null | sh -c "exit 1"')]),
    );
    expect(silent.result.steps[0]).toMatchObject({ outcome: 'FAIL', exitCode: 1, stdoutTail: '' });
    expect(silent.result.steps[0]?.stderrTail).toContain('wrote nothing to stdout or stderr');
    const loud = await execute(
      plan([shell('loud', 'echo "Failed to download checksums" >&2; exit 1')]),
    );
    expect(loud.result.steps[0]?.stderrTail).toBe('Failed to download checksums\n');
  }, 120_000);

  it('TIMEOUT: kills the step, reports exit 124 within the limit, and removes the container', async () => {
    const started = Date.now();
    const { result, container } = await execute(
      plan([shell('slow', 'sleep 120', { timeoutSec: 3 })]),
    );
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result).toMatchObject({ outcome: 'FAIL', failedStepId: 'slow' });
    expect(result.steps[0]).toMatchObject({ exitCode: 124 });
    expect(result.steps[0]?.stderrTail).toContain('timed out after 3s');
    expect(await exists(container)).toBe(false);
  }, 120_000);

  it('a command that ignores SIGTERM is still killed (timeout -k) and the container removed', async () => {
    const { result, container } = await execute(
      plan([shell('stubborn', "trap '' TERM; while true; do sleep 1; done", { timeoutSec: 2 })]),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]?.stderrTail).toContain('timed out after 2s');
    expect(await exists(container)).toBe(false);
  }, 120_000);

  it('CRASH: when the executor throws mid-plan the container is still removed', async () => {
    const real = createDockerCli();
    let execs = 0;
    const crashing: DockerClient = {
      ...real,
      inspectImage: (i) => real.inspectImage(i),
      pullImage: (i) => real.pullImage(i),
      start: (s) => real.start(s),
      remove: (n) => real.remove(n),
      serverVersion: () => real.serverVersion(),
      exec: async (n, argv, o) => {
        // exec 1 is the environment capture, 2 the first step, 3 the second step: crash there.
        if (++execs === 3) throw new Error('simulated executor crash');
        return real.exec(n, argv, o);
      },
    };
    const { result, container } = await execute(
      plan([shell('one', 'echo 1'), shell('two', 'echo 2'), shell('three', 'echo 3')]),
      { docker: crashing },
    );
    expect(result.outcome).toBe('HARNESS_ERROR');
    expect(result.steps.map((s) => s.outcome)).toContain('FAIL');
    expect(await exists(container)).toBe(false);
  }, 120_000);

  it('LOG CAPS: a step printing 10 MB leaves a log of at most 256 KB and tails of at most 4 KB', async () => {
    const { result, outDir } = await execute(
      plan([
        shell(
          'flood',
          "yes 'lorem ipsum dolor sit amet, consectetur' | head -c 10485760; echo done-marker >&2",
        ),
      ]),
    );
    expect(result.outcome).toBe('PASS');
    const step = result.steps[0];
    const size = (await stat(path.join(outDir, step?.logFile ?? 'missing'))).size;
    expect(size).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(size).toBeGreaterThan(200 * 1024);
    expect(Buffer.byteLength(step?.stdoutTail ?? '')).toBeLessThanOrEqual(4096);
    expect(step?.stderrTail).toContain('done-marker'); // the end of the run is still captured
  }, 180_000);

  it('RESOURCE LIMITS: a memory bomb is OOM-killed, reported, and not left running', async () => {
    const started = Date.now();
    const { result, container } = await execute(
      plan([
        shell('bomb', 'node -e "const a=[];for(;;)a.push(Buffer.alloc(32*1024*1024,1))"', {
          timeoutSec: 120,
        }),
      ]),
      { memory: '192m' },
    );
    expect(Date.now() - started).toBeLessThan(110_000);
    expect(result.outcome).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ outcome: 'FAIL', exitCode: 137 });
    expect(result.steps[0]?.stderrTail).toMatch(/SIGKILL.*memory limit of 192m/);
    expect(await exists(container)).toBe(false);
  }, 180_000);

  it('a fork bomb is contained by the pids limit and the container is removed', async () => {
    const { result, container } = await execute(
      plan([
        shell('forks', 'for i in $(seq 1 2000); do sleep 30 & done; wait', { timeoutSec: 20 }),
      ]),
    );
    expect(result.outcome).toBe('FAIL');
    expect(await exists(container)).toBe(false);
  }, 120_000);

  it('AUTH-ERROR-AS-PASS end to end: an auth failure passes a run step, a drift error after it does not', async () => {
    const auth = "console.error('Error: Request failed with status code 401'); process.exit(1)";
    const drift =
      "console.error('HTTP 401 Unauthorized'); console.error('TypeError: client.send is not a function'); process.exit(1)";
    const passes = await execute(
      plan([runStep('r', `node -e "${auth}"`, { authErrorIsPass: true })]),
    );
    expect(passes.result.outcome).toBe('PASS');
    expect(passes.result.steps[0]).toMatchObject({
      exitCode: 1,
      matchedAuthPattern: 'http_401_403',
    });
    const vetoed = await execute(
      plan([runStep('r', `node -e "${drift}"`, { authErrorIsPass: true })]),
    );
    expect(vetoed.result.outcome).toBe('FAIL');
    expect(vetoed.result.steps[0]?.stderrTail).toContain(
      'vetoed by drift pattern "is not a function"',
    );
  }, 120_000);

  it('REDACTION end to end: secret-looking values, IPs and the home path never reach the stored log', async () => {
    const { result, outDir } = await execute(
      plan([
        shell(
          'leak',
          'echo "RESEND_API_KEY=0123456789abcdef0123456789abcdef"; echo "peer 10.20.30.40"; echo "home $HOME"; printf "\\033[31mred\\033[0m\\n"',
        ),
      ]),
    );
    const log = await readFile(path.join(outDir, result.steps[0]?.logFile ?? ''), 'utf8');
    expect(log).toBe('RESEND_API_KEY=[REDACTED]\npeer [REDACTED]\nhome ~\nred\n');
  }, 120_000);

  it('records the real image digest, tool versions and docker version in runner_env', async () => {
    const { result } = await execute(plan([shell('v', 'true')]));
    expect(result.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.runnerEnv).toMatchObject({
      imageRef: IMAGE,
      imageSource: 'local',
      memoryLimit: '2g',
      cpus: '2',
    });
    expect(result.runnerEnv['node']).toMatch(/^v22\./);
    expect(result.runnerEnv['npm']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.runnerEnv['os']).toMatch(/Debian/);
    expect(result.runnerEnv['dockerServer']).toMatch(/^\d+\./);
  }, 120_000);

  it('leaves no qsr containers behind after all of the above', async () => {
    const { stdout } = await run('docker', [
      'ps',
      '-a',
      '--filter',
      `name=qsr-it${process.pid}x`,
      '--format',
      '{{.Names}}',
    ]);
    expect(stdout.trim()).toBe('');
  }, 60_000);
});
