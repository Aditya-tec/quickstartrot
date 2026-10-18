import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  FinishResponse,
  GUARD_CANARY,
  MANIFEST_FILE,
  Manifest,
  PlanFile,
  RUNNER_ENV_KEYS,
  RunResponse,
  RunResult,
  SAFE_STEP_ID,
  STEP_LOG_MAX_BYTES,
  UploadsResponse,
  redact,
  type Logger,
  type PreflightFailure,
  type RunBody,
} from '@qsr/core';
import { ApiError, type ApiClient } from '../api-client.js';
import type { HarnessProblemResult } from './github.js';
import { createLimiter } from './crawl-pool.js';
import { renderSummary, type SummaryRow } from './summary.js';
import { putToSignedUrl } from './upload.js';

// `qsr report` (spec section 12). It runs in the job that has the secrets, after the execute jobs, and
// reads the results those jobs uploaded. Those results come from a job that ran code copied from the
// internet, so they are data from an untrusted source: parsed with the core schema, size-capped, logs
// redacted again and confined to the results directory. The API re-validates all of it.
//
// Every call is safe to repeat: the API ingests a run once per (cycle, tool, attempt) and signed upload
// URLs allow an upsert, so a failed report job can simply be re-run.

export class ReportError extends Error {
  override readonly name = 'ReportError';
}

export interface ReportOptions {
  results: string;
  plans: string;
  cycleId: string;
  /** The site, when it exists: run ids in the summary become links. */
  webBaseUrl?: string | null;
  /** The public Supabase anon key, sent with log uploads if the project's gateway wants one. */
  anonKey?: string | null;
  /** Link to this Actions run, for the issue body. */
  runUrl?: string | null;
  /** Tools reported at once, 1 to MAX_REPORT_CONCURRENCY (default REPORT_CONCURRENCY). A knob for measuring, not tuning. */
  concurrency?: number;
}

export interface ReportDeps {
  api: Pick<ApiClient, 'wakeApi' | 'post'>;
  /** Used for the log uploads (PUT to the signed URLs). */
  fetch: typeof fetch;
  /** Opens or comments on the `harness` issue; null when there is no token (a local run). */
  github: ((problem: { title: string; body: string }) => Promise<HarnessProblemResult>) | null;
  writeSummary(markdown: string): Promise<void>;
  log: Logger;
}

export interface ReportOutcome {
  finish: FinishResponse;
  rows: SummaryRow[];
  /** Harness-error final results over real tools that were planned to run (canaries excluded). */
  harnessRate: number;
  issue: HarnessProblemResult | null;
}

export const MAX_RESULT_FILE_BYTES = 1_000_000;
export const HARNESS_ERROR_RATE_LIMIT = 0.05;
/** Tools reported at once. The ingest is idempotent, so overlapping them is safe; one tool's calls stay in order. */
export const REPORT_CONCURRENCY = 4;
export const MAX_REPORT_CONCURRENCY = 8;
/** A failing guard canary is posted as attempt GUARD_ATTEMPT_BASE + shard, above any real attempt. */
export const GUARD_ATTEMPT_BASE = 10;
const MAX_LOG_FILES = 64;
const TRUNCATION_NOTE = '\n[... truncated by the report job]\n';

type ReadyFile = Extract<PlanFile, { state: 'ready' }>;
type PreFailedFile = Extract<PlanFile, { state: 'pre_failed' }>;
interface Found {
  result: RunResult;
  dir: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadPlans(
  options: ReportOptions,
): Promise<{ manifest: Manifest; files: Map<string, PlanFile> }> {
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(await readJsonFile(path.join(options.plans, MANIFEST_FILE)));
  } catch (err) {
    throw new ReportError(`the plan manifest cannot be used: ${messageOf(err)}`);
  }
  if (manifest.cycleId !== options.cycleId)
    throw new ReportError(
      `the plans are for cycle ${manifest.cycleId}, not ${options.cycleId}; refusing to report`,
    );
  const files = new Map<string, PlanFile>();
  for (const entry of manifest.tools) {
    try {
      const file = PlanFile.parse(
        await readJsonFile(path.join(options.plans, `${entry.toolSlug}.json`)),
      );
      if (file.cycleId !== manifest.cycleId) throw new Error('belongs to another cycle');
      files.set(entry.toolSlug, file);
    } catch (err) {
      throw new ReportError(`the plan of ${entry.toolSlug} cannot be used: ${messageOf(err)}`);
    }
  }
  return { manifest, files };
}

