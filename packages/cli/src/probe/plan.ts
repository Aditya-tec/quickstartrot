import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CrawlError } from '@qsr/crawler';
import {
  CompileResponse,
  CycleResponse,
  MANIFEST_FILE,
  PROBE_FILE_VERSION,
  type CycleTool,
  type Extraction,
  type Logger,
  type Manifest,
  type ManifestTool,
  type PlanFile,
  type PreflightFailure,
  type StepIR,
  type Target,
} from '@qsr/core';
import { ApiError, type ApiClient } from '../api-client.js';
import { createLimiter, domainOf } from './crawl-pool.js';
import { assignShards, defaultShardCount, type ShardTool } from './shards.js';

// `qsr plan` (spec section 12). Runs in the job that has the secrets and never executes docs code:
//   wake the API, sync the targets, create the cycle, crawl every enabled target (concurrency 4, one page per
//   domain at a time, robots.txt respected by the crawler), ask /internal/compile for a plan, write
//   plans/<slug>.json and plans/manifest.json, and hand the shard list to the execute matrix.
// Every compile outcome has a place: an accepted plan runs; a stale plan (the model was not asked) runs and
// is flagged; a deferral without a plan is an informational skip; a crawl or compile failure is recorded
// as pre-failed and reported without being executed.

export const CRAWL_CONCURRENCY = 4;
/** The whole compile phase is capped: tools it does not reach are deferred, never failed. */
export const COMPILE_PHASE_LIMIT_MS = 15 * 60_000;
/** How long to wait before the one retry when the provider or the API did not say. */
export const DEFAULT_RETRY_WAIT_S = 30;
/** A longer Retry-After is a daily limit: waiting cannot help, so the tool is deferred at once. */
export const MAX_RETRY_WAIT_S = 120;

export interface PlanOptions {
  out: string;
  /** Slugs to run. Empty means every enabled tool. The canaries always run. */
  only: readonly string[];
  /** Overrides the default of min(10, ceil(tools / 4)). */
  shards?: number;
  trigger: 'cron' | 'manual' | 'target_pr';
  gitSha: string;
  ghRunId?: number;
  ghRunAttempt: number;
}

export interface PlanDeps {
  api: Pick<ApiClient, 'wakeApi' | 'post'>;
  targets: { real: readonly Target[]; canaries: readonly Target[] };
  /** Crawls one page. Throws CrawlError (reason, message) when the page cannot be used. */
  crawl(target: Target): Promise<Extraction>;
  /** The committed plan of a canary, checked against the page as crawled now; null if there is none. */
  goldenPlan(target: Target, extraction: Extraction): Promise<StepIR | null>;
  log: Logger;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Appends `name=value` to $GITHUB_OUTPUT. */
  writeOutput(name: string, value: string): Promise<void>;
  /** Appends Markdown to $GITHUB_STEP_SUMMARY. */
  writeSummary(markdown: string): Promise<void>;
  concurrency?: number;
}

export interface PlanResult {
  cycleId: string;
  shards: number;
  manifest: Manifest;
}

