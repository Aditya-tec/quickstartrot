import { classify, inputFromRunResult, unknownClassification } from '@qsr/classifier';
import {
  parseResolved,
  type FailureClass,
  type RunResult,
  type StepIR,
  type Target,
} from '@qsr/core';
import { createLimiter } from '../probe/crawl-pool.js';
import { groundingReport, type MutationInput } from './inputs.js';
import {
  applyOperator,
  firstInstall,
  OPERATOR_IDS,
  OPERATOR_INFO,
  previousMajorPlan,
  resolvedMajor,
  type Mutant,
  type OperatorId,
  type Pair,
} from './operators.js';
import { createRng } from './rng.js';
import { survivorReason } from './survivors.js';

// The engine of `qsr mutate`: controls first, then every mutant of every target whose control passed. The engine never
// talks to the network itself. It is handed a `PlanRunner` (Docker in the command, a fake in tests) and nothing else.

export interface RunnerArgs {
  input: MutationInput;
  ir: StepIR;
  label: string;
  /** The experimental export check (`qsr-check-exports`). Off unless asked for. */
  exportsCheck: boolean;
}
export interface RunnerOutput {
  result: RunResult;
  /** The redacted step logs by step id, for the classifier. */
  logs: Record<string, string>;
}
export type PlanRunner = (args: RunnerArgs) => Promise<RunnerOutput>;

export interface Classified {
  failureClass: FailureClass | null;
  ruleId: string | null;
  evidence: string | null;
  failedStepKind: string | null;
}

/** The class and rule our classifier gives a finished run: what a production cycle would have recorded. */
export function classifyRun(
  { input, ir }: Pick<RunnerArgs, 'input' | 'ir'>,
  out: RunnerOutput,
): Classified {
  const failed = out.result.steps.find((s) => s.stepId === out.result.failedStepId);
  const commands: Record<string, string> = {};
  for (const s of ir.steps) if (s.kind === 'shell' || s.kind === 'run') commands[s.id] = s.command;
  const c = inputFromRunResult(out.result, {
    language: input.target.language,
    targetLevel: input.target.level,
    authErrorIsPass:
      failed?.kind === 'run' && input.target.expect.authErrorIsPass && input.target.level >= 3,
    logs: out.logs,
    commands,
  });
  if (c === null) return { failureClass: null, ruleId: null, evidence: null, failedStepKind: null };
  const k = classify(c) ?? unknownClassification(c);
  return {
    failureClass: k.failureClass,
    ruleId: k.ruleId,
    evidence: k.evidenceLine,
    failedStepKind: failed?.kind ?? null,
  };
}

const stepsMillis = (r: RunResult): number => r.steps.reduce((n, s) => n + s.durationMs, 0);

export interface ControlRecord {
  slug: string;
  included: boolean;
  /** Why a target is out of the statistics. */
  excludedReason: string | null;
  outcome: RunResult['outcome'] | null;
  reachedLevel: number | null;
  targetLevel: number;
  retried: boolean;
  durationMs: number | null;
  /** Primary package and the versions the control resolved, for operator 8. */
  resolved: Record<string, string>;
  hasRunStep: boolean;
  writesSource: boolean;
  /** The target declares that no vendor is involved (expect.localOnly): its results are a category of their own, not an L3 claim. */
  local?: boolean;
}

const writesSource = (ir: StepIR): boolean =>
  ir.steps.some(
    (s) =>
      (s.kind === 'write_file' || s.kind === 'append_file') &&
      (ir.language === 'node' ? /\.(?:[cm]?js|[cm]?ts)$/.test(s.path) : /\.py$/.test(s.path)),
  );

