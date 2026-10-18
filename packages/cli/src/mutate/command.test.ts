import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPILER_VERSION, createFileCache } from '@qsr/compiler';
import { contentHash, HARNESS_VERSION, type RunResult } from '@qsr/core';
import type { DockerClient } from '@qsr/executor';
import { recordingLogger } from '../probe/probe.test-utils.js';
import {
  cjsInput,
  esmInput,
  installOnlyInput,
  localInput,
  pythonInput,
  vendorInput,
} from './fixtures.test-utils.js';
import { extractionFile, type MutationInput } from './inputs.js';
import { dockerRunner, mutateCommand } from './command.js';
import type { PlanRunner, RunnerArgs, RunnerOutput } from './run.js';
import { sampleSpread } from './command.js';

// `qsr mutate` is local only. These tests pin that it can never reach the API (no report client, no /internal endpoint, no
// fetch at all), and that the command wires the pieces together: cached inputs in, a results file and a table out.

const here = path.dirname(fileURLToPath(import.meta.url));

describe('qsr mutate never posts anything', () => {
  const sources = async (): Promise<{ name: string; text: string }[]> => {
    const names = (await readdir(here)).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.includes('test-utils'),
    );
    return Promise.all(
      names.map(async (name) => ({ name, text: await readFile(path.join(here, name), 'utf8') })),
    );
  };

  it('no module of mutate/ imports the API client, the admin client, the report job or a plan-push', async () => {
    const banned = [
      /api-client/,
      /admin-client/,
      /probe\/report/,
      /plans-push/,
      /plans-command/,
      /launch-export/,
      /calibration/,
    ];
    for (const { name, text } of await sources()) {
      const imports = text
        .split('\n')
        .filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l) || /^\s*from\b/.test(l));
      for (const re of banned)
        expect(
          imports.filter((l) => re.test(l)),
          `${name} imports ${String(re)}`,
        ).toEqual([]);
    }
  });

  it('no module of mutate/ names an /internal or /admin endpoint, a bearer token, or calls fetch', async () => {
    for (const { name, text } of await sources()) {
      const code = text
        .split('\n')
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code, `${name} mentions /internal`).not.toMatch(/\/internal\//);
      expect(code, `${name} mentions /admin`).not.toMatch(/['"`]\/admin\//);
      expect(code, `${name} reads an API setting`).not.toMatch(
        /API_BASE_URL|ADMIN_TOKEN|INGEST_HMAC_SECRET/,
      );
      expect(code, `${name} calls fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

let dir: string;
let targetsDir: string;
let cacheDir: string;
let workDir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-mutate-'));
  targetsDir = path.join(dir, 'targets');
  cacheDir = path.join(dir, 'cache');
  workDir = path.join(dir, 'work');
  await mkdir(targetsDir, { recursive: true });
});
afterEach(() => vi.unstubAllGlobals());

/** What `qsr plans push` leaves behind: the target file, the plan in the file cache, the crawled page next to it. */
async function seed(
  input: MutationInput,
  over: { withPlan?: boolean; withExtraction?: boolean } = {},
): Promise<void> {
  const t = input.target;
  const yaml = [
    `slug: ${t.slug}`,
    `name: ${t.name}`,
    `docsUrl: ${t.docsUrl}`,
    `language: ${t.language}`,
    `level: ${t.level}`,
    'runtime:',
    `  image: ${t.runtime.image}`,
    'extract:',
    '  root: main',
    ...(t.expect.authErrorIsPass || t.expect.localOnly
      ? [
          'expect:',
          ...(t.expect.authErrorIsPass ? ['  authErrorIsPass: true'] : []),
          ...(t.expect.localOnly ? ['  localOnly: true'] : []),
        ]
      : []),
    'placeholders:',
    ...Object.entries(t.placeholders).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');
  await writeFile(path.join(targetsDir, `${t.slug}.yaml`), `${yaml}\n`);
  const hash = contentHash(input.extraction.blocks);
  if (over.withExtraction !== false) {
    await mkdir(path.join(cacheDir, t.slug), { recursive: true });
    await writeFile(
      extractionFile(cacheDir, t.slug, hash),
      JSON.stringify({ ...input.extraction, contentHash: hash }),
    );
  }
  if (over.withPlan !== false)
    await createFileCache(cacheDir).put({
      ...input.plan,
      toolSlug: t.slug,
      contentHash: hash,
      compilerVersion: COMPILER_VERSION,
    });
}

const out = () => {
  let o = '';
  let e = '';
  return {
    io: { stdout: (t: string) => void (o += t), stderr: (t: string) => void (e += t) },
    out: () => o,
    err: () => e,
  };
};

const pass = (
  a: RunnerArgs,
  outcome: RunResult['outcome'] = 'PASS',
  failed: string | null = null,
  stderr = '',
): RunnerOutput => ({
  result: {
    toolSlug: a.input.target.slug,
    cycleId: randomUUID(),
    attempt: 1,
    planId: null,
    snapshotHash: null,
    outcome,
    reachedLevel: outcome === 'PASS' ? a.input.ir.maxLevelReachable : 1,
    failedStepId: failed,
    steps: a.ir.steps.map((s, i) => ({
      stepId: s.id,
      ordinal: i,
      kind: s.kind,
      outcome: s.id === failed ? ('FAIL' as const) : ('PASS' as const),
      exitCode: s.id === failed ? 1 : 0,
      durationMs: 100,
      stdoutTail: '',
      stderrTail: s.id === failed ? stderr : '',
      logFile: null,
      matchedAuthPattern: null,
      skipReason: null,
    })),
    harnessVersion: 2,
    imageDigest: 'sha256:' + 'a'.repeat(64),
    runnerEnv: { resolved: JSON.stringify({ 'acme-sdk': '3.0.0' }) },
    startedAt: '2026-10-18T00:00:00.000Z',
    finishedAt: '2026-10-18T00:00:00.000Z',
  },
  logs: {},
});

const runner: PlanRunner = async (a) => {
  const s = a.ir.steps[0];
  if (s?.kind === 'shell' && /qq/.test(s.command))
    return pass(
      a,
      'FAIL',
      s.id,
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x',
    );
  return pass(a);
};

describe('qsr mutate <slug>', () => {
  it('runs the cached plan and its mutants, prints a table, writes the results file, and never touches fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must never be called by qsr mutate');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await seed(esmInput());
    const o = out();
    const code = await mutateCommand(
      [
        'esm-node',
        '--targets',
        targetsDir,
        '--cache-dir',
        cacheDir,
        '--work-dir',
        workDir,
        '--operators',
        'pkg_typo,renamed_symbol',
      ],
      recordingLogger(),
      o.io,
      { runner, now: () => new Date('2026-10-18T10:00:00.000Z') },
    );
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(o.out()).toMatch(
      /\| esm-node \| L2 \| pkg_typo \| DETECTED \| L1 \| s1 \(shell\) \| DEPENDENCY_RESOLUTION \(DEPENDENCY_RESOLUTION\) \| dependency.npm_e404 \|/,
    );
    expect(o.out()).toMatch(/\| esm-node \| L2 \| renamed_symbol \| SURVIVED \|/);
    expect(o.out()).toMatch(/install-level L2: 1 of 1 \(100%\) over 1 targets/);
    expect(o.out()).toMatch(/code-level L2: 0 of 1 \(0%\) over 1 targets/);
    expect(o.out()).not.toMatch(/detected \d+ of \d+ tested/);
    const json = JSON.parse(await readFile(path.join(workDir, 'results.json'), 'utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.method).toMatchObject({
      seed: 'p9c',
      compilerVersion: COMPILER_VERSION,
      harnessChecks: 'production (syntax, imports)',
    });
    expect(json.mutants.map((m: { operator: string }) => m.operator)).toEqual([
      'pkg_typo',
      'renamed_symbol',
    ]);
    expect(json.timing.runs).toBeGreaterThan(2);
  });

  it('--controls-only runs the unmutated plans once each, records the harness version, and runs no mutant', async () => {
    await seed(esmInput());
    await seed(cjsInput());
    const seen: string[] = [];
    const recording: PlanRunner = async (a) => {
      seen.push(a.label);
      return pass(a);
    };
    const o = out();
    const code = await mutateCommand(
      [
        '--all',
        '--controls-only',
        '--targets',
        targetsDir,
        '--cache-dir',
        cacheDir,
        '--work-dir',
        workDir,
      ],
      recordingLogger(),
      o.io,
      { runner: recording, now: () => new Date('2026-10-18T10:00:00.000Z') },
    );
    expect(code).toBe(0);
    expect(seen).toEqual(['control', 'control']);
    const json = JSON.parse(await readFile(path.join(workDir, 'controls.json'), 'utf8'));
    expect(json.harnessVersion).toBe(HARNESS_VERSION);
    expect(json.controls.map((c: { slug: string }) => c.slug).sort()).toEqual([
      'cjs-node',
      'esm-node',
    ]);
    expect(json.mutants).toBeUndefined();
    expect(o.out()).toMatch(/controls: 2 of 2 passed/);
  });

  it('skips a target with no cached extraction or no cached plan, and says why', async () => {
    await seed(esmInput(), { withExtraction: false });
    await seed(pythonInput(), { withPlan: false });
    const o = out();
    const code = await mutateCommand(
      [
        '--all',
        '--targets',
        targetsDir,
        '--cache-dir',
        cacheDir,
        '--work-dir',
        workDir,
        '--plan-only',
      ],
      recordingLogger(),
      o.io,
    );
    expect(code).toBe(0);
    expect(o.out()).toMatch(/0 targets with a cached extraction and plan; 2 skipped/);
    expect(o.out()).toMatch(
      /skipped esm-node: no cache directory|skipped esm-node: no cached extraction/,
    );
    expect(o.out()).toMatch(/skipped py-python: no accepted plan in the cache/);
  });

  it('--plan-only counts the mutants without running anything', async () => {
    await seed(esmInput());
    await seed(cjsInput());
    let calls = 0;
    const counting: PlanRunner = async (a) => {
      calls += 1;
      return pass(a);
    };
    const o = out();
    const code = await mutateCommand(
      [
        '--all',
        '--targets',
        targetsDir,
        '--cache-dir',
        cacheDir,
        '--work-dir',
        workDir,
        '--plan-only',
        '--seconds-per-run',
        '30',
      ],
      recordingLogger(),
      o.io,
      { runner: counting },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
    expect(o.out()).toMatch(/2 targets with a cached extraction and plan/);
    expect(o.out()).toMatch(/estimated runtime at concurrency 2: about \d+ minutes/);
  });

  it('refuses a bad usage with exit 2', async () => {
    for (const args of [
      [],
      ['a', '--all'],
      ['x', '--concurrency', '9'],
      ['x', '--concurrency', '0'],
      ['x', '--sample', '0'],
      ['x', '--operators', 'nope'],
      ['x', '--exports-check'],
    ]) {
      const o = out();
      expect(await mutateCommand(args, recordingLogger(), o.io, { runner }), args.join(' ')).toBe(
        2,
      );
      expect(o.err().length).toBeGreaterThan(0);
    }
  });
});

describe('the request budget: qsr mutate makes NO vendor request unless asked (--allow-vendor-calls)', () => {
  const countingRunner =
    (calls: string[]): PlanRunner =>
    async (a) => {
      calls.push(`${a.input.target.slug}:${a.label}`);
      return pass(a);
    };
  const args = (...extra: string[]) => [
    ...extra,
    '--targets',
    targetsDir,
    '--cache-dir',
    cacheDir,
    '--work-dir',
    workDir,
  ];

  it('by default a vendor-facing target is not run at all: no control, no mutant, and its mutants are recorded as "not run"', async () => {
    await seed(esmInput());
    await seed(vendorInput());
    const calls: string[] = [];
    const o = out();
    const code = await mutateCommand(args('--all'), recordingLogger(), o.io, {
      runner: countingRunner(calls),
    });
    expect(code).toBe(0);
    expect(calls.filter((c) => c.startsWith('vendor-node'))).toEqual([]); // the budget
    expect(calls.filter((c) => c.startsWith('esm-node')).length).toBeGreaterThan(0); // the others still run
    const json = JSON.parse(await readFile(path.join(workDir, 'results.json'), 'utf8'));
    const control = json.controls.find((c: { slug: string }) => c.slug === 'vendor-node');
    expect(control).toMatchObject({ included: false, outcome: null });
    expect(control.excludedReason).toMatch(/vendor calls are off.*--allow-vendor-calls/);
    const mine = json.mutants.filter((m: { slug: string }) => m.slug === 'vendor-node');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((m: { status: string }) => m.status === 'not_run').length).toBeGreaterThan(
      0,
    );
    expect(mine.every((m: { outcome: unknown }) => m.outcome === null)).toBe(true);
    expect(o.out()).toMatch(/vendor calls are off.*vendor-node/);
  });

  it('the Docker runner itself refuses a vendor-facing run step unless allowed (a second line of defence), and never touches Docker', async () => {
    const touched: string[] = [];
    const docker = new Proxy(
      {},
      {
        get: (_t, p) => () => {
          touched.push(String(p));
          throw new Error('docker must not be touched');
        },
      },
    ) as unknown as DockerClient;
    const input = vendorInput();
    const args = { input, ir: input.ir, label: 'control', exportsCheck: false };
    await expect(dockerRunner(docker, workDir, recordingLogger())(args)).rejects.toThrow(
      /vendor calls are off/,
    );
    expect(touched).toEqual([]);
    // a plan with no run step (nothing is sent to a vendor) is not refused by the guard: it goes on to Docker (which here fails, and
    // the executor turns that into a HARNESS_ERROR result)
    const noRun = {
      ...args,
      ir: { ...input.ir, steps: input.ir.steps.filter((s) => s.kind !== 'run') },
    };
    const out2 = await dockerRunner(docker, workDir, recordingLogger())(noRun);
    expect(out2.result.outcome).toBe('HARNESS_ERROR');
    expect(touched.length).toBeGreaterThan(0);
    // and with the flag the vendor-facing plan is let through to Docker as well
    touched.length = 0;
    const allowed = await dockerRunner(docker, workDir, recordingLogger(), true, true)(args);
    expect(allowed.result.outcome).toBe('HARNESS_ERROR');
    expect(touched.length).toBeGreaterThan(0);
  });

  it('the table and the document say "not run" (not "harness error"), keep those mutants out of every rate, and list the target as left out with the reason', async () => {
    await seed(esmInput());
    await seed(vendorInput());
    const o = out();
    await mutateCommand(args('--all'), recordingLogger(), o.io, { runner: countingRunner([]) });
    expect(o.out()).toMatch(/\| vendor-node \| L3 \| [a-z_]+ \| not run \|/);
    expect(o.out()).not.toMatch(/\| vendor-node .*harness error/);
    await mutateCommand(
      ['--render', path.join(workDir, 'results.json'), '--targets', targetsDir],
      recordingLogger(),
      out().io,
    );
    const md = await readFile(path.join(dir, 'docs', 'DETECTION-POWER.md'), 'utf8');
    expect(md).toMatch(/\| vendor-node \| vendor calls are off/);
    expect(md).toMatch(/Not run/);
    const json = JSON.parse(await readFile(path.join(dir, 'docs', 'detection-power.json'), 'utf8'));
    expect(json.summary.byKind.code.L3.tested).toBe(0);
    expect(
      json.summary.byKind.code.L3.notRun + json.summary.byKind.install.L3.notRun,
    ).toBeGreaterThan(0);
  });

  it('a single <slug> is held to the same default', async () => {
    await seed(vendorInput());
    const calls: string[] = [];
    await mutateCommand(args('vendor-node'), recordingLogger(), out().io, {
      runner: countingRunner(calls),
    });
    expect(calls).toEqual([]);
  });

  it('--controls-only holds to it too', async () => {
    await seed(vendorInput());
    const calls: string[] = [];
    await mutateCommand(args('--all', '--controls-only'), recordingLogger(), out().io, {
      runner: countingRunner(calls),
    });
    expect(calls).toEqual([]);
  });

  it('--allow-vendor-calls turns it on: the vendor target is then run like any other', async () => {
    await seed(vendorInput());
    const calls: string[] = [];
    await mutateCommand(args('--all', '--allow-vendor-calls'), recordingLogger(), out().io, {
      runner: countingRunner(calls),
    });
    expect(calls.some((c) => c === 'vendor-node:control')).toBe(true);
    const json = JSON.parse(await readFile(path.join(workDir, 'results.json'), 'utf8'));
    expect(json.mutants.some((m: { status: string }) => m.status === 'not_run')).toBe(false);
  });

  it('a target that only runs locally (level 3 without auth-error-as-pass, or declared local) is not a vendor call and is run', async () => {
    await seed(cjsInput()); // level 3, no authErrorIsPass: the run step involves no vendor
    const calls: string[] = [];
    await mutateCommand(args('--all'), recordingLogger(), out().io, {
      runner: countingRunner(calls),
    });
    expect(calls.some((c) => c === 'cjs-node:control')).toBe(true);
  });
});

describe('qsr mutate --render with results saved by an older build', () => {
  it('recomputes the summary from the saved records, so results without the install/code split still render', async () => {
    await seed(esmInput());
    await mutateCommand(
      ['esm-node', '--targets', targetsDir, '--cache-dir', cacheDir, '--work-dir', workDir],
      recordingLogger(),
      out().io,
      { runner },
    );
    const file = path.join(workDir, 'results.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    delete saved.summary.byKind;
    delete saved.summary.noSite;
    delete saved.summary.levelTargets;
    saved.rerunTargets = [
      {
        slug: 'esm-node',
        reason: 'its level changed under harness v3; the whole target was run again',
      },
    ];
    saved.reruns = [
      {
        slug: 'esm-node',
        operator: 'pkg_typo',
        reason: 'the network failed twice in the full run; run again alone, same seed',
      },
    ];
    await writeFile(file, JSON.stringify(saved));
    const docs = path.join(dir, 'docs');
    await mkdir(docs, { recursive: true });
    expect(
      await mutateCommand(['--render', file, '--targets', targetsDir], recordingLogger(), out().io),
    ).toBe(0);
    expect(await readFile(path.join(docs, 'DETECTION-POWER.md'), 'utf8')).toContain(
      '### Code-level mutants',
    );
    expect(await readFile(path.join(docs, 'DETECTION-POWER.md'), 'utf8')).toMatch(
      /esm-node `pkg_typo`: .*run again alone/,
    );
    expect(await readFile(path.join(docs, 'DETECTION-POWER.md'), 'utf8')).toMatch(
      /Targets run again: esm-node: its level changed under harness v3/,
    );
  });
});

describe('qsr mutate --render: local targets and what L3 rests on', () => {
  const countingRunner = (): PlanRunner => async (a) => pass(a);
  interface Rendered {
    md: string;
    json: {
      summary: {
        levelTargets: { local: number };
        l3Targets: string[];
        byKind: { code: { local: { targets: number } } };
      };
      controls: { slug: string; local?: boolean }[];
    };
  }
  async function renderBoth(): Promise<Rendered> {
    await seed(esmInput());
    await seed(localInput());
    await seed(vendorInput());
    await mutateCommand(
      [
        '--all',
        '--allow-vendor-calls',
        '--targets',
        targetsDir,
        '--cache-dir',
        cacheDir,
        '--work-dir',
        workDir,
      ],
      recordingLogger(),
      out().io,
      { runner: countingRunner() },
    );
    await mutateCommand(
      ['--render', path.join(workDir, 'results.json'), '--targets', targetsDir],
      recordingLogger(),
      out().io,
    );
    return {
      md: await readFile(path.join(dir, 'docs', 'DETECTION-POWER.md'), 'utf8'),
      json: JSON.parse(
        await readFile(path.join(dir, 'docs', 'detection-power.json'), 'utf8'),
      ) as Rendered['json'],
    };
  }

  it('reads the "local" flag from the target files: their results are not discarded and not in L3, they have their own row', async () => {
    const { md, json } = await renderBoth();
    expect(md).toContain('Executed locally (no vendor)');
    expect(json.summary.levelTargets.local).toBe(1);
    expect(json.summary.byKind.code.local.targets).toBe(1);
    expect(json.controls.find((c) => c.slug === 'local-node')?.local).toBe(true);
    expect(json.summary.l3Targets).toEqual(['vendor-node']);
  });

  it('states plainly which targets L3 rests on, and quotes no L3 detection percentage', async () => {
    const { md } = await renderBoth();
    expect(md).toMatch(/L3 rests on 1 target \(vendor-node\)/);
    expect(md).toMatch(/until the shadow-L3 targets are promoted/i);
    const l3Rows = md.split('\n').filter((l) => /^\| L3 \|/.test(l));
    expect(l3Rows.length).toBeGreaterThan(0);
    for (const row of l3Rows) expect(row, row).not.toMatch(/\d+%/);
  });
});

describe('qsr mutate --render --v1', () => {
  it('adds the harness v1 to v2 table (code-level, by level) and lists what v2 newly detects, from two saved results', async () => {
    await seed(esmInput());
    const run = async (name: string, over: PlanRunner) => {
      await mutateCommand(
        [
          'esm-node',
          '--targets',
          targetsDir,
          '--cache-dir',
          cacheDir,
          '--work-dir',
          workDir,
          '--operators',
          'pkg_typo,syntax_error',
          '--out-json',
          path.join(workDir, name),
        ],
        recordingLogger(),
        out().io,
        { runner: over },
      );
      return path.join(workDir, name);
    };
    // v1 misses the syntax error in an ES-module .js file; v2 sees it
    const v1 = await run('v1.json', runner);
    const seesSyntax: PlanRunner = async (a) => {
      const s = a.ir.steps.find((x) => x.kind === 'write_file');
      return s && /\.m?js$/.test((s as { path: string }).path) && a.label === 'syntax_error'
        ? pass(a, 'FAIL', s.id, 'SyntaxError: Unexpected token')
        : runner(a);
    };
    const v2 = await run('v2.json', seesSyntax);
    const docs = path.join(dir, 'docs');
    await mkdir(docs, { recursive: true });
    const code = await mutateCommand(
      ['--render', v2, '--v1', v1, '--targets', targetsDir],
      recordingLogger(),
      out().io,
    );
    expect(code).toBe(0);
    const md = await readFile(path.join(docs, 'DETECTION-POWER.md'), 'utf8');
    expect(md).toContain('## Harness versions, same mutants, same seed');
    expect(md).toContain('harness v1');
    expect(md).toContain('esm-node:syntax_error');
    const json = JSON.parse(await readFile(path.join(docs, 'detection-power.json'), 'utf8'));
    expect(json.harnessComparison.newlyMissed).toEqual([]);
  });
});

describe('sampling', () => {
  const inputs = (): MutationInput[] => [esmInput(), cjsInput(), pythonInput(), installOnlyInput()];

  it('spreads the sample across the levels the plans can reach, and is deterministic', () => {
    const a = sampleSpread(inputs(), 3, 'seed');
    expect(a.map((i) => i.ir.maxLevelReachable).sort()).toEqual([1, 2, 3]);
    expect(sampleSpread(inputs(), 3, 'seed').map((i) => i.target.slug)).toEqual(
      a.map((i) => i.target.slug),
    );
    expect(a.map((i) => i.target.slug)).toEqual([...a.map((i) => i.target.slug)].sort());
  });

  it('takes everything when asked for more than exists, and fills from the larger levels first', () => {
    expect(sampleSpread(inputs(), 99, 's')).toHaveLength(4);
    const four = sampleSpread(inputs(), 4, 's');
    expect(four.filter((i) => i.ir.maxLevelReachable === 2)).toHaveLength(2);
  });
});

describe('qsr mutate --render', () => {
  it('writes the public document and the raw results from saved results, keeps a hand-written Recommendation, and runs nothing', async () => {
    await seed(esmInput());
    const o1 = out();
    await mutateCommand(
      ['esm-node', '--targets', targetsDir, '--cache-dir', cacheDir, '--work-dir', workDir],
      recordingLogger(),
      o1.io,
      { runner },
    );
    const results = path.join(workDir, 'results.json');

    const docs = path.join(dir, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(
      path.join(docs, 'DETECTION-POWER.md'),
      '# old\n\n## Recommendation\n\nWritten by a person.\n',
    );
    let calls = 0;
    const counting: PlanRunner = async (a) => {
      calls += 1;
      return runner(a);
    };
    const o2 = out();
    const code = await mutateCommand(
      ['--render', results, '--targets', targetsDir],
      recordingLogger(),
      o2.io,
      { runner: counting },
    );
    expect(code).toBe(0);
    expect(calls).toBe(0);
    const md = await readFile(path.join(docs, 'DETECTION-POWER.md'), 'utf8');
    expect(md).toMatch(/^# Detection power/);
    expect(md).toContain('## What this does NOT show');
    expect(md).toContain('It does not show how often real quickstarts break');
    expect(md).toContain('### Install-level mutants');
    expect(md).toContain('### Code-level mutants');
    expect(md).not.toMatch(/Overall:/); // there is no blended headline
    expect(md).not.toMatch(/mixes very different kinds/);
    expect(md).toMatch(/targets at each level/i);
    expect(md).toContain('## Survivors');
    expect(md.endsWith('## Recommendation\n\nWritten by a person.\n')).toBe(true);
    const json = JSON.parse(await readFile(path.join(docs, 'detection-power.json'), 'utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.timing).toBeUndefined(); // the local wall time is not part of what is published
    expect(json.summary.controls.included).toBe(1);
  });
});
