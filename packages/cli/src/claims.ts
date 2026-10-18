import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  l2Findings,
  l3ProductionSentence,
  LaunchExport,
  PIPELINE,
  PublicStatusSummary,
  StatsResponse,
  TARGET_GOAL,
  TRAFFIC,
  type DetectionSummary,
  type Logger,
  type Target,
} from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, type CliIo } from './commands.js';
import { buildSummaryFromRepo } from './detection-summary-command.js';
import { loadAllTargets } from './targets.js';

// `qsr claims [--check] [--no-admin] [--site <url>] [--root <dir>]`: writes docs/CLAIMS.md, every figure that could appear in a public post, one
// row each: the claim in plain words, the value, where it comes from, when the source was generated, whether it changes when a shadow target
// is promoted, and a safe and an unsafe way to say it. The rows are built from the sources the site uses: its public status counts, the
// committed measurement (docs/detection-power.json) and its summary, the target files, the pipeline constants and the admin API. Nothing in
// it is typed. A test fails if a number in the README or on /methodology is not in the sheet.

export const CLAIMS_FILE = path.join('docs', 'CLAIMS.md');
export const DEFAULT_SITE = 'https://quickstartrot.vercel.app';

// ---- the inputs

export interface Cell3 {
  detected: number;
  tested: number;
  targets: number;
}
export interface MeasurementFacts {
  generatedAt: string;
  harnessVersion: number;
  seed: string;
  /** Code-level mutants at level 2 under harness version 1, under the version measured, and with the experimental export check. */
  v1: Cell3;
  v2: Cell3;
  exportCheck: Cell3;
  mutants: {
    records: number;
    planted: number;
    experiment: number;
    operatorsPlanted: number;
    operatorsAll: number;
  };
}
export interface TargetFacts {
  enabled: number;
  disabled: number;
  shadow: string[];
  l3Production: string[];
  local: string[];
}
export interface OpsFacts {
  launchGeneratedAt: string;
  statsGeneratedAt: string;
  cycles: { valid: number; invalid: number; firstAt: string | null; lastAt: string | null };
  /** Final attempts of real tools that ran in valid cycles. */
  runs: number;
  harness: { runs: number; errors: number; days: number };
  db: { bytes: number; limitBytes: number };
  actions: { perCycle: number; perDay: number } | null;
}
export interface PipelineFacts {
  cycleHours: number;
  cyclesPerDay: number;
  failuresToOpenIncident: number;
  passesToRecover: number;
  transientStreakToOpenIncident: number;
  transientRetries: number;
  transientRetryDelaySeconds: number;
  crawlRetries: number;
  crawlRetryDelaySeconds: number;
  groundingRetries: number;
  recurrenceWindowDays: number;
  canaryCount: number;
  optOutHours: number;
  vendorReplyBusinessDays: number;
  disclosureWaitHours: number;
  dataCacheMinutes: number;
  badgeCacheMinutes: number;
  targetTotal: number;
  librariesPercent: number;
  vendorsPercent: number;
  vendorRequestsPerCycle: number;
  vendorRequestsPerDay: number;
  termsReviewedOn: string;
}
export interface ClaimsInputs {
  generatedAt: string;
  site: string;
  status: PublicStatusSummary;
  detection: DetectionSummary;
  measurement: MeasurementFacts;
  targets: TargetFacts;
  pipeline: PipelineFacts;
  /** Null when there was no admin access: the rows say so instead of showing a number. */
  ops: OpsFacts | null;
}

export interface Claim {
  id: string;
  section: string;
  claim: string;
  value: string;
  source: string;
  generated: string;
  changesOnPromotion: string | null;
  safe: string;
  unsafe: string;
}

// ---- reading the sources

const Count = z.number().int().min(0);
const RawCell = z.object({ detected: Count, tested: Count, targets: Count });
const RawMeasurement = z.object({
  generatedAt: z.string().min(1),
  method: z.object({
    harnessVersion: z.number().int().optional(),
    seed: z.string(),
    operators: z.array(z.string()),
  }),
  mutants: z.array(z.object({ group: z.string(), status: z.string(), operator: z.string() })),
  summary: z.object({ byKind: z.object({ code: z.object({ L2: RawCell }) }) }),
  harnessComparison: z.object({ before: z.object({ code: z.object({ L2: RawCell }) }) }).nullable(),
  comparison: z.object({ byKindAfter: z.object({ code: z.object({ L2: RawCell }) }) }).nullable(),
});

/** The figures of the measurement that the summary does not carry: the three code-level level 2 results and the mutant counts. */
export function extractMeasurement(raw: unknown): MeasurementFacts {
  const r = RawMeasurement.parse(raw);
  if (r.harnessComparison === null || r.comparison === null)
    throw new Error(
      'docs/detection-power.json has no harness comparison or export-check comparison: run `qsr mutate --render` with --v1 and --compare',
    );
  const cell = (c: z.infer<typeof RawCell>): Cell3 => ({
    detected: c.detected,
    tested: c.tested,
    targets: c.targets,
  });
  const planted = r.mutants.filter((m) => m.group === 'mutation');
  return {
    generatedAt: r.generatedAt,
    harnessVersion: r.method.harnessVersion ?? 1,
    seed: r.method.seed,
    v1: cell(r.harnessComparison.before.code.L2),
    v2: cell(r.summary.byKind.code.L2),
    exportCheck: cell(r.comparison.byKindAfter.code.L2),
    mutants: {
      records: r.mutants.length,
      planted: planted.length,
      experiment: r.mutants.length - planted.length,
      operatorsPlanted: new Set(planted.map((m) => m.operator)).size,
      operatorsAll: r.method.operators.length,
    },
  };
}

/** The target counts, from the target files (canaries are not in the list). */
export function extractTargetFacts(targets: readonly Target[]): TargetFacts {
  const enabled = targets.filter((t) => t.enabled !== false);
  return {
    enabled: enabled.length,
    disabled: targets.length - enabled.length,
    shadow: enabled
      .filter((t) => t.l3?.mode === 'shadow')
      .map((t) => t.slug)
      .sort(),
    l3Production: enabled
      .filter((t) => t.level >= 3 && t.l3?.mode !== 'shadow')
      .map((t) => t.slug)
      .sort(),
    local: enabled
      .filter((t) => t.expect.localOnly === true)
      .map((t) => t.slug)
      .sort(),
  };
}