/** The unmutated plan, once more; a failure is retried once; a target that still does not PASS is excluded with the reason. */
export async function runControl(
  runner: PlanRunner,
  input: MutationInput,
  exportsCheck: boolean,
): Promise<ControlRecord> {
  const base = {
    slug: input.target.slug,
    targetLevel: input.target.level,
    hasRunStep: input.ir.steps.some((s) => s.kind === 'run'),
    writesSource: writesSource(input.ir),
    ...(input.target.expect.localOnly === true ? { local: true } : {}),
  };
  const grounding = groundingReport({ extraction: input.extraction, ir: input.ir }, input.target);
  if (!grounding.ok)
    return {
      ...base,
      included: false,
      excludedReason: `the cached plan no longer passes the grounding validator against its cached extraction (${grounding.violations
        .slice(0, 3)
        .map((v) => `${v.stepId} ${v.rule}`)
        .join(', ')})`,
      outcome: null,
      reachedLevel: null,
      retried: false,
      durationMs: null,
      resolved: {},
    };
  let out = await runner({ input, ir: input.ir, label: 'control', exportsCheck });
  let retried = false;
  if (out.result.outcome !== 'PASS') {
    retried = true;
    out = await runner({ input, ir: input.ir, label: 'control-retry', exportsCheck });
  }
  const r = out.result;
  const cls = classifyRun({ input, ir: input.ir }, out);
  const ok = r.outcome === 'PASS';
  return {
    ...base,
    included: ok,
    excludedReason: ok
      ? null
      : `the control did not pass twice: ${r.outcome} at ${r.failedStepId ?? 'a manual step'}${cls.failureClass ? ` (${cls.failureClass}, ${cls.ruleId})` : ''}`,
    outcome: r.outcome,
    reachedLevel: r.reachedLevel,
    retried,
    durationMs: stepsMillis(r),
    resolved: parseResolved(r.runnerEnv),
  };
}

export type MutantStatus =
  'detected' | 'survived' | 'invalid' | 'not_applicable' | 'harness_error' | 'not_run';

export interface MutantRecord {
  slug: string;
  operator: OperatorId;
  group: 'mutation' | 'experiment';
  status: MutantStatus;
  /** The control's reached level, which is the level the monitor can see this target at. */
  level: number;
  change: string | null;
  expected: readonly FailureClass[] | null;
  outcome: RunResult['outcome'] | null;
  reachedLevel: number | null;
  failedStepId: string | null;
  failedStepKind: string | null;
  failureClass: FailureClass | null;
  ruleId: string | null;
  evidence: string | null;
  /** True/false when the operator has a fixed expectation and the mutant was detected; otherwise null. */
  classMatches: boolean | null;
  survivorReason: string | null;
  /** Why a mutant was not run (invalid, not applicable). */
  note: string | null;
  durationMs: number | null;
  exportsCheck: boolean;
  /** Set when the target declares that no vendor is involved (see ControlRecord.local). */
  local?: boolean;
  /** The mutant was run a second time because the first failure was the environment's or of an unexpected class. */
  retried?: boolean;
}

const blank = (
  slug: string,
  operator: OperatorId,
  level: number,
  exportsCheck: boolean,
): MutantRecord => ({
  slug,
  operator,
  group: OPERATOR_INFO[operator].group,
  status: 'not_applicable',
  level,
  change: null,
  expected: OPERATOR_INFO[operator].expected,
  outcome: null,
  reachedLevel: null,
  failedStepId: null,
  failedStepKind: null,
  failureClass: null,
  ruleId: null,
  evidence: null,
  classMatches: null,
  survivorReason: null,
  note: null,
  durationMs: null,
  exportsCheck,
});

export interface MutantJob {
  record: MutantRecord;
  /** Present when the mutant is ready to run. */
  run: { ir: StepIR } | null;
}

// ---- the request budget. A target whose run step makes a request to a VENDOR (a dummy key, auth-error-as-pass at level 3) is never run
// by `qsr mutate` unless the person asks (--allow-vendor-calls): a mutation suite sends dozens of runs, and a vendor is entitled to a
// bounded amount of traffic from us (at most the one request per cycle of the probe). Targets that only run locally are not affected.
export const VENDOR_CALLS_OFF =
  'vendor calls are off for this target (pass --allow-vendor-calls to run it)';
export const isVendorFacing = (t: Pick<Target, 'level' | 'expect'>): boolean =>
  t.expect.authErrorIsPass && t.level >= 3 && t.expect.localOnly !== true;

/** The control of a target that was not run because vendor calls are off: out of every statistic, with the reason. */
export function notRunControl(input: MutationInput): ControlRecord {
  return {
    slug: input.target.slug,
    included: false,
    excludedReason: VENDOR_CALLS_OFF,
    outcome: null,
    reachedLevel: null,
    targetLevel: input.target.level,
    retried: false,
    durationMs: null,
    resolved: {},
    hasRunStep: input.ir.steps.some((s) => s.kind === 'run'),
    writesSource: writesSource(input.ir),
    ...(input.target.expect.localOnly === true ? { local: true } : {}),
  };
}

