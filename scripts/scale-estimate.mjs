// The scale estimate behind docs/NOTES.md (P9a): shard sizing, wall time, Actions minutes and storage/database growth
// for N tools. Everything that is MEASURED comes from 63 real `qsr run` results on this machine (2026-10-17, node and
// python targets, real Docker); everything that is ASSUMED is labelled, so P9b can replace it with production numbers
// from `qsr calibration-report`. The cadence, retention and free-tier limits come from `PIPELINE` and `FREE_TIER`.
//
//   node scripts/scale-estimate.mjs [--tools 50] [--days 30]
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { PIPELINE, FREE_TIER } = await import(
  pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
);
const { defaultShardCount } = await import(
  pathToFileURL(path.join(root, 'packages/cli/dist/probe/shards.js')).href
);
const { values } = parseArgs({
  options: { tools: { type: 'string', default: '50' }, days: { type: 'string', default: '30' } },
});
const TOOLS = Number(values.tools);
const DAYS = Number(values.days);
const CANARIES = PIPELINE.canaryCount;
const CYCLES_PER_DAY = PIPELINE.cyclesPerDay;
const MB = 1024 * 1024;

// ---- measured (63 local runs: 45 PASS, 13 FAIL, 4 SKIPPED, 1 HARNESS_ERROR)
const M = {
  stepsPerRun: 5, //            mean (p50 5, p90 7, max 9)
  runJsonBytes: 3165, //        mean RunResult JSON including both 4 KB tails (p90 5233, max 7466)
  runJsonBytesP90: 5233,
  stepSecondsMean: 12.6, //     sum of step durations per run (p50 5.0, p90 22.8; one install hit the 180 s limit)
  stepSecondsP90: 22.8,
  logFilesPerRun: 3, //         one gzipped log per step that wrote output (p90 4)
  logGzBytesPerRun: 357, //     gzip of the redacted step logs, per run (p90 965, max 2969)
  rootTextBytes: 6257, //       median text of a docs page's code root (p90 20072, max 65799), from 112 probed pages
  rootTextBytesP90: 20072,
};

// ---- assumed (no production data yet)
const A = {
  retryShare: 0.05, //             transient failures that run a second attempt
  runnerOverheadSeconds: 8, //     container start, harness checks, log capture, per run
  jobSetupMinutes: 3, //           checkout, Node and pnpm setup, build of the CLI, image pull, per job
  planMinutes: 2, //               crawl 50 pages at concurrency 4 with the plan cache warm (no compile)
  reportMinutes: 2, //             posting ~54 runs at concurrency 4, then the cycle finish
  dbRowOverheadBytes: 150, //      heap tuple header, alignment and one index entry per step row
  dbRunRowBytes: 900, //           runs row with runner_env jsonb and its three indexes
  storageObjectDbBytes: 800, //    storage.objects metadata row with its indexes: counted in the DATABASE size
  planChangesPerToolPerMonth: 4, // docs changes that make a new snapshot and a new plan
  planRowBytes: 8 * 1024, //       compiled_plans row (ir, grounding report, truncation)
  cycleFinishBytes: 6 * 1024, //   probe_cycles.finish_result for 54 tools
  llmCallBytes: 1024,
  llmCallsPerDay: 10,
  logWorstCaseShare: 0.1, //       share of runs that fail with a noisy log
  logWorstCaseGzBytes: 100 * 1024, // gzip of one noisy 256 KB-capped step log
};

const realRuns = (TOOLS + CANARIES) * CYCLES_PER_DAY * (1 + A.retryShare);
const runsInWindow = realRuns * DAYS;
const fmt = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);
const pct = (b, limit) => `${((b / limit) * 100).toFixed(1)}%`;
const out = [];
const row = (...c) => out.push(`| ${c.join(' | ')} |`);

// ---- shards, wall time, Actions minutes
const shards = defaultShardCount(TOOLS + CANARIES);
const perShardRuns = Math.ceil(TOOLS / shards) + 1; // its tools + the guard canary
const shardMin = (secPerRun, extra = 0) =>
  A.jobSetupMinutes + ((perShardRuns + extra) * (secPerRun + A.runnerOverheadSeconds)) / 60;