type Planned =
  | { state: 'ready'; plan: Extract<PlanFile, { state: 'ready' }>['plan'] }
  | {
      state: 'pre_failed';
      preflight: PreflightFailure;
      planId: string | null;
      snapshotHash: string | null;
    }
  | { state: 'deferred'; reason: Extract<PlanFile, { state: 'deferred' }>['reason'] };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runPlan(options: PlanOptions, deps: PlanDeps): Promise<PlanResult> {
  const { api, log } = deps;
  await api.wakeApi();

  const all = [...deps.targets.real, ...deps.targets.canaries];
  await api.post('/internal/targets/sync', { targets: all });
  const cycle = CycleResponse.parse(
    await api.post('/internal/cycles', {
      trigger: options.trigger,
      gitSha: options.gitSha,
      ...(options.ghRunId === undefined ? {} : { ghRunId: options.ghRunId }),
      ghRunAttempt: options.ghRunAttempt,
    }),
  );
  const cycleId = cycle.cycleId;
  log.info({ cycleId, enabled: cycle.tools.length, created: cycle.created }, 'cycle ready');

  // The API decides what is enabled; the files say how to crawl it.
  const localBySlug = new Map(all.map((t) => [t.slug, t]));
  const only = new Set(options.only);
  const selected: { target: Target; cycleTool: CycleTool }[] = [];
  for (const tool of cycle.tools) {
    const local = localBySlug.get(tool.slug);
    if (!local) {
      log.warn(
        { cycleId, toolSlug: tool.slug },
        'enabled in the API but has no target file here; skipped',
      );
      continue;
    }
    if (!tool.isCanary && only.size > 0 && !only.has(tool.slug)) continue;
    selected.push({ target: local, cycleTool: tool });
  }

  const crawlLimit = createLimiter(deps.concurrency ?? CRAWL_CONCURRENCY);
  const planned = new Map<string, Planned>();

  async function tellCrawlError(slug: string, reason: string, message: string): Promise<void> {
    try {
      await api.post('/internal/compile', {
        cycleId,
        toolSlug: slug,
        crawlError: { reason: reason.slice(0, 100), message: message.slice(0, 2000) },
      });
    } catch (err) {
      log.error(
        { cycleId, toolSlug: slug, err: messageOf(err) },
        'could not report the crawl error',
      );
    }
  }

  async function planCanary(t: Target): Promise<Planned> {
    let extraction: Extraction;
    try {
      extraction = await crawlLimit(domainOf(t.docsUrl), () => deps.crawl(t));
    } catch (err) {
      return crawlFailure(t, err);
    }
    try {
      const golden = await deps.goldenPlan(t, extraction);
      if (golden === null) throw new Error('there is no committed golden plan for this canary');
      return {
        state: 'ready',
        plan: {
          planId: null,
          snapshotHash: extraction.contentHash,
          ir: golden,
          stale: false,
          compilerVersion: null,
        },
      };
    } catch (err) {
      log.error(
        { cycleId, toolSlug: t.slug, err: messageOf(err) },
        'canary golden plan is not usable',
      );
      return {
        state: 'pre_failed',
        preflight: {
          stage: 'compile',
          failureClass: 'COMPILER_ERROR',
          reason: 'golden_plan_invalid',
          message: messageOf(err).slice(0, 2000),
        },
        planId: null,
        snapshotHash: extraction.contentHash,
      };
    }
  }

  function crawlFailure(t: Target, err: unknown): Planned {
    const reason = err instanceof CrawlError ? err.reason : 'crawler_crash';
    const message = messageOf(err);
    log.warn({ cycleId, toolSlug: t.slug, reason, message }, 'crawl failed');
    return {
      state: 'pre_failed',
      preflight: {
        stage: 'crawl',
        failureClass: 'CRAWL_ERROR',
        reason,
        message: message.slice(0, 2000),
      },
      planId: null,
      snapshotHash: null,
    };
  }

  /** Crawls a real tool's page. A failure is the tool's pre-failed entry (and is told to the API). */
  async function crawlReal(t: Target): Promise<{ extraction: Extraction } | { failed: Planned }> {
    try {
      return { extraction: await crawlLimit(domainOf(t.docsUrl), () => deps.crawl(t)) };
    } catch (err) {
      const failed = crawlFailure(t, err);
      if (failed.state === 'pre_failed')
        await tellCrawlError(t.slug, failed.preflight.reason, failed.preflight.message);
      return { failed };
    }
  }

  /** What /internal/compile said about a tool, as a plan entry. */
  function toPlanned(response: CompileResponse, extraction: Extraction): Planned {
    switch (response.status) {
      case 'ok':
        return response.plan.ir === null
          ? { state: 'deferred', reason: 'llm_unavailable' }
          : {
              state: 'ready',
              plan: {
                planId: response.plan.id,
                snapshotHash: extraction.contentHash,
                ir: response.plan.ir,
                stale: false,
                compilerVersion: response.plan.compilerVersion,
              },
            };
      case 'compiler_error': {
        const why = response.plan.groundingReport.violations
          .map((v) => `${v.stepId} ${v.rule}`)
          .join(', ');
        return {
          state: 'pre_failed',
          preflight: {
            stage: 'compile',
            failureClass: 'COMPILER_ERROR',
            reason: 'rejected_twice',
            message: `the plan failed the grounding validator twice${why ? `: ${why}` : ''}`.slice(
              0,
              2000,
            ),
          },
          planId: response.plan.id,
          snapshotHash: extraction.contentHash,
        };
      }
      case 'crawl_error':
        return {
          state: 'pre_failed',
          preflight: {
            stage: 'crawl',
            failureClass: 'CRAWL_ERROR',
            reason: 'crawl_error',
            message: 'the API recorded a crawl error for this tool',
          },
          planId: null,
          snapshotHash: null,
        };
      case 'deferred':
        return response.plan !== null && response.plan.ir !== null
          ? {
              state: 'ready',
              plan: {
                planId: response.plan.id,
                // the page as crawled now: the plan is older, and the run says so (stale)
                snapshotHash: extraction.contentHash,
                ir: response.plan.ir,
                stale: true,
                compilerVersion: response.plan.compilerVersion,
              },
            }
          : { state: 'deferred', reason: response.reason };
    }
  }

  /**
   * The Groq circuit breaker. Once one tool shows that the model is out for the day (an answer that deferred with a
   * Retry-After of hours, or our own token budget), asking again can only waste a call per tool, and the API may
   * sleep up to a minute inside each. So every remaining tool gets the no-model call at once: the cache or its last
   * accepted plan, else an informational skip with the reason that opened the breaker.
   */
  let breaker: { reason: 'llm_budget' | 'llm_unavailable' | 'llm_timeout' } | null = null;

  type Attempt =
    | { kind: 'response'; response: CompileResponse }
    | { kind: 'http'; status: number; retryAfterS: number | null; err: unknown }
    | { kind: 'other'; err: unknown };

  /** One /internal/compile call. `modelAllowed: false` asks for the cache or the stale plan only. */
  async function askCompile(
    t: Target,
    extraction: Extraction,
    modelAllowed: boolean,
  ): Promise<Attempt> {
    try {
      const body = {
        cycleId,
        toolSlug: t.slug,
        extraction,
        ...(modelAllowed ? {} : { modelAllowed: false }),
      };
      return {
        kind: 'response',
        response: CompileResponse.parse(await api.post('/internal/compile', body)),
      };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 429 || err.status >= 500))
        return { kind: 'http', status: err.status, retryAfterS: err.retryAfterS, err };
      return { kind: 'other', err };
    }
  }

  /** The reason to open the breaker for, when this answer says the model is out for the day. */
  function dailyLimit(a: Attempt): 'llm_budget' | 'llm_unavailable' | 'llm_timeout' | null {
    if (a.kind === 'http')
      return (a.retryAfterS ?? 0) > MAX_RETRY_WAIT_S ? 'llm_unavailable' : null;
    if (a.kind === 'response' && a.response.status === 'deferred') {
      if (a.response.reason === 'llm_budget') return 'llm_budget';
      if ((a.response.retryAfterSeconds ?? 0) > MAX_RETRY_WAIT_S) return a.response.reason;
    }
    return null;
  }

  function noteDailyLimit(toolSlug: string, a: Attempt): void {
    const reason = dailyLimit(a);
    if (reason === null || breaker !== null) return;
    breaker = { reason };
    log.warn(
      { cycleId, toolSlug, reason },
      'compile circuit breaker open: the model is out for the day; every remaining tool gets the cache or its last plan only',
    );
  }

  /** Seconds to wait before the one retry, or null when waiting cannot help or is not warranted. */
  function retryWaitS(a: Attempt): number | null {
    let wait: number | null = null;
    if (a.kind === 'http') wait = a.retryAfterS ?? DEFAULT_RETRY_WAIT_S;
    else if (
      a.kind === 'response' &&
      a.response.status === 'deferred' &&
      // our own token budget is not a rate limit: a retry would change nothing
      (a.response.reason === 'llm_unavailable' || a.response.reason === 'llm_timeout')
    )
      wait = a.response.retryAfterSeconds ?? DEFAULT_RETRY_WAIT_S;
    return wait !== null && wait <= MAX_RETRY_WAIT_S ? wait : null;
  }

  /**
   * Compiles one tool. A rate limit or a 5xx waits for its Retry-After (30 s if it gave none) and tries ONCE
   * more; after that the tool is deferred exactly as the budget guard defers it: the last accepted plan,
   * flagged stale, if there is one, else an informational skip. Never a verdict on the tool.
   */
  async function compileReal(
    t: Target,
    extraction: Extraction,
    outOfTime: boolean,
  ): Promise<Planned> {
    const deferWithoutModel = async (
      reason: 'llm_budget' | 'llm_unavailable' | 'llm_timeout',
    ): Promise<Planned> => {
      const a = await askCompile(t, extraction, false);
      return a.kind === 'response'
        ? toPlanned(a.response, extraction)
        : { state: 'deferred', reason };
    };

    if (breaker !== null) {
      const kept = await deferWithoutModel(breaker.reason);
      // the no-model answer says llm_timeout; the tool was skipped because of the breaker's reason
      return kept.state === 'deferred' ? { state: 'deferred', reason: breaker.reason } : kept;
    }

    if (outOfTime) {
      log.warn(
        { cycleId, toolSlug: t.slug },
        'the compile phase ran out of time; deferring the tool',
      );
      return deferWithoutModel('llm_timeout');
    }

    let attempt = await askCompile(t, extraction, true);
    noteDailyLimit(t.slug, attempt);
    const wait = retryWaitS(attempt);
    if (wait !== null) {
      log.warn(
        { cycleId, toolSlug: t.slug, waitS: wait },
        'the model or the API is rate limited; waiting once before retrying',
      );
      await deps.sleep(wait * 1000);
      attempt = await askCompile(t, extraction, true);
      noteDailyLimit(t.slug, attempt);
    }

    if (attempt.kind === 'response') return toPlanned(attempt.response, extraction);
    log.error(
      { cycleId, toolSlug: t.slug, err: messageOf(attempt.err) },
      'compile call failed; deferring the tool',
    );
    // The call failing says nothing about the tool or its plan. A plain skip, unless the API can still
    // hand us the cache or the stale plan without the model.
    return attempt.kind === 'http'
      ? deferWithoutModel('llm_unavailable')
      : { state: 'deferred', reason: 'llm_unavailable' };
  }

  // ---- phase 1: crawl everything, concurrently (4 at a time, one page per domain)
  const crawledReal = new Map<string, Extraction>();
  await Promise.all(
    selected.map(async ({ target: t }) => {
      if (t.slug.startsWith('canary-')) {
        planned.set(t.slug, await planCanary(t));
        return;
      }
      const result = await crawlReal(t);
      if ('failed' in result) planned.set(t.slug, result.failed);
      else crawledReal.set(t.slug, result.extraction);
    }),
  );

  // ---- phase 2: compile one tool at a time, in slug order, inside a 15-minute cap
  const phaseStart = deps.now().getTime();
  const bySlug = new Map(selected.map(({ target: t }) => [t.slug, t]));
  for (const slug of [...crawledReal.keys()].sort()) {
    const outOfTime = deps.now().getTime() - phaseStart >= COMPILE_PHASE_LIMIT_MS;
    planned.set(
      slug,
      await compileReal(bySlug.get(slug) as Target, crawledReal.get(slug) as Extraction, outOfTime),
    );
  }

  // ---- shards: over the tools that will actually run
  const shardTools: ShardTool[] = selected
    .filter(({ target: t }) => planned.get(t.slug)?.state === 'ready')
    .map(({ target: t, cycleTool }) => ({
      slug: t.slug,
      isCanary: cycleTool.isCanary,
      weightMs: cycleTool.lastDurationMs,
    }));
  const shards = options.shards ?? defaultShardCount(shardTools.length);
  const { primary, guards } = assignShards(shardTools, shards);

  // ---- files
  await mkdir(options.out, { recursive: true });
  const manifestTools: ManifestTool[] = [];
  for (const { target: t, cycleTool } of [...selected].sort((a, b) =>
    a.target.slug < b.target.slug ? -1 : 1,
  )) {
    const p = planned.get(t.slug) as Planned;
    const common = {
      version: PROBE_FILE_VERSION,
      toolSlug: t.slug,
      cycleId,
      isCanary: cycleTool.isCanary,
      target: t,
      weightMs: cycleTool.lastDurationMs,
    } as const;
    const file: PlanFile =
      p.state === 'ready'
        ? { ...common, state: 'ready', shard: primary[t.slug] as number, plan: p.plan }
        : p.state === 'pre_failed'
          ? {
              ...common,
              state: 'pre_failed',
              preflight: p.preflight,
              planId: p.planId,
              snapshotHash: p.snapshotHash,
            }
          : { ...common, state: 'deferred', reason: p.reason };
    await writeFile(path.join(options.out, `${t.slug}.json`), `${JSON.stringify(file, null, 2)}\n`);
    manifestTools.push({
      toolSlug: t.slug,
      state: p.state,
      shard: p.state === 'ready' ? (primary[t.slug] as number) : null,
      stale: p.state === 'ready' && p.plan.stale,
      isCanary: cycleTool.isCanary,
    });
  }
  const manifest: Manifest = {
    version: PROBE_FILE_VERSION,
    cycleId,
    createdAt: deps.now().toISOString(),
    shards,
    guards,
    tools: manifestTools,
  };
  await writeFile(path.join(options.out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  await deps.writeOutput('cycle', cycleId);
  await deps.writeOutput('shards', JSON.stringify(Array.from({ length: shards }, (_, i) => i)));
  await deps.writeSummary(renderPlanSummary(manifest, planned));
  log.info(
    {
      cycleId,
      shards,
      ready: manifestTools.filter((t) => t.state === 'ready').length,
      stale: manifestTools.filter((t) => t.stale).length,
      preFailed: manifestTools.filter((t) => t.state === 'pre_failed').length,
      deferred: manifestTools.filter((t) => t.state === 'deferred').length,
    },
    'plan written',
  );
  return { cycleId, shards, manifest };
}

function renderPlanSummary(manifest: Manifest, planned: ReadonlyMap<string, Planned>): string {
  const rows = manifest.tools
    .filter((t) => !t.isCanary)
    .map((t) => {
      const p = planned.get(t.toolSlug) as Planned;
      const [plan, note] =
        p.state === 'ready'
          ? [
              p.plan.stale ? 'stale plan' : 'ready',
              p.plan.stale ? 'the model was not asked; last accepted plan' : '',
            ]
          : p.state === 'pre_failed'
            ? [p.preflight.failureClass, `${p.preflight.reason}: ${p.preflight.message}`]
            : ['skipped', `deferred: ${p.reason}`];
      const cleaned = note.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, ' ');
      return `| ${t.toolSlug} | ${plan} | ${t.shard ?? '-'} | ${cleaned} |`;
    });
  const canaries = manifest.tools.filter((t) => t.isCanary).length;
  return [
    `### Probe plan for cycle ${manifest.cycleId}`,
    '',
    `${manifest.shards} shard${manifest.shards === 1 ? '' : 's'}, ${canaries} canaries.`,
    '',
    '| Tool | Plan | Shard | Note |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
