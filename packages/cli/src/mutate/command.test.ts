import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPILER_VERSION, createFileCache } from '@qsr/compiler';
import { contentHash, type RunResult } from '@qsr/core';
import { recordingLogger } from '../probe/probe.test-utils.js';
import { cjsInput, esmInput, installOnlyInput, pythonInput } from './fixtures.test-utils.js';
import { extractionFile, type MutationInput } from './inputs.js';
import { mutateCommand } from './command.js';
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
    expect(o.out()).toMatch(/detected 1 of 2 tested \(50%\)/);
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
    expect(md).toContain('### By level');
    expect(md).toContain('## Survivors');
    expect(md.endsWith('## Recommendation\n\nWritten by a person.\n')).toBe(true);
    const json = JSON.parse(await readFile(path.join(docs, 'detection-power.json'), 'utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.timing).toBeUndefined(); // the local wall time is not part of what is published
    expect(json.summary.controls.included).toBe(1);
  });
});