const typical = shardMin(M.stepSecondsMean);
const slow = shardMin(M.stepSecondsP90);
const shard0 = shardMin(M.stepSecondsMean, CANARIES - 1);
const slowest = Math.max(typical, shard0);
const wall = A.jobSetupMinutes + A.planMinutes + slowest + A.jobSetupMinutes + A.reportMinutes;
const wallSlow =
  A.jobSetupMinutes +
  A.planMinutes +
  Math.max(slow, shardMin(M.stepSecondsP90, CANARIES - 1)) +
  A.jobSetupMinutes +
  A.reportMinutes;
const billedPerCycle =
  A.jobSetupMinutes +
  A.planMinutes +
  (shards - 1) * Math.ceil(typical) +
  Math.ceil(shard0) +
  (A.jobSetupMinutes + A.reportMinutes);
const billedSlowPerCycle =
  A.jobSetupMinutes +
  A.planMinutes +
  shards * Math.ceil(slow + 1) +
  (A.jobSetupMinutes + A.reportMinutes);

out.push(`## Shards and Actions time for ${TOOLS} tools (+${CANARIES} canaries)`, '');
out.push(
  `- Shards: min(${10}, ceil(${TOOLS + CANARIES} / 4)) = **${shards}**, so about ${Math.ceil(TOOLS / shards)} tools per shard plus the guard canary.`,
);
out.push(
  `- Wall time per cycle (plan, slowest shard, report; jobs run one after the other): **${wall.toFixed(0)} min** typical, **${wallSlow.toFixed(0)} min** if every tool were as slow as today's p90. Cadence: ${PIPELINE.cycleHours * 60} min, so ${((wall / (PIPELINE.cycleHours * 60)) * 100).toFixed(0)}% to ${((wallSlow / (PIPELINE.cycleHours * 60)) * 100).toFixed(0)}% of it. The workflow's own limits are 45 min for the execute job and 20 for plan.`,
);
out.push(
  `- Billed Actions minutes: **${billedPerCycle.toFixed(0)} min per cycle**, **${(billedPerCycle * CYCLES_PER_DAY).toFixed(0)} per day**, ${(billedPerCycle * CYCLES_PER_DAY * 30).toFixed(0)} per 30 days (${(billedSlowPerCycle * CYCLES_PER_DAY * 30).toFixed(0)} at p90 speed). The repository is public, so standard hosted runners are free and unmetered; a private repository would have 2,000 free minutes a month.`,
);
out.push(`- Concurrency: ${shards} execute jobs at once; the free plan allows 20.`, '');

// ---- database
const stepRowBytes = (M.runJsonBytes - 400) / M.stepsPerRun + A.dbRowOverheadBytes; // payload (tails) + overhead per step
const perRun = A.dbRunRowBytes + M.stepsPerRun * stepRowBytes;
const perRunP90 = A.dbRunRowBytes + 7 * ((M.runJsonBytesP90 - 400) / 7 + A.dbRowOverheadBytes);
const dbRuns = runsInWindow * perRun;
const snapshots = TOOLS * (1 + (A.planChangesPerToolPerMonth * DAYS) / 30);
const dbSnap = snapshots * (M.rootTextBytes * 1.3);
const dbPlans = snapshots * A.planRowBytes;
const dbCycles = CYCLES_PER_DAY * DAYS * A.cycleFinishBytes;
const dbLlm = A.llmCallsPerDay * DAYS * A.llmCallBytes;
const objects = runsInWindow * M.logFilesPerRun;
const dbObjects = objects * A.storageObjectDbBytes;
const dbTotal = dbRuns + dbSnap + dbPlans + dbCycles + dbLlm + dbObjects;