/** The pipeline constants the pages quote. The two cache times live in the web app (it cannot be imported here), so the caller reads them. */
export function pipelineFacts(cache: {
  dataCacheMinutes: number;
  badgeCacheMinutes: number;
}): PipelineFacts {
  return {
    cycleHours: PIPELINE.cycleHours,
    cyclesPerDay: PIPELINE.cyclesPerDay,
    failuresToOpenIncident: PIPELINE.failuresToOpenIncident,
    passesToRecover: PIPELINE.passesToRecover,
    transientStreakToOpenIncident: PIPELINE.transientStreakToOpenIncident,
    transientRetries: PIPELINE.transientRetries,
    transientRetryDelaySeconds: PIPELINE.transientRetryDelaySeconds,
    crawlRetries: PIPELINE.crawlRetries,
    crawlRetryDelaySeconds: PIPELINE.crawlRetryDelaySeconds,
    groundingRetries: PIPELINE.groundingRetries,
    recurrenceWindowDays: PIPELINE.recurrenceWindowDays,
    canaryCount: PIPELINE.canaryCount,
    optOutHours: PIPELINE.optOutHours,
    vendorReplyBusinessDays: PIPELINE.vendorReplyBusinessDays,
    disclosureWaitHours: PIPELINE.disclosureWaitHours,
    dataCacheMinutes: cache.dataCacheMinutes,
    badgeCacheMinutes: cache.badgeCacheMinutes,
    targetTotal: TARGET_GOAL.total,
    librariesPercent: TARGET_GOAL.librariesPercent,
    vendorsPercent: TARGET_GOAL.vendorsPercent,
    vendorRequestsPerCycle: TRAFFIC.requestsPerTargetPerCycle,
    vendorRequestsPerDay: TRAFFIC.requestsPerTargetPerDay,
    termsReviewedOn: TRAFFIC.termsReviewedOn,
  };
}

/** The minutes the web app caches data and badges for, from the two files that hold them. */
export async function readCacheMinutes(
  root: string,
): Promise<{ dataCacheMinutes: number; badgeCacheMinutes: number }> {
  const constants = await readFile(
    path.join(root, 'apps', 'web', 'src', 'lib', 'cache-constants.ts'),
    'utf8',
  );
  const badge = await readFile(path.join(root, 'apps', 'web', 'src', 'lib', 'badge.ts'), 'utf8');
  const data = /REVALIDATE_SECONDS\s*=\s*(\d+)/.exec(constants)?.[1];
  const badgeAge = /BADGE_CACHE_CONTROL\s*=\s*'[^']*s-maxage=(\d+)/.exec(badge)?.[1];
  if (data === undefined || badgeAge === undefined)
    throw new Error(
      'cannot read the cache times from apps/web/src/lib/cache-constants.ts and badge.ts',
    );
  return { dataCacheMinutes: Number(data) / 60, badgeCacheMinutes: Number(badgeAge) / 60 };
}

/** The billed Actions minutes of `node scripts/scale-estimate.mjs`: "**71 min per cycle**, **284 per day**". */
export function parseActionsEstimate(stdout: string): { perCycle: number; perDay: number } | null {
  const m = /Billed Actions minutes:\s*\*\*(\d+) min per cycle\*\*,\s*\*\*(\d+) per day\*\*/.exec(
    stdout,
  );
  return m ? { perCycle: Number(m[1]), perDay: Number(m[2]) } : null;
}

export function opsFromAdmin(
  launch: LaunchExport,
  stats: StatsResponse,
  actions: OpsFacts['actions'],
): OpsFacts {
  return {
    launchGeneratedAt: launch.generatedAt,
    statsGeneratedAt: stats.generatedAt,
    cycles: {
      valid: launch.cycles.valid,
      invalid: launch.cycles.invalid,
      firstAt: launch.cycles.firstAt,
      lastAt: launch.cycles.lastAt,
    },
    runs: launch.runs.total,
    harness: {
      runs: stats.harness.overall.runs,
      errors: stats.harness.overall.errors,
      days: stats.days,
    },
    db: { bytes: stats.storage.database.bytes, limitBytes: stats.storage.database.limitBytes },
    actions,
  };
}

// ---- the rows

const ts = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const day = (iso: string): string => iso.slice(0, 10);
const frac = (c: { detected: number; tested: number }): string => `${c.detected} of ${c.tested}`;
const pct = (c: { detected: number; tested: number }): string =>
  c.tested === 0 ? 'n/a' : `${Math.round((100 * c.detected) / c.tested)}%`;