/** Every result file directly in `dir`, validated. Anything invalid is dropped with a warning. */
async function readResults(dir: string, cycleId: string, log: Logger): Promise<Found[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const found: Found[] = [];
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      if ((await stat(file)).size > MAX_RESULT_FILE_BYTES) throw new Error('the file is too large');
      const result = RunResult.parse(await readJsonFile(file));
      if (result.cycleId !== cycleId) throw new Error('the result belongs to another cycle');
      found.push({ result, dir });
    } catch (err) {
      log.warn({ file: name, err: messageOf(err) }, 'ignoring an invalid result file');
    }
  }
  return found;
}

function clip(text: string): string {
  if (Buffer.byteLength(text) <= STEP_LOG_MAX_BYTES) return text;
  return `${Buffer.from(text).subarray(0, STEP_LOG_MAX_BYTES).toString('utf8')}${TRUNCATION_NOTE}`;
}

/** Reads one step log from inside `dir`, redacts it again, caps it and gzips it. */
async function gzippedLog(dir: string, logFile: string): Promise<Buffer | null> {
  const resolved = path.resolve(dir, logFile);
  const root = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(root)) return null; // a path outside the results directory is never read
  try {
    return gzipSync(Buffer.from(clip(redact(await readFile(resolved, 'utf8'))), 'utf8'));
  } catch {
    return null;
  }
}

function harnessErrorRun(
  base: {
    toolSlug: string;
    cycleId: string;
    planId: string | null;
    snapshotHash: string | null;
  },
  attempt: number,
  reason: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const now = new Date().toISOString();
  return RunResult.parse({
    ...base,
    attempt,
    outcome: 'HARNESS_ERROR',
    reachedLevel: 0,
    failedStepId: null,
    steps: [],
    imageDigest: 'unknown',
    runnerEnv: { ...extraEnv, harness_error: reason.slice(0, 500) },
    startedAt: now,
    finishedAt: now,
  });
}

function preflightRun(file: PreFailedFile): RunResult {
  const now = new Date().toISOString();
  return RunResult.parse({
    toolSlug: file.toolSlug,
    cycleId: file.cycleId,
    attempt: 1,
    planId: file.planId,
    snapshotHash: file.snapshotHash,
    outcome: 'FAIL',
    reachedLevel: 0,
    failedStepId: null,
    steps: [],
    imageDigest: 'none',
    runnerEnv: {},
    startedAt: now,
    finishedAt: now,
  });
}

