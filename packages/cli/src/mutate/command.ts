import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { COMPILER_VERSION } from '@qsr/compiler';
import { HARNESS_VERSION, type Logger } from '@qsr/core';
import { createDockerCli, executePlan, type DockerClient } from '@qsr/executor';
import { createLimiter } from '../probe/crawl-pool.js';
import { processIo, USAGE, type CliIo } from '../commands.js';
import { loadAllTargets, loadTarget } from '../targets.js';
import { loadInput, type MutationInput } from './inputs.js';
import { OPERATOR_IDS, type OperatorId } from './operators.js';
import {
  buildResults,
  renderDocument,
  renderSampleTable,
  type DetectionResults,
} from './report.js';
import { createRng } from './rng.js';
import { compareHarnessRuns, KINDS, summarize } from './stats.js';
import { survivorReason } from './survivors.js';
import {
  pairKey,
  planMutants,
  isVendorFacing,
  notRunControl,
  notRunRecord,
  runControl,
  runMutation,
  VENDOR_CALLS_OFF,
  type ControlRecord,
  type MutantRecord,
  type PlanRunner,
} from './run.js';

// `qsr mutate`: mutation testing of the monitor. Local only. This module (and everything under mutate/) must never import
// the API client, the admin client or the report job, never call fetch, and never touch an /internal endpoint: a mutated run
// is not a result and must not be able to reach the database. A test pins it. The only network a mutant uses is the package
// registries, through the normal executor in Docker.

export interface MutateOverrides {
  runner?: PlanRunner;
  docker?: DockerClient;
  now?: () => Date;
}

const DEFAULT_SEED = 'p9c';

/** N targets spread over the levels the plans can reach, in a seeded order. */
export function sampleSpread(
  inputs: readonly MutationInput[],
  n: number,
  seed: string,
): MutationInput[] {
  const strata = new Map<number, MutationInput[]>();
  for (const level of [1, 2, 3]) strata.set(level, []);
  for (const i of inputs) strata.get(Math.min(3, Math.max(1, i.ir.maxLevelReachable)))?.push(i);
  const rng = createRng(seed, 'sample');
  const queues = [...strata.entries()].map(([, list]) => [
    ...rng.shuffle(list.sort((a, b) => (a.target.slug < b.target.slug ? -1 : 1))),
  ]);
  const picked: MutationInput[] = [];
  while (picked.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && picked.length < n) picked.push(next);
    }
  }
  return picked.sort((a, b) => (a.target.slug < b.target.slug ? -1 : 1));
}

/** The Docker runner: the same executor the probe uses, one fresh container per run. */
export function dockerRunner(
  docker: DockerClient,
  workDir: string,
  log: Logger,
  exportsCheckAvailable = true,
  allowVendorCalls = false,
): PlanRunner {
  return async ({ input, ir, label, exportsCheck }) => {
    // A second line of defence behind the filtering in mutateCommand: a plan whose run step would send a request to a vendor never
    // reaches Docker unless the person asked for it.
    if (!allowVendorCalls && isVendorFacing(input.target) && ir.steps.some((s) => s.kind === 'run'))
      throw new Error(`${input.target.slug}: ${VENDOR_CALLS_OFF}`);
    const outDir = path.resolve(workDir, 'runs', input.target.slug, label);
    const result = await executePlan(
      {
        target: input.target,
        ir,
        image: input.target.runtime.image,
        outDir,
        cycleId: randomUUID(),
        attempt: 1,
        planId: null,
        snapshotHash: input.extraction.contentHash,
      },
      { docker, log, ...(exportsCheck && exportsCheckAvailable ? { exportsCheck: true } : {}) },
    );
    const logs: Record<string, string> = {};
    for (const s of result.steps) {
      if (!s.logFile) continue;
      try {
        logs[s.stepId] = await readFile(path.join(outDir, s.logFile), 'utf8');
      } catch {
        /* the stored tails are used instead */
      }
    }
    return { result, logs };
  };
}

const parseOperators = (text: string | undefined): OperatorId[] | null => {
  if (text === undefined) return [...OPERATOR_IDS];
  const wanted = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = wanted.filter((w) => !(OPERATOR_IDS as readonly string[]).includes(w));
  return bad.length > 0 ? null : (wanted as OperatorId[]);
};

/**
 * `--render <results.json> [--compare <results-with-the-check.json>] [--v1 <results-of-the-earlier-harness.json>]`: writes docs/DETECTION-POWER.md and docs/detection-power.json from
 * results that were already produced. Runs nothing. The first file is the production-checks run; the comparison, when given, is
 * the run with the experimental export check (it carries its own before/after numbers).
 */