const names = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));
const noun = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
const PROMOTION_STATUS = 'Yes: a promoted shadow target moves from L2 to L3';
const PROMOTION_MEASURED = 'Yes, after the next measurement: a promoted target is measured at L3';
const NO = null;
/** What was left out of a count and why, in the words /methodology uses: nothing here is in any rate. */
const leftOut = (c: {
  noSite: number;
  invalid: number;
  harnessError: number;
  notRun: number;
}): string => {
  const parts = [
    c.noSite > 0 ? `${c.noSite} with no site to change` : null,
    c.invalid > 0 ? `${c.invalid} refused by the grounding check` : null,
    c.harnessError > 0
      ? `${c.harnessError} harness ${c.harnessError === 1 ? 'error' : 'errors'}`
      : null,
    c.notRun > 0 ? `${c.notRun} not run (no vendor requests)` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? '' : `; left out of the count: ${parts.join(', ')}`;
};

export const SECTIONS: readonly { key: string; title: string; note: string }[] = [
  {
    key: 'status',
    title: 'What passes right now',
    note: "From the site's public status counts, the numbers behind the home headline.",
  },
  { key: 'targets', title: 'The targets', note: 'From the target files.' },
  {
    key: 'measure',
    title: 'How the monitor was measured',
    note: 'From docs/detection-power.json.',
  },
  {
    key: 'install',
    title: 'Install-level detection',
    note: 'Broken install commands. Mostly the package manager at work; never added to code-level results.',
  },
  {
    key: 'code',
    title: 'Code-level detection',
    note: 'Broken code planted in the docs snippet, by level and harness version.',
  },
  {
    key: 'l3',
    title: 'Level 3',
    note: 'Counts only, with the caveat: no L3 detection rate is quoted anywhere.',
  },
  {
    key: 'mutants',
    title: 'Mutants and operators',
    note: 'How many breakages were planted, and of what kinds.',
  },
  {
    key: 'ops',
    title: 'How it is running',
    note: 'From the admin API and the scale estimate; "not generated" when the sheet was made without admin access.',
  },
  {
    key: 'pipeline',
    title: 'How it works',
    note: 'Constants in the code, quoted by the README and /methodology.',
  },
];

export function buildClaims(i: ClaimsInputs): Claim[] {
  const out: Claim[] = [];
  const add = (c: Omit<Claim, 'section'>): void =>
    void out.push({ ...c, section: c.id.split('.')[0] ?? '' });
  const h = i.status.headline;
  const statusDate = ts(i.status.asOf ?? i.generatedAt);
  const statusSource = `GET ${i.site}/api/status (the home page headline; pnpm qsr readme)`;
  const asOf = `as of ${day(i.status.asOf ?? i.generatedAt)}`;
  // "most" only when more than half of the tested quickstarts stop at L2
  const mostAtL2 = h.testedAtL2 * 2 > h.tested;
  const d = i.detection;
  const m = i.measurement;
  const mDate = ts(m.generatedAt);
  const mSource = 'docs/detection-power.json (pnpm qsr mutate --render)';
  const tDate = ts(i.generatedAt);

  // ---- status
  add({
    id: 'status.tested',
    claim: 'Quickstarts with a verdict: passing, being verified or confirmed failing',
    value: `${h.tested}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.tested} quickstarts have a verdict ${asOf}; ${mostAtL2 ? 'most are tested only as far as L2' : 'they are tested to different depths, shown by level'}.`,
    unsafe: `All ${h.tested} quickstarts are tested to the same depth.`,
  });
  add({
    id: 'status.passing',
    claim: 'Quickstarts whose latest check passed',
    value: `${h.passing} of ${h.tested}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.passing} of ${h.tested} tracked quickstarts passed their latest check ${asOf}, each at the level shown.`,
    unsafe: `${h.passing} of ${h.tested} quickstarts work, with no date and no word about the level each was tested to${mostAtL2 ? ' (most only as far as L2)' : ''}.`,
  });
  add({
    id: 'status.verifying',
    claim:
      'Quickstarts being verified: a failure a person has not confirmed yet, shown with no cause',
    value: `${h.verifying}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.verifying} ${noun(h.verifying, 'quickstart is', 'quickstarts are')} being verified (a failure not yet confirmed by a person).`,
    unsafe: `Calling a quickstart that is being verified broken or failing.`,
  });
  add({
    id: 'status.failing',
    claim: 'Quickstarts confirmed failing: a person reviewed the failure',
    value: `${h.failing}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.failing} ${noun(h.failing, 'quickstart is', 'quickstarts are')} confirmed failing ${asOf}.`,
    unsafe: `${h.failing} quickstarts are broken, counting failures no person has confirmed.`,
  });
  add({
    id: 'status.needsPerson',
    claim:
      'Quickstarts that stop at a step only a person can do (a sign-up or an interactive step); not counted in the headline',
    value: `${h.needsPerson}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.needsPerson} ${noun(h.needsPerson, 'quickstart needs', 'quickstarts need')} a person (a sign-up or an interactive step) and is not counted.`,
    unsafe: `${h.needsPerson} quickstarts failed.`,
  });
  add({
    id: 'status.notTested',
    claim: 'Quickstarts not tested yet',
    value: `${h.notTested}`,
    source: statusSource,
    generated: statusDate,
    changesOnPromotion: NO,
    safe: `${h.notTested} ${noun(h.notTested, 'quickstart has', 'quickstarts have')} not been tested yet.`,
    unsafe: `${h.notTested} quickstarts passed.`,
  });
  const tier = (level: 'L3' | 'L2' | 'L1', tested: number, passing: number, what: string): void => {
    const changes = level === 'L1' ? NO : `${PROMOTION_STATUS} (more at L3, fewer at L2)`;
    add({
      id: `status.testedAt${level}`,
      claim: `Quickstarts tested up to ${level}: ${what}`,
      value: `${tested}`,
      source: statusSource,
      generated: statusDate,
      changesOnPromotion: changes,
      safe: `${tested} ${noun(tested, 'quickstart is', 'quickstarts are')} tested up to ${level} (${what}).`,
      unsafe: `${tested} quickstarts are verified working, whatever their level.`,
    });
    add({
      id: `status.passingAt${level}`,
      claim: `Passing among the quickstarts tested up to ${level}`,
      value: `${passing} of ${tested}`,
      source: statusSource,
      generated: statusDate,
      changesOnPromotion: changes,
      safe: `${passing} of ${tested} quickstarts tested up to ${level} passed their latest check ${asOf}.`,
      unsafe: `Saying "${h.passing} pass at ${level}", which counts the passes of the other levels too.`,
    });
  };
  tier(
    'L3',
    h.testedAtL3,
    h.passingAtL3,
    "the snippet ran and reached the vendor's API with a made-up key",
  );
  tier(
    'L2',
    h.testedAtL2,
    h.passingAtL2,
    'installs, builds, imports resolve; not run against the vendor',
  );
  tier('L1', h.testedAtL1, h.passingAtL1, 'only the install commands ran');

  // ---- targets
  const tSource = 'targets/*.yaml (pnpm qsr detection-summary)';
  add({
    id: 'targets.enabled',
    claim: 'Targets switched on (the canaries are not counted)',
    value: `${i.targets.enabled}`,
    source: tSource,
    generated: tDate,
    changesOnPromotion: NO,
    safe: `${i.targets.enabled} quickstarts are tracked.`,
    unsafe: `${i.targets.enabled} quickstarts are tested, when some need a person and are not counted in the headline.`,
  });
  add({
    id: 'targets.disabled',
    claim: 'Targets in the repository that are switched off, with a reason',
    value: `${i.targets.disabled}`,
    source: tSource,
    generated: tDate,
    changesOnPromotion: NO,
    safe: `${i.targets.disabled} drafted targets are switched off, each with a recorded reason (docs/TARGET-SELECTION.md).`,
    unsafe: `${i.targets.disabled} quickstarts were dropped because they passed.`,
  });
  add({
    id: 'targets.shadow',
    claim: 'Quickstarts whose L3 step runs as a trial (shadow): recorded, not counted, shown at L2',
    value: `${i.targets.shadow.length} (${names(i.targets.shadow)})`,
    source: tSource,
    generated: tDate,
    changesOnPromotion: 'Yes: this is the number that falls when a target is promoted',
    safe: `${i.targets.shadow.length} more ${noun(i.targets.shadow.length, 'quickstart runs its', 'quickstarts run their')} L3 step as a trial; the result is recorded and not counted.`,
    unsafe: `${i.targets.shadow.length} more quickstarts reach L3.`,
  });
  add({
    id: 'targets.l3Production',
    claim: 'Quickstarts that reach L3 in production',
    value: `${i.targets.l3Production.length} (${names(i.targets.l3Production)})`,
    source: tSource,
    generated: tDate,
    changesOnPromotion: 'Yes: this is the number that rises when a target is promoted',
    safe: `${i.targets.l3Production.length} quickstarts reach L3 in production (${names(i.targets.l3Production)}), with a made-up key.`,
    unsafe: `${i.targets.l3Production.length} quickstarts are tested against the vendor's API with real keys.`,
  });
  add({
    id: 'targets.local',
    claim: 'Libraries with no vendor, executed locally: their own category, never an L3 result',
    value: `${i.targets.local.length} (${names(i.targets.local)})`,
    source: tSource,
    generated: tDate,
    changesOnPromotion: NO,
    safe: `${i.targets.local.length} quickstarts are libraries with no service behind them; their snippet runs on our machine.`,
    unsafe: `${i.targets.local.length} more quickstarts are tested at L3.`,
  });

  // ---- measure
  add({
    id: 'measure.date',
    claim: 'When the monitor was measured, and under which harness version',
    value: `${mDate}, harness version ${m.harnessVersion}, seed ${m.seed}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `Measured on ${day(m.generatedAt)} under harness version ${m.harnessVersion}, one run on one machine.`,
    unsafe: `The monitor's detection power is measured continuously.`,
  });
  add({
    id: 'measure.targets',
    claim: 'Targets in the figures: those whose unmutated run passed twice',
    value: `${d.targetsMeasured} of ${d.targetsConsidered}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `${d.targetsMeasured} of ${d.targetsConsidered} targets had a control that passed twice and are in the figures.`,
    unsafe: `We measured all ${d.targetsConsidered} quickstarts.`,
  });

  // ---- install
  const installNote = (level: 'L1' | 'L2' | 'L3' | 'local'): string =>
    level === 'L3' ? 'counts only; no rate quoted' : pct(d.install[level]);
  const levelName = {
    L1: 'L1',
    L2: 'L2',
    L3: 'L3',
    local: 'executed locally (no vendor)',
  } as const;
  for (const level of ['L1', 'L2', 'L3', 'local'] as const) {
    const c = d.install[level];
    add({
      id: `install.${level}`,
      claim: `Install-level mutants, ${levelName[level]}: a package name with letters added, or a version that does not exist`,
      value: `${frac(c)} over ${c.targets} targets (${installNote(level)})${leftOut(c)}`,
      source: mSource,
      generated: mDate,
      changesOnPromotion: level === 'L1' || level === 'local' ? NO : PROMOTION_MEASURED,
      safe:
        level === 'L3'
          ? `Planting a broken install command in the ${c.targets} quickstarts L3 rests on, the monitor noticed ${frac(c)}; that is too few to quote a rate.`
          : `Planting a broken install command in ${c.targets} ${levelName[level]} quickstarts, the monitor noticed ${frac(c)}. npm and pip do most of that work.`,
      unsafe: `The monitor catches ${level === 'L3' ? '100' : pct(c).replace('%', '')}% of broken quickstarts.`,
    });
  }
  const iSum = (k: 'detected' | 'tested'): number =>
    (['L1', 'L2', 'L3', 'local'] as const).reduce((n, l) => n + d.install[l][k], 0);
  add({
    id: 'install.all',
    claim:
      'Install-level mutants over all levels (install-level only: never added to code-level results)',
    value: `${iSum('detected')} of ${iSum('tested')}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `Planting broken install commands, the monitor noticed ${iSum('detected')} of ${iSum('tested')}; that is largely the package manager's doing and says nothing about the code.`,
    unsafe: `We caught ${iSum('detected')} of ${iSum('tested')} broken quickstarts.`,
  });

  // ---- code
  const c1 = d.code.L1;
  add({
    id: 'code.L1',
    claim:
      'Code-level mutants at L1: the page showed no code to build, so there was nothing to plant',
    value: `${c1.tested} tested${leftOut(c1)}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: NO,
    safe: `At L1 there is no code to check: ${c1.tested} code-level breakages were planted.`,
    unsafe: `L1 checks the code.`,
  });
  const lvl = (
    what: string,
    c: Cell3,
    id: string,
    note: string,
    safe: string,
    unsafe: string,
    changes: string | null,
  ): void =>
    add({
      id,
      claim: what,
      value: `${frac(c)} (${pct(c)}) over ${c.targets} targets${note}`,
      source: mSource,
      generated: mDate,
      changesOnPromotion: changes,
      safe,
      unsafe,
    });
  lvl(
    'Code-level mutants at L2 under harness version 1, before the fixes of version 2',
    m.v1,
    'code.L2.v1',
    '',
    `Under the first harness version, L2 noticed ${frac(m.v1)} planted code breakages in ${m.v1.targets} quickstarts.`,
    `L2 detects ${pct(m.v1)} of code bugs.`,
    PROMOTION_MEASURED,
  );
  lvl(
    `Code-level mutants at L2 under harness version ${m.harnessVersion}, the version measured`,
    m.v2,
    'code.L2.v2',
    leftOut(d.code.L2),
    `At L2 the monitor noticed ${frac(m.v2)} planted code breakages in ${m.v2.targets} quickstarts.`,
    `The monitor detects ${pct(m.v2)} of the bugs in a quickstart.`,
    PROMOTION_MEASURED,
  );
  lvl(
    'Code-level mutants at L2 with the export check (EXPERIMENT)',
    m.exportCheck,
    'code.L2.exportCheck',
    ' - experiment, not in production: the check runs in shadow mode and changes no result',
    `An experiment, not in production: a check that every named import exists would notice ${frac(m.exportCheck)} at L2. It runs in shadow mode only and changes no result, level, status or badge.`,
    `With the export check we catch ${pct(m.exportCheck)} of code bugs (it is not in production).`,
    PROMOTION_MEASURED,
  );
  const f = l2Findings(d);
  const op = (k: string): string =>
    `${d.codeL2ByOperator[k]?.detected ?? 0} of ${d.codeL2ByOperator[k]?.tested ?? 0}`;
  add({
    id: 'code.L2.runtimeNames',
    claim:
      'Planted renamed imports, renamed methods and misnamed options that L2 noticed (names that only exist at run time)',
    value: `${f.runtimeDetected} of ${f.runtimeTested} (renamed imports ${op('renamed_symbol')}, renamed methods ${op('renamed_method')}, misnamed options ${op('option_misnamed')})`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `L2 noticed ${f.runtimeDetected} of the ${f.runtimeTested} renamed names, renamed methods or misnamed options planted, because those only exist at run time.`,
    unsafe: `An L2 pass means the code works.`,
  });
  const sx = d.codeL2ByOperator['syntax_error'];
  const dp = d.codeL2ByOperator['deep_import'];
  add({
    id: 'code.L2.syntaxAndImports',
    claim: 'Planted syntax errors and import paths that do not exist that L2 noticed',
    value: `${(sx?.detected ?? 0) + (dp?.detected ?? 0)} of ${(sx?.tested ?? 0) + (dp?.tested ?? 0)} (syntax errors ${op('syntax_error')}, import paths that do not exist ${op('deep_import')})`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `L2 noticed ${(sx?.detected ?? 0) + (dp?.detected ?? 0)} of ${(sx?.tested ?? 0) + (dp?.tested ?? 0)} planted syntax errors and import paths that do not exist.`,
    unsafe: `L2 catches broken code.`,
  });
  const loc = d.code.local;
  lvl(
    'Code-level mutants, executed locally (libraries with no vendor)',
    loc,
    'code.local',
    leftOut(loc),
    `Libraries whose snippet runs on our machine: ${frac(loc)} planted code breakages noticed in ${loc.targets} quickstarts. It is not an L3 result.`,
    `${frac(loc)} counts as L3 detection.`,
    NO,
  );
  const c3 = d.code.L3;
  add({
    id: 'code.L3',
    claim:
      "Code-level mutants at L3, the snippet reaching the vendor's API (counts only; no rate quoted)",
    value: `${frac(c3)} over ${c3.targets} targets (counts only; no rate quoted)${leftOut(c3)}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `Planting broken code in the ${c3.targets} quickstarts L3 rests on, the monitor noticed ${frac(c3)}; that is too few to quote a rate.`,
    unsafe: `L3 catches ${Math.round((100 * c3.detected) / Math.max(1, c3.tested))}% of code bugs.`,
  });

  // ---- l3
  add({
    id: 'l3.restsOn',
    claim: 'Quickstarts the L3 detection results rest on',
    value: `${d.l3Targets.length} (${names(d.l3Targets)})`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `L3 rests on ${d.l3Targets.length} quickstarts so far and we quote no rate for it.`,
    unsafe: `Our L3 detection rate is higher than L2's.`,
  });
  const sentence = l3ProductionSentence(d);
  add({
    id: 'l3.production',
    claim: 'Quickstarts that reach L3 in production, and how many of them the measurement covers',
    value: sentence,
    source: `${tSource} and ${mSource}`,
    generated: mDate,
    changesOnPromotion: 'Yes: both numbers can change',
    safe: sentence,
    unsafe: `The detection measurement covers every quickstart that reaches L3.`,
  });

  // ---- mutants
  const mu = m.mutants;
  const verdict = (kind: 'install' | 'code'): number =>
    (['L1', 'L2', 'L3', 'local'] as const).reduce((n, l) => n + d[kind][l].tested, 0);
  const verdictInstall = verdict('install');
  const verdictCode = verdict('code');
  add({
    id: 'mutants.records',
    claim: 'Mutant records in the results file: the planted breakages and the experiment',
    value: `${mu.records}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: NO,
    safe: `The results file holds ${mu.records} records: ${mu.planted} planted breakages and ${mu.experiment} of an experiment.`,
    unsafe: `We tested ${mu.records} quickstarts.`,
  });
  add({
    id: 'mutants.planted',
    claim: 'Planted breakages (mutants), and how many of each kind ran and gave a verdict',
    value: `${mu.planted} planted; ${verdictInstall} install-level and ${verdictCode} code-level gave a verdict`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `${mu.planted} breakages were planted; ${verdictInstall} install-level and ${verdictCode} code-level ran and gave a verdict, reported apart.`,
    unsafe: `One detection figure for all the planted breakages, install-level and code-level together.`,
  });
  add({
    id: 'mutants.operators',
    claim:
      'Operators: the kinds of planted breakage, and the one experiment that is not a measure of detection',
    value: `${mu.operatorsPlanted} planted kinds, plus ${mu.operatorsAll - mu.operatorsPlanted} experiment (previous_major)`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: NO,
    safe: `${mu.operatorsPlanted} kinds of breakage were planted (a typo in a package name, a version that does not exist, a renamed import, a renamed method, a path that does not exist, a missing bracket, a misnamed option).`,
    unsafe: `We tested every way a quickstart can break.`,
  });
  const noSite = (['L1', 'L2', 'L3', 'local'] as const).reduce(
    (n, l) => n + d.install[l].noSite + d.code[l].noSite,
    0,
  );
  const noSiteCode = (['L1', 'L2', 'L3', 'local'] as const).reduce(
    (n, l) => n + d.code[l].noSite,
    0,
  );
  add({
    id: 'mutants.noSite',
    claim: 'Planted breakages with nothing to change in the plan (no site): in no rate',
    value: `${noSite} (${noSiteCode} code-level, ${noSite - noSiteCode} install-level)`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: PROMOTION_MEASURED,
    safe: `${noSite} planted breakages had nothing to change and are in no rate.`,
    unsafe: `Counting the ${noSite} breakages that had nothing to change as missed.`,
  });
  add({
    id: 'mutants.experiment',
    claim: 'Records of the experiment previous_major: not a measure of detection',
    value: `${mu.experiment}`,
    source: mSource,
    generated: mDate,
    changesOnPromotion: NO,
    safe: `${mu.experiment} further records come from an experiment that is not a measure of detection.`,
    unsafe: `Counting the experiment among the breakages the monitor missed.`,
  });

  // ---- ops
  const noOps = (id: string, claim: string, source: string): void =>
    add({
      id,
      claim,
      value: 'not generated: the sheet was made without admin access (0 figures)',
      source,
      generated: tDate,
      changesOnPromotion: NO,
      safe: 'Do not quote this figure: regenerate the sheet with admin access first (0 is not the answer).',
      unsafe: 'Quoting a figure from an earlier sheet.',
    });
  if (i.ops === null) {
    noOps('ops.cycles', 'Probe cycles to date', 'GET /admin/export/launch');
    noOps('ops.runs', 'Runs to date', 'GET /admin/export/launch');
    noOps(
      'ops.harnessErrorRate',
      'Harness error rate: runs that ended in an error of ours',
      'GET /admin/stats',
    );
    noOps(
      'ops.actionsMinutesPerDay',
      'Billed GitHub Actions minutes a day (an estimate)',
      'node scripts/scale-estimate.mjs',
    );
    noOps('ops.dbSize', 'Database size', 'GET /admin/stats');
  } else {
    const o = i.ops;
    const lDate = ts(o.launchGeneratedAt);
    const sDate = ts(o.statsGeneratedAt);
    const span =
      o.cycles.firstAt && o.cycles.lastAt
        ? `, from ${day(o.cycles.firstAt)} to ${day(o.cycles.lastAt)}`
        : '';
    add({
      id: 'ops.cycles',
      claim:
        'Probe cycles to date: valid ones count, invalid ones (a canary misbehaved) are ignored',
      value: `${o.cycles.valid} valid and ${o.cycles.invalid} invalid${span}`,
      source: 'GET /admin/export/launch (pnpm qsr export --launch)',
      generated: lDate,
      changesOnPromotion: NO,
      safe: `${o.cycles.valid} valid test cycles${span}; ${o.cycles.invalid} were invalid and ignored.`,
      unsafe: `Tested continuously, counting the ${o.cycles.invalid} invalid cycles.`,
    });
    add({
      id: 'ops.runs',
      claim: 'Runs to date: final attempts of real quickstarts that ran in valid cycles',
      value: `${o.runs}`,
      source: 'GET /admin/export/launch (pnpm qsr export --launch)',
      generated: lDate,
      changesOnPromotion: NO,
      safe: `${o.runs} runs of real quickstarts in valid cycles.`,
      unsafe: `${o.runs} different quickstarts tested.`,
    });
    const rate = o.harness.runs === 0 ? 0 : (100 * o.harness.errors) / o.harness.runs;
    add({
      id: 'ops.harnessErrorRate',
      claim: 'Harness error rate: runs that ended in an error of ours, not a verdict on a vendor',
      value: `${o.harness.errors} of ${o.harness.runs} runs (${rate.toFixed(1)}%), over the last ${o.harness.days} days`,
      source: `GET /admin/stats?days=${o.harness.days}`,
      generated: sDate,
      changesOnPromotion: NO,
      safe: `${o.harness.errors} of ${o.harness.runs} runs ended in an error of ours (a harness error), not a verdict on any vendor.`,
      unsafe: `${rate.toFixed(1)}% of quickstarts fail.`,
    });
    if (o.actions === null)
      noOps(
        'ops.actionsMinutesPerDay',
        'Billed GitHub Actions minutes a day (an estimate)',
        'node scripts/scale-estimate.mjs',
      );
    else
      add({
        id: 'ops.actionsMinutesPerDay',
        claim: 'Billed GitHub Actions minutes a day: an estimate, not a measurement',
        value: `about ${o.actions.perDay} minutes a day (${o.actions.perCycle} per cycle), an estimate`,
        source: 'node scripts/scale-estimate.mjs (docs/NOTES.md)',
        generated: tDate,
        changesOnPromotion: NO,
        safe: `About ${o.actions.perDay} Actions minutes a day, an estimate; hosted runners are free on a public repository.`,
        unsafe: `We spend ${o.actions.perDay} paid minutes a day.`,
      });
    const percent = (100 * o.db.bytes) / o.db.limitBytes;
    add({
      id: 'ops.dbSize',
      claim: "Database size, against the free tier's limit",
      value: `${megabytes(o.db.bytes)} MB of ${megabytes(o.db.limitBytes)} MB (${percent.toFixed(1)}%)`,
      source: `GET /admin/stats?days=${o.harness.days}`,
      generated: sDate,
      changesOnPromotion: NO,
      safe: `The database is ${megabytes(o.db.bytes)} MB, ${percent.toFixed(1)}% of the free tier's ${megabytes(o.db.limitBytes)} MB, ${asOf.replace(/as of \S+/, `as of ${day(o.statsGeneratedAt)}`)}.`,
      unsafe: `The database will stay this size.`,
    });
  }

  // ---- pipeline
  const p = i.pipeline;
  const pSource = 'packages/core/src/pipeline-facts.ts';
  const constant = (
    key: string,
    claim: string,
    value: string,
    safe: string,
    unsafe: string,
    source = pSource,
  ): void =>
    add({
      id: `pipeline.${key}`,
      claim,
      value,
      source,
      generated: tDate,
      changesOnPromotion: NO,
      safe,
      unsafe,
    });
  constant(
    'cycleHours',
    'How often every quickstart is run',
    `every ${p.cycleHours} hours`,
    `Every quickstart is run every ${p.cycleHours} hours (scheduled; GitHub can start a run late).`,
    'Monitored in real time.',
    'packages/core/src/pipeline-facts.ts and .github/workflows/probe.yml (cron)',
  );
  constant(
    'cyclesPerDay',
    'Cycles a day',
    `${p.cyclesPerDay}`,
    `${p.cyclesPerDay} test cycles a day.`,
    `${p.cyclesPerDay} tests a day of each quickstart, retries included.`,
  );
  constant(
    'failuresToOpenIncident',
    'Matching failures in a row, in valid cycles, before an incident is opened',
    `${p.failuresToOpenIncident}`,
    `A failure becomes an incident only after ${p.failuresToOpenIncident} matching failures in a row in valid cycles, and nothing is public until a person has reviewed it.`,
    'One failed run is called a break.',
  );
  constant(
    'passesToRecover',
    'Consecutive passes before a quickstart is healthy again',
    `${p.passesToRecover}`,
    `A confirmed incident resolves after ${p.passesToRecover} consecutive passes in valid cycles.`,
    'A failure is cleared by a single pass.',
  );
  constant(
    'transientStreakToOpenIncident',
    'Network errors or timeouts in a row that open an internal incident, never published as a vendor failure',
    `${p.transientStreakToOpenIncident}`,
    `${p.transientStreakToOpenIncident} network errors or timeouts in a row open an internal incident, which is never published as a vendor's failure.`,
    "Network failures are reported as the vendor's.",
  );
  constant(
    'transientRetries',
    'Retries of a network error or timeout inside a cycle',
    `${p.transientRetries}`,
    `A network error or timeout is retried ${p.transientRetries} time inside the cycle and only the last attempt counts.`,
    'A flaky network marks a quickstart broken.',
  );
  constant(
    'transientRetryDelaySeconds',
    'Seconds before that retry',
    `${p.transientRetryDelaySeconds} seconds`,
    `The retry comes ${p.transientRetryDelaySeconds} seconds later.`,
    'Retried at once.',
  );
  constant(
    'crawlRetries',
    'Retries of a docs page that cannot be reached',
    `${p.crawlRetries}`,
    `A docs page that cannot be reached is retried ${p.crawlRetries} time.`,
    'We crawl each page repeatedly.',
  );
  constant(
    'crawlRetryDelaySeconds',
    'Seconds before that crawl retry',
    `${p.crawlRetryDelaySeconds} seconds`,
    `The crawl retry comes ${p.crawlRetryDelaySeconds} seconds later.`,
    'Retried at once.',
  );
  constant(
    'groundingRetries',
    'Retries of a plan that fails the grounding check',
    `${p.groundingRetries}`,
    `A plan that fails the grounding check is retried ${p.groundingRetries} time with the violations listed, then discarded; the model never writes code.`,
    'The model writes the code that runs.',
  );
  constant(
    'recurrenceWindowDays',
    'Days within which a failure with the signature of a resolved incident reopens it',
    `${p.recurrenceWindowDays} days`,
    `A failure with the signature of an incident resolved in the last ${p.recurrenceWindowDays} days reopens it.`,
    'Every old incident reopens.',
  );
  constant(
    'canaryCount',
    'Canaries run in every cycle: fake quickstarts with a known outcome',
    `${p.canaryCount}`,
    `Every cycle runs ${p.canaryCount} canaries; if one gives the wrong answer the whole cycle is ignored.`,
    'Canaries are shown on the site.',
  );
  constant(
    'optOutHours',
    'Hours within which probing stops, and the history is hidden, after an opt-out request',
    `${p.optOutHours} hours`,
    `Probing stops within ${p.optOutHours} hours of an opt-out request.`,
    'We stop when we get round to it.',
  );
  constant(
    'vendorReplyBusinessDays',
    'Business days within which a vendor gets a written reply',
    `${p.vendorReplyBusinessDays} business days`,
    `We reply in writing within ${p.vendorReplyBusinessDays} business days.`,
    `We reply within ${p.optOutHours} hours.`,
  );
  constant(
    'disclosureWaitHours',
    'Hours we wait after a private heads-up before anything is public',
    `${p.disclosureWaitHours} hours`,
    `We tell a vendor privately and wait ${p.disclosureWaitHours} hours before anything is public.`,
    'We publish the day we find a failure.',
  );
  constant(
    'dataCacheMinutes',
    'Minutes the site may be behind the data',
    `${p.dataCacheMinutes} minutes`,
    `The site can be up to ${p.dataCacheMinutes} minutes behind.`,
    'The site is live.',
    'apps/web/src/lib/cache-constants.ts',
  );
  constant(
    'badgeCacheMinutes',
    'Minutes a badge may lag',
    `${p.badgeCacheMinutes} minutes`,
    `A badge can lag the page by up to ${p.badgeCacheMinutes} minutes.`,
    'The badge is live.',
    'apps/web/src/lib/badge.ts',
  );
  constant(
    'targetTotal',
    'The aim for the number of quickstarts tracked: an aim, not a quota',
    `${p.targetTotal}`,
    `We aim to track about ${p.targetTotal} quickstarts.`,
    `We track ${p.targetTotal} quickstarts.`,
  );
  constant(
    'librariesPercent',
    'Share of the aim that is well-known libraries and frameworks',
    `${p.librariesPercent}%`,
    `About ${p.librariesPercent}% of the aim is well-known libraries and frameworks.`,
    `${p.librariesPercent}% of the quickstarts are libraries.`,
  );
  constant(
    'vendorsPercent',
    'Share of the aim that is funded developer-tool SDKs and API clients',
    `${p.vendorsPercent}%`,
    `About ${p.vendorsPercent}% of the aim is funded developer-tool SDKs and API clients.`,
    `${p.vendorsPercent}% of the quickstarts are vendors' own.`,
  );
  constant(
    'vendorRequestsPerCycle',
    "Requests per cycle to a service's API from one quickstart, with an invalid made-up credential",
    `${p.vendorRequestsPerCycle}`,
    `At most ${p.vendorRequestsPerCycle} request per cycle is sent to a service, with an invalid, made-up key.`,
    "We call vendors' APIs constantly.",
  );
  constant(
    'vendorRequestsPerDay',
    'The most such requests a day from one quickstart',
    `${p.vendorRequestsPerDay}`,
    `At most ${p.vendorRequestsPerDay} requests a day, from one quickstart, to a service.`,
    `${p.vendorRequestsPerDay} requests a day per vendor.`,
  );
  constant(
    'termsReviewedOn',
    'When the public terms of the services we send a request to were read: a summary check, not legal advice',
    p.termsReviewedOn,
    `We read the public terms of each service on ${p.termsReviewedOn} (a summary check, not legal advice).`,
    'The vendors have approved our requests.',
  );
  return out;
}