/**
 * The record of a mutant that WOULD have run (it has a site and the real validator accepts it) but was not, because vendor calls are
 * off. A mutant with no site or an invalid one is recorded as it always is. `previous_major` needs a resolved version and is left out.
 */
export function notRunRecord(
  input: MutationInput,
  control: ControlRecord,
  operator: OperatorId,
  seed: string,
): MutantRecord | null {
  if (operator === 'previous_major') return null;
  const level = input.ir.maxLevelReachable;
  const job = prepareMutant(
    input,
    { ...control, included: true, reachedLevel: level },
    operator,
    seed,
    false,
  );
  return job.run === null
    ? job.record
    : { ...job.record, status: 'not_run', note: VENDOR_CALLS_OFF };
}

/** Builds (and validates) the mutant of one operator for one target. The real grounding validator decides `invalid`. */
export function prepareMutant(
  input: MutationInput,
  control: ControlRecord,
  operator: OperatorId,
  seed: string,
  exportsCheck: boolean,
): MutantJob {
  const level = control.reachedLevel ?? 0;
  const record: MutantRecord = {
    ...blank(input.target.slug, operator, level, exportsCheck),
    ...(input.target.expect.localOnly === true ? { local: true } : {}),
  };
  const pair: Pair = { extraction: input.extraction, ir: input.ir };

  if (operator === 'previous_major') {
    const site = firstInstall(input.ir);
    const major = site ? resolvedMajor(control.resolved, site.name) : null;
    const planned = major === null ? null : previousMajorPlan(input.ir, major);
    if (!planned)
      return {
        record: { ...record, note: 'no installed version above 0 to step back from' },
        run: null,
      };
    return { record: { ...record, change: planned.change }, run: { ir: planned.ir } };
  }

  const mutant: Mutant | null = applyOperator(
    operator,
    pair,
    createRng(seed, `${input.target.slug}:${operator}`),
    input.target.placeholders,
  );
  if (!mutant)
    return { record: { ...record, note: 'the plan has no site for this operator' }, run: null };
  const check = groundingReport(mutant.pair, input.target);
  if (!check.ok)
    return {
      record: {
        ...record,
        status: 'invalid',
        change: mutant.change,
        note: `the real grounding validator refused the mutated pair: ${check.violations
          .slice(0, 2)
          .map((v) => `${v.stepId} ${v.rule}`)
          .join(', ')}`,
      },
      run: null,
    };
  return { record: { ...record, change: mutant.change }, run: { ir: mutant.pair.ir } };
}

/** Runs one prepared mutant and judges it. */
export async function runMutantJob(
  runner: PlanRunner,
  input: MutationInput,
  control: ControlRecord,
  job: MutantJob,
  exportsCheck: boolean,
): Promise<MutantRecord> {
  if (!job.run) return job.record;
  const { record } = job;
  const args: RunnerArgs = { input, ir: job.run.ir, label: record.operator, exportsCheck };
  let out = await runner(args);
  let cls = classifyRun(args, out);
  // A failure of the environment (the registry or a download was unreachable) says nothing about the monitor, and a failure of a class the
  // operator does not expect is suspicious: both are run once more, and the second answer is the verdict. Found in the P9d v2 run, where a
  // DNS blip was counted as a detection of four mutants.
  const suspect = (): boolean =>
    out.result.outcome === 'FAIL' &&
    (cls.failureClass === 'NETWORK_TRANSIENT' ||
      (record.expected !== null &&
        !(cls.failureClass !== null && record.expected.includes(cls.failureClass))));
  let retried = false;
  if (suspect()) {
    retried = true;
    args.label = `${record.operator}-retry`;
    out = await runner(args);
    cls = classifyRun(args, out);
  }
  const r = out.result;
  const base: MutantRecord = {
    ...record,
    ...(retried ? { retried: true } : {}),
    outcome: r.outcome,
    reachedLevel: r.reachedLevel,
    failedStepId: r.failedStepId,
    failedStepKind: cls.failedStepKind,
    failureClass: cls.failureClass,
    ruleId: cls.ruleId,
    evidence: cls.evidence,
    durationMs: stepsMillis(r),
  };
  if (r.outcome === 'HARNESS_ERROR')
    return {
      ...base,
      status: 'harness_error',
      note: 'the harness itself failed; the mutant is left out of the rates',
    };
  if (r.outcome === 'FAIL' && cls.failureClass === 'NETWORK_TRANSIENT')
    return {
      ...base,
      status: 'harness_error',
      note: 'the network (registry or a download) failed twice: an environment failure is not a detection, so the mutant is left out of the rates',
    };
  if (r.outcome === 'FAIL') {
    const expected = record.expected;
    return {
      ...base,
      status: 'detected',
      classMatches:
        expected === null ? null : cls.failureClass !== null && expected.includes(cls.failureClass),
    };
  }
  return {
    ...base,
    status: 'survived',
    survivorReason: survivorReason({
      operator: record.operator,
      language: input.ir.language,
      controlLevel: control.reachedLevel ?? 0,
      runsSnippet: input.ir.steps.some((s) => s.kind === 'run'),
      writesSource: control.writesSource,
      exportsCheck,
    }),
  };
}