async function renderFromFiles(
  file: string,
  compare: string | undefined,
  v1: string | undefined,
  targetsDir: string,
  io: CliIo,
): Promise<number> {
  const base = JSON.parse(await readFile(path.resolve(file), 'utf8')) as DetectionResults;
  // The summary is derived from the records too, so results saved by an older build get the figures of the current one.
  base.summary = summarize(base.controls, base.mutants);
  // Reasons are derived from stored facts, so a refinement of the wording applies to results that already exist.
  for (const m of base.mutants) {
    const control = base.controls.find((c) => c.slug === m.slug);
    if (m.status !== 'survived' || !control) continue;
    try {
      const language = (await loadTarget(targetsDir, m.slug)).language;
      m.survivorReason = survivorReason({
        operator: m.operator,
        language,
        controlLevel: control.reachedLevel ?? 0,
        runsSnippet: control.hasRunStep,
        writesSource: control.writesSource,
        exportsCheck: m.exportsCheck,
      });
    } catch {
      /* the target file is gone: keep the stored reason */
    }
  }
  if (compare !== undefined) {
    const other = JSON.parse(await readFile(path.resolve(compare), 'utf8')) as DetectionResults;
    base.comparison = other.comparison;
  }
  if (v1 !== undefined) {
    const before = JSON.parse(await readFile(path.resolve(v1), 'utf8')) as DetectionResults;
    base.harnessComparison = compareHarnessRuns(before, base);
  }
  const repoRoot = path.resolve(targetsDir, '..');
  const docPath = path.join(repoRoot, 'docs', 'DETECTION-POWER.md');
  let existing: string | undefined;
  try {
    existing = await readFile(docPath, 'utf8');
  } catch {
    existing = undefined;
  }
  await mkdir(path.dirname(docPath), { recursive: true });
  await writeFile(docPath, renderDocument(base, existing));
  const publishable: Record<string, unknown> = { ...base };
  delete publishable['timing']; // the local wall time is not part of what is published
  await writeFile(
    path.join(repoRoot, 'docs', 'detection-power.json'),
    `${JSON.stringify(publishable, null, 2)}
`,
  );
  io.stdout(`wrote ${docPath} and docs/detection-power.json
`);
  return 0;
}