// ---- the sheet

const cell = (s: string): string =>
  s
    .replaceAll('|', '/')
    .replaceAll(/\s*\n\s*/g, ' ')
    .trim();
export const COLUMNS = [
  'Id',
  'Claim',
  'Value',
  'Comes from',
  'Generated',
  'Changes when shadow targets are promoted',
  'Safe wording',
  'Unsafe wording',
] as const;

export function renderClaimsSheet(
  claims: readonly Claim[],
  meta: { generatedAt: string; site: string },
): string {
  const out: string[] = [
    '# Claims',
    '',
    'Every figure that could appear in a public post, one row each: the claim in plain words, its value, where it comes from, when that source was generated, whether it changes when a shadow target is promoted, and a safe and an unsafe way to say it.',
    '',
    `Generated ${ts(meta.generatedAt)} by \`pnpm qsr claims\` from ${meta.site}, docs/detection-power.json, the target files, the pipeline constants and the admin API. Regenerate it, and format it with \`pnpm format\`, whenever any of them changes and before every post: \`pnpm qsr claims\`. \`pnpm qsr claims --check\` fails when it is out of date.`,
    '',
    '## How to use it',
    '',
    '- **Say only what is in the safe wording.** The unsafe wording is what these figures are most often turned into by mistake; it is shown so it is easy to spot.',
    '- A pass at L2 proves less than a pass at L3, so the levels are never added together without saying so. Install-level and code-level results are never added together. No L3 detection rate is quoted anywhere.',
    '- The export check is an experiment and is not in production: it runs in shadow mode and changes no result.',
    '- The README and /methodology may contain only numbers that are in this sheet; a test fails otherwise.',
    '- A figure marked as changing when shadow targets are promoted must be regenerated after a promotion, and a post written before it must be checked again.',
    '',
  ];
  for (const s of SECTIONS) {
    const rows = claims.filter((c) => c.section === s.key);
    if (rows.length === 0) continue;
    out.push(
      `## ${s.title}`,
      '',
      s.note,
      '',
      `| ${COLUMNS.join(' | ')} |`,
      `| ${COLUMNS.map(() => '---').join(' | ')} |`,
      ...rows.map(
        (c) =>
          `| \`${c.id}\` | ${[c.claim, c.value, c.source, c.generated, c.changesOnPromotion ?? 'No', c.safe, c.unsafe].map(cell).join(' | ')} |`,
      ),
      '',
    );
  }
  return `${out.join('\n')}`;
}