out.push(
  `## Database and storage growth: ${TOOLS} tools x ${CYCLES_PER_DAY} cycles x ${DAYS} days`,
  '',
);
out.push(
  `Runs in the window: ${TOOLS + CANARIES} x ${CYCLES_PER_DAY} x ${DAYS} x ${1 + A.retryShare} (retries) = **${Math.round(runsInWindow)}**; step rows: ${Math.round(runsInWindow * M.stepsPerRun)}.`,
  '',
);
out.push('| Database (500 MB) | Rows | Bytes | Basis |', '|---|---:|---:|---|');
row(
  'runs + step_results',
  Math.round(runsInWindow) + ' + ' + Math.round(runsInWindow * M.stepsPerRun),
  fmt(dbRuns),
  `${fmt(perRun)} per run (p90 run ${fmt(perRunP90)}); the 4 KB stdout/stderr tails dominate`,
);
row(
  'storage.objects metadata',
  Math.round(objects),
  fmt(dbObjects),
  `${M.logFilesPerRun} log files per run x ${A.storageObjectDbBytes} B; the same database, bounded by the ${PIPELINE.logRetentionDays}-day log retention`,
);
row(
  'doc_snapshots',
  Math.round(snapshots),
  fmt(dbSnap),
  `${A.planChangesPerToolPerMonth} docs changes a month per tool; ${fmt(M.rootTextBytes)} median page text x 1.3`,
);
row('compiled_plans', Math.round(snapshots), fmt(dbPlans), `${fmt(A.planRowBytes)} per plan`);
row(
  'probe_cycles',
  CYCLES_PER_DAY * DAYS,
  fmt(dbCycles),
  `${fmt(A.cycleFinishBytes)} stored finish result`,
);
row('llm_calls', A.llmCallsPerDay * DAYS, fmt(dbLlm), `${A.llmCallsPerDay} a day`);
row(
  '**Total**',
  '',
  `**${fmt(dbTotal)}**`,
  `**${pct(dbTotal, FREE_TIER.databaseBytes)}** of ${fmt(FREE_TIER.databaseBytes)}`,
);
out.push('');

const logTypical = runsInWindow * M.logGzBytesPerRun;
const logBad = runsInWindow * A.logWorstCaseShare * M.logFilesPerRun * A.logWorstCaseGzBytes;
const logCap = runsInWindow * M.stepsPerRun * 256 * 1024;
out.push('| Storage (1 GB; cleanup aims under 800 MB) | Bytes | Basis |', '|---|---:|---|');
row(
  'step logs, typical',
  fmt(logTypical),
  `${M.logGzBytesPerRun} B gzipped per run (measured), kept ${PIPELINE.logRetentionDays} days`,
);
row(
  'step logs, noisy',
  fmt(logTypical + logBad),
  `${pct(A.logWorstCaseShare, 1)} of runs write 3 logs of ${fmt(A.logWorstCaseGzBytes)} gzipped (the 256 KB cap)`,
);
row(
  'step logs, theoretical ceiling',
  fmt(logCap),
  'every step at the 256 KB cap, uncompressed: not reachable, shown only as the bound',
);
row('docs diffs', '< 1 MB', 'one small text file per confirmed incident, kept');
row(
  'traces',
  '0',
  `none are produced in v1 (no L4); retention would be ${PIPELINE.traceRetentionDays} days`,
);
out.push('');

// ---- the database is the thing that grows without a bound: runs are history and are never collected
const monthly = dbRuns + dbSnap + dbPlans + dbCycles + dbLlm;
const fixed = dbObjects; // bounded by retention
const monthsTo70 = (0.7 * FREE_TIER.databaseBytes - fixed) / monthly;
const monthsTo100 = (FREE_TIER.databaseBytes - fixed) / monthly;
out.push('### Beyond the window', '');
out.push(
  `Logs and their metadata are collected after ${PIPELINE.logRetentionDays} days, but the \`runs\`, \`step_results\`, \`probe_cycles\` and \`doc_snapshots\` rows are the public history and are kept. They add about **${fmt(monthly)} a month**. Adding the ${fmt(fixed)} of log metadata (steady), the database reaches 70% of the limit after about **${monthsTo70.toFixed(1)} months** and 100% after about **${monthsTo100.toFixed(1)} months**.`,
  '',
);
const tailShare = (M.stepsPerRun * (M.runJsonBytes - 400)) / M.stepsPerRun / perRun;
out.push(
  `Smallest fix (proposed, not built): after ${PIPELINE.logRetentionDays} days, the nightly GC sets \`stdout_tail\` and \`stderr_tail\` to null on step rows of PASSING runs that no incident links. The tails are about ${(tailShare * 100).toFixed(0)}% of a run's bytes, and a passing step's tail is not evidence of anything. That keeps the row counts (the public history) and moves the monthly growth to about ${fmt(monthly - dbRuns * tailShare * 0.85)} (assuming 85% of runs pass). Failing runs keep their tails.`,
);

console.log(out.join('\n'));