export async function mutateCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  overrides: MutateOverrides = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      sample: { type: 'string' },
      seed: { type: 'string', default: DEFAULT_SEED },
      operators: { type: 'string' },
      concurrency: { type: 'string', default: '2' },
      targets: { type: 'string', default: 'targets' },
      'cache-dir': { type: 'string', default: '.qsr-cache' },
      'work-dir': { type: 'string', default: '.qsr-mutate' },
      'out-json': { type: 'string' },
      'write-docs': { type: 'boolean', default: false },
      'plan-only': { type: 'boolean', default: false },
      'exports-check': { type: 'boolean', default: false },
      'controls-only': { type: 'boolean', default: false },
      'allow-vendor-calls': { type: 'boolean', default: false },
      baseline: { type: 'string' },
      'seconds-per-run': { type: 'string' },
      render: { type: 'string' },
      compare: { type: 'string' },
      v1: { type: 'string' },
    },
  });
  if (values.render !== undefined)
    return renderFromFiles(
      values.render,
      values.compare,
      values.v1,
      path.resolve(values.targets),
      io,
    );
  const slug = positionals[0];
  const all = values.all || values.sample !== undefined;
  if ((slug === undefined) === !all) {
    io.stderr(`give either a <slug> or --all\n\n${USAGE}`);
    return 2;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    io.stderr('--concurrency must be a whole number from 1 to 4\n');
    return 2;
  }
  const sample = values.sample === undefined ? null : Number(values.sample);
  if (sample !== null && (!Number.isInteger(sample) || sample < 1)) {
    io.stderr('--sample must be a whole number of at least 1\n');
    return 2;
  }
  const operators = parseOperators(values.operators);
  if (operators === null) {
    io.stderr(`unknown operator in --operators; known: ${OPERATOR_IDS.join(', ')}\n`);
    return 2;
  }

  if (values['exports-check'] && !values.baseline) {
    io.stderr(
      '--exports-check compares with an earlier run: give --baseline <results.json> (the run without the check)\n',
    );
    return 2;
  }

  const targetsDir = path.resolve(values.targets);
  const cacheDir = path.resolve(values['cache-dir']);
  const workDir = path.resolve(values['work-dir']);
  const targets = all
    ? (await loadAllTargets(targetsDir)).filter((t) => t.enabled !== false)
    : [await loadTarget(targetsDir, slug as string)];

  const skipped: DetectionResults['skipped'] = [];
  let inputs: MutationInput[] = [];
  for (const t of targets) {
    const loaded = await loadInput(t, cacheDir);
    if (loaded.ok) inputs.push(loaded.input);
    else skipped.push({ slug: t.slug, reason: loaded.reason });
  }
  if (sample !== null) inputs = sampleSpread(inputs, sample, values.seed);

  // The request budget: a target whose run step makes a request to a vendor is NOT run unless --allow-vendor-calls. It is recorded
  // (a control that was not run, its mutants as "not run"), so the results say what is missing instead of silently leaving it out.
  const allowVendorCalls = values['allow-vendor-calls'];
  const vendorOff = allowVendorCalls ? [] : inputs.filter((i) => isVendorFacing(i.target));
  if (vendorOff.length > 0) inputs = inputs.filter((i) => !isVendorFacing(i.target));
  const offControls: ControlRecord[] = vendorOff.map(notRunControl);
  const offMutants: MutantRecord[] = vendorOff.flatMap((i) =>
    operators.flatMap((op) => {
      const rec = notRunRecord(i, notRunControl(i), op, values.seed);
      return rec === null ? [] : [rec];
    }),
  );
  const vendorNote =
    vendorOff.length === 0
      ? ''
      : `${VENDOR_CALLS_OFF}: ${vendorOff.map((i) => i.target.slug).join(', ')} (${offMutants.filter((m) => m.status === 'not_run').length} mutants recorded as not run)\n`;

  const baseline = values.baseline
    ? (JSON.parse(await readFile(path.resolve(values.baseline), 'utf8')) as DetectionResults)
    : undefined;
  // With a baseline only the controls and the survivors of that run are run again: a detected mutant stays detected.
  const only = baseline
    ? new Set(
        baseline.mutants
          .filter((m) => m.status === 'survived')
          .map((m) => pairKey(m.slug, m.operator)),
      )
    : undefined;
  if (baseline)
    inputs = inputs.filter((i) =>
      baseline.controls.some((c) => c.slug === i.target.slug && c.included),
    );

  if (values['plan-only']) {
    const controls = new Map<string, ControlRecord>(
      inputs.map((i) => [
        i.target.slug,
        {
          slug: i.target.slug,
          included: true,
          excludedReason: null,
          outcome: 'PASS',
          reachedLevel: i.ir.maxLevelReachable,
          targetLevel: i.target.level,
          retried: false,
          durationMs: null,
          resolved: {},
          hasRunStep: i.ir.steps.some((s) => s.kind === 'run'),
          writesSource: true,
        },
      ]),
    );
    const planned = planMutants(inputs, controls, {
      operators,
      seed: values.seed,
      exportsCheck: false,
    });
    const runnable = planned.filter((m) => m.note === null && m.status !== 'invalid').length;
    const counts = Object.fromEntries(
      OPERATOR_IDS.map((id) => [
        id,
        planned.filter((m) => m.operator === id && m.note === null).length,
      ]),
    );
    const perRun =
      values['seconds-per-run'] === undefined ? null : Number(values['seconds-per-run']);
    const runs = runnable + inputs.length; // controls included
    io.stdout(
      [
        `${inputs.length} targets with a cached extraction and plan; ${skipped.length} skipped.`,
        ...skipped.map((s) => `  skipped ${s.slug}: ${s.reason}`),
        `mutants ready to run (an operator with a site that the real validator accepts): ${runnable}; per operator: ${OPERATOR_IDS.map((id) => `${id} ${counts[id]}`).join(', ')}`,
        `(previous_major is counted as runnable only once a control has resolved a version, so the real number is a little higher)`,
        `runs in total with the controls: about ${runs}`,
        perRun === null
          ? 'pass --seconds-per-run N for a runtime estimate'
          : `estimated runtime at concurrency ${concurrency}: about ${Math.round((runs * perRun) / concurrency / 60)} minutes`,
      ].join('\n') + '\n',
    );
    return 0;
  }

  const docker = overrides.docker ?? createDockerCli();
  if (!overrides.runner && (await docker.serverVersion()) === 'unknown') {
    io.stderr(
      'Docker is not reachable. Start Docker Desktop (or the docker daemon) and try again.\n',
    );
    return 4;
  }
  const runner = overrides.runner ?? dockerRunner(docker, workDir, log, true, allowVendorCalls);
  if (vendorNote !== '') io.stdout(vendorNote);
  const now = overrides.now ?? (() => new Date());

  if (values['controls-only']) {
    const limit = createLimiter(concurrency);
    const controls = await Promise.all(
      inputs.map((input) =>
        limit(input.target.slug, async () => {
          const c = await runControl(runner, input, false);
          io.stdout(
            `  control ${c.slug}: ${c.included ? `PASS at L${c.reachedLevel}` : `${c.outcome ?? 'EXCLUDED'}, ${c.excludedReason}`}
`,
          );
          return c;
        }),
      ),
    );
    controls.push(...offControls);
    const outFile = path.resolve(values['out-json'] ?? path.join(workDir, 'controls.json'));
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(
      outFile,
      `${JSON.stringify({ generatedAt: now().toISOString(), harnessVersion: HARNESS_VERSION, compilerVersion: COMPILER_VERSION, skipped, controls }, null, 2)}
`,
    );
    const passed = controls.filter((c) => c.included).length;
    io.stdout(
      `controls: ${passed} of ${controls.length} passed under harness v${HARNESS_VERSION}${skipped.length ? `; ${skipped.length} skipped (no cached input)` : ''}; results: ${outFile}
`,
    );
    return 0;
  }

  const started = Date.now();
  io.stdout(
    `${inputs.length} targets, ${operators.length} operators, concurrency ${concurrency}, seed ${values.seed}${values['exports-check'] ? ', export check ON (survivors of the baseline only)' : ''}\n`,
  );
  const run = await runMutation(runner, inputs, {
    operators,
    seed: values.seed,
    concurrency,
    exportsCheck: values['exports-check'],
    ...(only ? { only } : {}),
    onProgress: (line) => io.stdout(`  ${line}\n`),
  });
  const results = buildResults({
    generatedAt: now().toISOString(),
    method: {
      seed: values.seed,
      operators,
      concurrency,
      sample,
      harnessVersion: HARNESS_VERSION,
      harnessChecks: values['exports-check']
        ? 'production plus qsr-check-exports (experimental)'
        : 'production (syntax, imports)',
      compilerVersion: COMPILER_VERSION,
      targetsRequested: targets.length,
    },
    skipped,
    controls: [...run.controls, ...offControls],
    mutants: [...run.mutants, ...offMutants],
    baseline: baseline ? { controls: baseline.controls, mutants: baseline.mutants } : undefined,
  });
  const wallSeconds = Math.round((Date.now() - started) / 1000);

  const outJson = path.resolve(
    values['out-json'] ??
      path.join(workDir, values['exports-check'] ? 'results-exports-check.json' : 'results.json'),
  );
  await mkdir(path.dirname(outJson), { recursive: true });
  await writeFile(
    outJson,
    `${JSON.stringify({ ...results, timing: { wallSeconds, runs: run.controls.length + run.mutants.filter((m) => m.outcome !== null).length } }, null, 2)}\n`,
  );
  io.stdout(`\n${renderSampleTable(results.mutants)}\n\n`);
  const s = results.summary;
  io.stdout(
    [
      `controls: ${s.controls.included} of ${s.controls.total} passed${s.controls.excluded.length ? `; excluded: ${s.controls.excluded.map((e) => e.slug).join(', ')}` : ''}`,
      'detected of tested, by kind and level (install-level and code-level are never blended):',
      ...KINDS.flatMap((kind) =>
        (['L1', 'L2', 'L3'] as const).map((l) => {
          const r = s.byKind[kind][l];
          return `  ${kind}-level ${l}: ${r.detected} of ${r.tested}${r.detection === null ? '' : ` (${Math.round(r.detection * 100)}%)`} over ${r.targets} targets; no site ${r.notApplicable}, invalid ${r.invalid}, harness errors ${r.harnessError}`;
        }),
      ),
      `wall time ${wallSeconds} s; results: ${outJson}`,
    ].join('\n') + '\n',
  );

  if (values['write-docs']) {
    const repoRoot = path.resolve(targetsDir, '..');
    const docPath = path.join(repoRoot, 'docs', 'DETECTION-POWER.md');
    let existing: string | undefined;
    try {
      existing = await readFile(docPath, 'utf8');
    } catch {
      existing = undefined;
    }
    await writeFile(docPath, renderDocument(results, existing));
    await writeFile(
      path.join(repoRoot, 'docs', 'detection-power.json'),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    io.stdout(`wrote ${docPath} and docs/detection-power.json\n`);
  }
  return 0;
}