// ---- comparing and counting

/**
 * A sheet in a form two renderings of the same data share: table padding and the length of a dash run do not count (prettier changes
 * them), nor does the Generated column or the line saying when the sheet was generated. A number or a word does.
 */
export function squash(md: string): string {
  const out: string[] = [];
  let skip = -1;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('Generated ')) continue;
    if (!line.startsWith('|')) {
      skip = -1;
      out.push(line.replaceAll(/[ \t]+/g, ' '));
      continue;
    }
    const cells = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.includes('Generated')) skip = cells.indexOf('Generated');
    if (skip >= 0 && skip < cells.length) cells[skip] = '';
    out.push(
      `|${cells.map((c) => c.replaceAll(/-{2,}/g, '---').replaceAll(/\s+/g, ' ')).join('|')}|`,
    );
  }
  return out
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- the command

export interface ClaimsDeps {
  fetch?: (url: string | URL | Request) => Promise<Response>;
  /** The operations figures. By default: the admin API and scripts/scale-estimate.mjs. */
  ops?: () => Promise<OpsFacts>;
  now?: () => Date;
}

async function defaultOps(root: string, env: NodeJS.ProcessEnv): Promise<OpsFacts> {
  const client: Pick<ApiClient, 'wakeApi' | 'get'> = adminClientFromEnv(env);
  await client.wakeApi();
  const launch = await client.get('/admin/export/launch', LaunchExport);
  const stats = await client.get('/admin/stats?days=90', StatsResponse);
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'scale-estimate.mjs')], {
    encoding: 'utf8',
  });
  return opsFromAdmin(launch, stats, run.status === 0 ? parseActionsEstimate(run.stdout) : null);
}