export async function runReport(options: ReportOptions, deps: ReportDeps): Promise<ReportOutcome> {
  const { api, log } = deps;
  const { manifest, files } = await loadPlans(options);
  await api.wakeApi();

  // ---- what came back
  const primary = await readResults(options.results, options.cycleId, log);
  const attemptsBySlug = new Map<string, Found[]>();
  for (const f of primary) {
    const plan = files.get(f.result.toolSlug);
    if (plan?.state !== 'ready') {
      log.warn(
        { toolSlug: f.result.toolSlug },
        'ignoring a result for a tool that was not planned to run',
      );
      continue;
    }
    const list = attemptsBySlug.get(f.result.toolSlug) ?? [];
    if (!list.some((x) => x.result.attempt === f.result.attempt)) list.push(f);
    attemptsBySlug.set(f.result.toolSlug, list);
  }

  // ---- uploads and posts
  async function uploadLogs(found: Found, attempt: number): Promise<Record<string, string>> {
    const { result, dir } = found;
    const logPaths: Record<string, string> = {};
    const wanted: { stepId: string; ordinal: number; data: Buffer }[] = [];
    for (const step of result.steps) {
      if (!step.logFile || !SAFE_STEP_ID.test(step.stepId) || step.ordinal > 255) continue;
      if (wanted.length >= MAX_LOG_FILES) break;
      const data = await gzippedLog(dir, step.logFile);
      if (data) wanted.push({ stepId: step.stepId, ordinal: step.ordinal, data });
    }
    if (wanted.length === 0) return logPaths;
    try {
      const response = UploadsResponse.parse(
        await api.post('/internal/uploads', {
          cycleId: options.cycleId,
          toolSlug: result.toolSlug,
          attempt,
          files: wanted.map(({ stepId, ordinal }) => ({ stepId, ordinal })),
        }),
      );
      for (const target of response.files) {
        const data = wanted.find((w) => w.stepId === target.stepId)?.data;
        if (!data) continue;
        const res = await putToSignedUrl({
          fetch: deps.fetch,
          signedUrl: target.signedUrl,
          data,
          anonKey: options.anonKey ?? null,
        });
        if (res.ok) logPaths[target.stepId] = target.path;
        else
          log.warn(
            { toolSlug: result.toolSlug, stepId: target.stepId, status: res.status },
            'log upload was refused',
          );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // A repeated report of a finished cycle: the first report already uploaded these logs.
        log.info(
          { toolSlug: result.toolSlug },
          'the cycle is already finished; not uploading the logs again',
        );
      } else {
        log.warn(
          { toolSlug: result.toolSlug, err: messageOf(err) },
          'could not upload the logs; posting the run without them',
        );
      }
    }
    return logPaths;
  }

  /** Posts one run. A 4xx means the API refused THIS result; a 5xx or no answer means try the whole report again. */
  async function postRun(body: RunBody): Promise<RunResponse | null> {
    try {
      return RunResponse.parse(await api.post('/internal/runs', body));
    } catch (err) {
      // a 429 is the rate limiter, not a verdict on this result: it is never replaced by a harness error (the report stops, a re-run completes it)
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        log.warn(
          { toolSlug: body.runResult.toolSlug, status: err.status, detail: err.detail },
          'the API refused a result; recording a harness error instead',
        );
        const stand = harnessErrorRun(
          {
            toolSlug: body.runResult.toolSlug,
            cycleId: body.runResult.cycleId,
            planId: null,
            snapshotHash: null,
          },
          body.runResult.attempt,
          `the API rejected the result: ${err.detail ?? err.message}`,
        );
        try {
          return RunResponse.parse(
            await api.post('/internal/runs', { runResult: stand, logPaths: {} }),
          );
        } catch (second) {
          if (second instanceof ApiError && second.status < 500 && second.status !== 429) {
            log.warn(
              { toolSlug: body.runResult.toolSlug },
              'the API refused the stand-in run too; the tool has no run this cycle',
            );
            return null;
          }
          throw new ReportError(
            `could not post a run for ${body.runResult.toolSlug}: ${messageOf(second)}`,
          );
        }
      }
      throw new ReportError(
        `could not post a run for ${body.runResult.toolSlug}: ${messageOf(err)}`,
      );
    }
  }

  type Final = {
    result: RunResult;
    runId: string | null;
    synthetic: boolean;
    failureClass: string | null;
  };
  type Done = { slug: string; row: SummaryRow | null; final: Final | null };

  /** Everything one tool needs (its uploads and posts), in order. Tools are reported four at a time. */
  async function reportTool(entry: Manifest['tools'][number]): Promise<Done> {
    const file = files.get(entry.toolSlug) as PlanFile;
    if (file.state === 'deferred')
      return {
        slug: file.toolSlug,
        final: null,
        row: {
          slug: file.toolSlug,
          isCanary: file.isCanary,
          targetLevel: file.target.level,
          reachedLevel: null,
          outcome: 'SKIPPED',
          failureClass: null,
          durationMs: null,
          stale: false,
          runId: null,
          note: `deferred: ${file.reason}`,
        },
      };

    if (file.state === 'pre_failed') {
      const run = preflightRun(file);
      const posted = await postRun({
        runResult: run,
        logPaths: {},
        preflight: file.preflight as PreflightFailure,
      });
      return {
        slug: file.toolSlug,
        final: null,
        row: {
          slug: file.toolSlug,
          isCanary: file.isCanary,
          targetLevel: file.target.level,
          reachedLevel: null,
          outcome: 'FAIL',
          failureClass: file.preflight.failureClass,
          durationMs: null,
          stale: false,
          runId: posted?.runId ?? null,
          note: `${file.preflight.reason}: ${file.preflight.message}`,
        },
      };
    }

    const ready = file as ReadyFile;
    const attempts = (attemptsBySlug.get(ready.toolSlug) ?? []).sort(
      (x, y) => x.result.attempt - y.result.attempt,
    );
    if (attempts.length === 0) {
      const stand = harnessErrorRun(
        {
          toolSlug: ready.toolSlug,
          cycleId: ready.cycleId,
          planId: ready.plan.planId,
          snapshotHash: ready.plan.snapshotHash,
        },
        1,
        `no result from shard ${String(ready.shard)}`,
        { [RUNNER_ENV_KEYS.shard]: String(ready.shard) },
      );
      const posted = await postRun({ runResult: stand, logPaths: {} });
      return {
        slug: ready.toolSlug,
        row: null,
        final: {
          result: stand,
          runId: posted?.runId ?? null,
          synthetic: true,
          failureClass: 'HARNESS_ERROR',
        },
      };
    }
    let last: { result: RunResult; runId: string | null; response: RunResponse | null } | null =
      null;
    // the attempts of ONE tool stay in order: the API treats the last one as the final result
    for (const found of attempts) {
      const logPaths = await uploadLogs(found, found.result.attempt);
      const posted = await postRun({ runResult: found.result, logPaths });
      last = { result: found.result, runId: posted?.runId ?? null, response: posted };
    }
    const final = last as NonNullable<typeof last>;
    return {
      slug: ready.toolSlug,
      row: null,
      final: {
        result: final.result,
        runId: final.runId,
        synthetic: false,
        failureClass:
          final.response?.classification?.failureClass ??
          (final.result.outcome === 'HARNESS_ERROR' ? 'HARNESS_ERROR' : null),
      },
    };
  }

  // Four tools at a time (the ingest is idempotent per (cycle, tool, attempt), so overlapping is safe). A failure
  // stops the tools not yet started; the answers are then read in MANIFEST order, so the summary never depends on
  // which request finished first.
  const limit = createLimiter(options.concurrency ?? REPORT_CONCURRENCY);
  let stopped = false;
  const settled = await Promise.allSettled(
    manifest.tools.map((entry) =>
      limit(entry.toolSlug, async (): Promise<Done | null> => {
        if (stopped) return null;
        try {
          return await reportTool(entry);
        } catch (err) {
          stopped = true;
          throw err;
        }
      }),
    ),
  );
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;

  const rows: SummaryRow[] = [];
  const finals = new Map<string, Final>();
  for (const result of settled) {
    const done = (result as PromiseFulfilledResult<Done | null>).value;
    if (!done) continue;
    if (done.row) rows.push(done.row);
    if (done.final) finals.set(done.slug, done.final);
  }

  // ---- the guard canary of every other shard: only a failure is posted, as a later attempt of the canary,
  // so the API's canary check (which looks at the final attempt) fails the cycle
  for (const shard of manifest.guards) {
    const found = await readResults(
      path.join(options.results, 'guards', `shard-${shard}`),
      options.cycleId,
      log,
    );
    const guard = found
      .filter((f) => f.result.toolSlug === GUARD_CANARY)
      .sort((x, y) => y.result.attempt - x.result.attempt)[0];
    if (!guard) {
      log.warn(
        { shard },
        'no guard canary result from this shard; its tools are covered by the missing-result rule',
      );
      continue;
    }
    if (guard.result.outcome === 'PASS') continue;
    const attempt = GUARD_ATTEMPT_BASE + shard;
    const renumbered: Found = {
      dir: guard.dir,
      result: RunResult.parse({
        ...guard.result,
        attempt,
        runnerEnv: { ...guard.result.runnerEnv, [RUNNER_ENV_KEYS.shard]: String(shard) },
      }),
    };
    const logPaths = await uploadLogs(renumbered, attempt);
    await postRun({ runResult: renumbered.result, logPaths });
  }

  // ---- rows for the tools that ran (or should have)
  for (const entry of manifest.tools) {
    const final = finals.get(entry.toolSlug);
    if (!final) continue;
    const file = files.get(entry.toolSlug) as ReadyFile;
    rows.push({
      slug: file.toolSlug,
      isCanary: file.isCanary,
      targetLevel: file.target.level,
      reachedLevel: final.synthetic ? null : final.result.reachedLevel,
      outcome: final.result.outcome,
      failureClass: final.failureClass,
      durationMs: final.synthetic
        ? null
        : Date.parse(final.result.finishedAt) - Date.parse(final.result.startedAt),
      stale: file.plan.stale,
      runId: final.runId,
      note: final.synthetic ? (final.result.runnerEnv['harness_error'] ?? null) : null,
    });
  }

  // ---- finish the cycle
  let finish: FinishResponse;
  try {
    finish = FinishResponse.parse(await api.post(`/internal/cycles/${options.cycleId}/finish`, {}));
  } catch (err) {
    throw new ReportError(`could not finish the cycle: ${messageOf(err)}`);
  }

  // ---- the harness error rate over the tools that were planned to run (canaries are judged by the cycle)
  const realFinals = manifest.tools
    .filter((t) => t.state === 'ready' && !t.isCanary)
    .map((t) => finals.get(t.toolSlug));
  const harnessErrors = realFinals.filter((f) => f?.result.outcome === 'HARNESS_ERROR').length;
  const harnessRate = realFinals.length === 0 ? 0 : harnessErrors / realFinals.length;

  const markdown = renderSummary({
    cycleId: options.cycleId,
    valid: finish.valid,
    canaryProblems: finish.canaryProblems,
    webBaseUrl: options.webBaseUrl ?? null,
    rows,
  });
  await deps.writeSummary(markdown);

  // ---- the alert channel
  let issue: HarnessProblemResult | null = null;
  const tooManyHarnessErrors = harnessRate > HARNESS_ERROR_RATE_LIMIT;
  if (!finish.valid || tooManyHarnessErrors) {
    const reasons: string[] = [];
    if (!finish.valid)
      reasons.push(
        `The cycle is **invalid**: ${finish.canaryProblems.join('; ') || 'a canary misbehaved'}. No status was changed.`,
      );
    if (tooManyHarnessErrors)
      reasons.push(
        `The harness error rate is ${(harnessRate * 100).toFixed(1)}% (${harnessErrors} of ${realFinals.length} tools), above the ${HARNESS_ERROR_RATE_LIMIT * 100}% limit.`,
      );
    const problem = {
      title: !finish.valid
        ? `Probe cycle ${options.cycleId.slice(0, 8)} is invalid`
        : `Probe harness error rate ${(harnessRate * 100).toFixed(0)}% in cycle ${options.cycleId.slice(0, 8)}`,
      body: [
        `Cycle \`${options.cycleId}\` needs attention.`,
        '',
        ...reasons.map((r) => `- ${r}`),
        ...(options.runUrl ? ['', `Actions run: ${options.runUrl}`] : []),
        '',
        markdown,
      ].join('\n'),
    };
    if (deps.github === null) {
      log.warn(
        { cycleId: options.cycleId, reasons },
        'harness problem found, but there is no GitHub token to report it',
      );
    } else {
      try {
        issue = await deps.github(problem);
        log.info(
          { cycleId: options.cycleId, action: issue.action, url: issue.url },
          'harness issue updated',
        );
      } catch (err) {
        log.error(
          { cycleId: options.cycleId, err: messageOf(err) },
          'could not open or update the harness issue',
        );
      }
    }
  }

  return { finish, rows, harnessRate, issue };
}