export interface MutationRun {
  controls: ControlRecord[];
  mutants: MutantRecord[];
}

export interface RunOptions {
  operators: readonly OperatorId[];
  seed: string;
  concurrency: number;
  exportsCheck: boolean;
  /** Only these (slug, operator) pairs: used to re-run the survivors of an earlier run. */
  only?: ReadonlySet<string>;
  /** Progress, one line per finished item. */
  onProgress?: (line: string) => void;
}

export const pairKey = (slug: string, operator: OperatorId): string => `${slug}:${operator}`;

/** Controls for every input, then the mutants of the targets whose control passed. Both phases use `concurrency` containers. */
export async function runMutation(
  runner: PlanRunner,
  inputs: readonly MutationInput[],
  opts: RunOptions,
): Promise<MutationRun> {
  const limit = createLimiter(opts.concurrency);
  const say = opts.onProgress ?? (() => undefined);
  const controls = await Promise.all(
    inputs.map((input) =>
      limit(input.target.slug, async () => {
        const c = await runControl(runner, input, opts.exportsCheck);
        say(
          `control ${c.slug}: ${c.included ? `PASS at L${c.reachedLevel}` : `EXCLUDED, ${c.excludedReason}`}`,
        );
        return c;
      }),
    ),
  );
  const mutants: MutantRecord[] = [];
  const jobs: Promise<void>[] = [];
  for (const [i, input] of inputs.entries()) {
    const control = controls[i] as ControlRecord;
    if (!control.included) continue;
    for (const operator of OPERATOR_IDS) {
      if (!opts.operators.includes(operator)) continue;
      if (opts.only && !opts.only.has(pairKey(input.target.slug, operator))) continue;
      const job = prepareMutant(input, control, operator, opts.seed, opts.exportsCheck);
      jobs.push(
        limit(input.target.slug, async () => {
          const rec = await runMutantJob(runner, input, control, job, opts.exportsCheck);
          mutants.push(rec);
          say(
            `${rec.slug} ${rec.operator}: ${rec.status}${rec.failureClass ? ` (${rec.failureClass}, ${rec.ruleId})` : ''}`,
          );
        }),
      );
    }
  }
  await Promise.all(jobs);
  mutants.sort((a, b) =>
    a.slug === b.slug
      ? OPERATOR_IDS.indexOf(a.operator) - OPERATOR_IDS.indexOf(b.operator)
      : a.slug < b.slug
        ? -1
        : 1,
  );
  return { controls, mutants };
}

/** Mutants that would be built and run, without running anything: counts for the estimate. */
export function planMutants(
  inputs: readonly MutationInput[],
  controls: ReadonlyMap<string, ControlRecord>,
  opts: Pick<RunOptions, 'operators' | 'seed' | 'exportsCheck'>,
): MutantRecord[] {
  const out: MutantRecord[] = [];
  for (const input of inputs) {
    const control = controls.get(input.target.slug);
    if (!control?.included) continue;
    for (const operator of OPERATOR_IDS)
      if (opts.operators.includes(operator))
        out.push(prepareMutant(input, control, operator, opts.seed, opts.exportsCheck).record);
  }
  return out;
}