export async function gatherInputs(
  root: string,
  site: string,
  deps: ClaimsDeps,
  opts: { admin: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaimsInputs> {
  const doFetch = deps.fetch ?? ((url: string | URL | Request) => fetch(url));
  const res = await doFetch(`${site}/api/status`);
  if (!res.ok) throw new Error(`${site}/api/status answered ${res.status}`);
  const status = PublicStatusSummary.parse(await res.json());
  const raw = JSON.parse(
    await readFile(path.join(root, 'docs', 'detection-power.json'), 'utf8'),
  ) as unknown;
  return {
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    site,
    status,
    detection: await buildSummaryFromRepo(root),
    measurement: extractMeasurement(raw),
    targets: extractTargetFacts(await loadAllTargets(path.join(root, 'targets'))),
    pipeline: pipelineFacts(await readCacheMinutes(root)),
    ops: opts.admin ? await (deps.ops ?? (() => defaultOps(root, env)))() : null,
  };
}

export async function claimsCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  deps: ClaimsDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      'no-admin': { type: 'boolean', default: false },
      root: { type: 'string', default: '.' },
      site: { type: 'string', default: DEFAULT_SITE },
    },
  });
  const root = path.resolve(values.root);
  const site = values.site.replace(/\/+$/, '');
  let inputs: ClaimsInputs;
  try {
    inputs = await gatherInputs(root, site, deps, { admin: !values['no-admin'] });
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr(
        `${err.message}\nThe operations figures come from the admin API; pass --no-admin to write the sheet without them.\n`,
      );
      return 2;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}: the sheet was not touched\n`);
    return 2;
  }
  const sheet = renderClaimsSheet(buildClaims(inputs), { generatedAt: inputs.generatedAt, site });
  const file = path.join(root, CLAIMS_FILE);
  if (values.check) {
    let have = '';
    try {
      have = await readFile(file, 'utf8');
    } catch {
      io.stderr(`${CLAIMS_FILE} is missing. Run: qsr claims\n`);
      return 1;
    }
    if (squash(have) !== squash(sheet)) {
      io.stderr(
        `${CLAIMS_FILE} is out of date with the site, the measurement, the target files or the admin API. Run: qsr claims, then pnpm format\n`,
      );
      return 1;
    }
    io.stdout(`${CLAIMS_FILE} is up to date\n`);
    return 0;
  }
  await writeFile(file, `${sheet}\n`);
  log.info({ file: CLAIMS_FILE }, 'claims sheet written');
  io.stdout(`wrote ${CLAIMS_FILE}\n`);
  return 0;
}
