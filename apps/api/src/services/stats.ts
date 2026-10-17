import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { CANARY_EXPECTATIONS, FREE_TIER, type CanarySlug, type StatsResponse } from '@qsr/core';
import {
  adminQueueItems,
  incidents,
  llmCalls,
  probeCycles,
  runs,
  stepResults,
  tools,
} from '@qsr/db';
import type { Ctx } from '../deps.js';

// GET /admin/stats?days=N (P9a): the numbers the calibration review reads. Everything here is read-only and
// computed from the tables the pipeline already fills; nothing is stored. Per-tool counts use only VALID cycles
// (the status engine ignores the others, so the review must too); the harness error rate looks at every finished
// cycle, because a harness that is failing is exactly what an invalid cycle can hide.

const DAY = 24 * 3600 * 1000;
const MAX_RECENT_CYCLES = 50;
const MAX_LIST = 200;
const SLOWEST = 10;

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const rate = (errors: number, runsCount: number): number =>
  runsCount === 0 ? 0 : errors / runsCount;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Pass/fail alternations over the decided runs, as a share of the possible ones. */
function flake(decided: readonly ('PASS' | 'FAIL')[]): { score: number; alternations: number } {
  if (decided.length < 3) return { score: 0, alternations: 0 };
  let alternations = 0;
  for (let i = 1; i < decided.length; i += 1) if (decided[i] !== decided[i - 1]) alternations += 1;
  return { score: alternations / (decided.length - 1), alternations };
}

const lastLine = (text: string | null): string | null => {
  const lines = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? line.slice(0, 300) : null;
};

export async function loadStats(ctx: Ctx, days: number): Promise<StatsResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const since = new Date(now.getTime() - days * DAY);

  // ---- cycles in the window
  const cycles = await db
    .select()
    .from(probeCycles)
    .where(gte(probeCycles.startedAt, since))
    .orderBy(desc(probeCycles.startedAt));
  const cycleById = new Map(cycles.map((c) => [c.id, c]));

  // ---- the final attempt of every (cycle, tool) in those cycles
  const finals = await db
    .selectDistinctOn([runs.cycleId, runs.toolId], {
      id: runs.id,
      cycleId: runs.cycleId,
      toolId: runs.toolId,
      outcome: runs.outcome,
      failureClass: runs.failureClass,
      classifierRule: runs.classifierRule,
      failedStepId: runs.failedStepId,
      durationMs: runs.durationMs,
      startedAt: runs.startedAt,
      stale: sql<string | null>`${runs.runnerEnv}->>'plan_stale'`,
    })
    .from(runs)
    .innerJoin(probeCycles, eq(probeCycles.id, runs.cycleId))
    .where(gte(probeCycles.startedAt, since))
    .orderBy(runs.cycleId, runs.toolId, desc(runs.attempt));

  const toolRows = await db.select().from(tools);
  const toolById = new Map(toolRows.map((t) => [t.id, t]));
  const isCanary = (toolId: string): boolean => toolById.get(toolId)?.isCanary === true;
  const preflight = (f: (typeof finals)[number]): boolean => f.classifierRule === 'preflight';

  const real = finals.filter((f) => !isCanary(f.toolId));
  const finished = (cycleId: string): boolean => cycleById.get(cycleId)?.finishedAt != null;
  const inValidCycle = (cycleId: string): boolean => cycleById.get(cycleId)?.valid === true;

  // ---- the harness error rate: real tools that ran, in every finished cycle
  const ran = real.filter((f) => finished(f.cycleId) && !preflight(f));
  const harnessErrors = ran.filter((f) => f.outcome === 'HARNESS_ERROR').length;
  const byDay = new Map<string, { runs: number; errors: number }>();
  for (const f of ran) {
    const key = dayOf(f.startedAt);
    const entry = byDay.get(key) ?? { runs: 0, errors: 0 };
    entry.runs += 1;
    if (f.outcome === 'HARNESS_ERROR') entry.errors += 1;
    byDay.set(key, entry);
  }

  // ---- deferrals and model classifications (admin queue items)
  const queue = await db
    .select({
      reason: adminQueueItems.reason,
      toolId: adminQueueItems.toolId,
      runId: adminQueueItems.runId,
      detail: adminQueueItems.detail,
      createdAt: adminQueueItems.createdAt,
    })
    .from(adminQueueItems)
    .where(
      and(
        gte(adminQueueItems.createdAt, since),
        inArray(adminQueueItems.reason, ['compile_deferred', 'llm_classified']),
      ),
    )
    .orderBy(adminQueueItems.createdAt);
  const deferralsBySlug = new Map<string, Record<string, number>>();
  const deferredCount = new Map<string, number>();
  for (const q of queue.filter((x) => x.reason === 'compile_deferred')) {
    const slug = q.toolId ? toolById.get(q.toolId)?.slug : undefined;
    if (!slug) continue;
    const why = String((q.detail as { reason?: unknown } | null)?.reason ?? 'unknown');
    const reasons = deferralsBySlug.get(slug) ?? {};
    reasons[why] = (reasons[why] ?? 0) + 1;
    deferralsBySlug.set(slug, reasons);
    deferredCount.set(slug, (deferredCount.get(slug) ?? 0) + 1);
  }

  // ---- per tool, from valid cycles
  const validReal = real.filter((f) => inValidCycle(f.cycleId));
  const perTool = toolRows
    .filter((t) => t.isCanary !== true)
    .map((t) => {
      const mine = validReal
        .filter((f) => f.toolId === t.id)
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const executed = mine.filter((f) => !preflight(f));
      const decided = executed.filter((f) => f.outcome === 'PASS' || f.outcome === 'FAIL');
      const flakiness = flake(decided.map((f) => f.outcome as 'PASS' | 'FAIL'));
      const durations = executed.map((f) => f.durationMs).filter((ms) => ms > 0);
      return {
        slug: t.slug,
        name: t.name,
        enabled: t.enabled,
        level: t.level,
        status: t.status,
        pass: executed.filter((f) => f.outcome === 'PASS').length,
        fail: executed.filter((f) => f.outcome === 'FAIL').length,
        skipped: executed.filter((f) => f.outcome === 'SKIPPED').length,
        harnessErrors: executed.filter((f) => f.outcome === 'HARNESS_ERROR').length,
        notRun: mine.filter(preflight).length,
        deferred: deferredCount.get(t.slug) ?? 0,
        staleRuns: executed.filter((f) => f.stale === 'true').length,
        flakeScore: flakiness.score,
        flipping: flakiness.alternations >= 2,
        medianDurationMs: median(durations),
        maxDurationMs: durations.length === 0 ? null : Math.max(...durations),
        _runs: executed.length + mine.filter(preflight).length,
      };
    })
    .filter((t) => t.enabled || t._runs > 0 || (deferredCount.get(t.slug) ?? 0) > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map(({ _runs, ...rest }) => {
      void _runs;
      return rest;
    });

  // ---- UNKNOWN failures with the last line of what the failing step printed
  const unknownFinals = validReal
    .filter((f) => f.failureClass === 'UNKNOWN' && !preflight(f))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .slice(0, MAX_LIST);
  const steps =
    unknownFinals.length === 0
      ? []
      : await db
          .select({
            runId: stepResults.runId,
            stepId: stepResults.stepId,
            outcome: stepResults.outcome,
            stdoutTail: stepResults.stdoutTail,
            stderrTail: stepResults.stderrTail,
          })
          .from(stepResults)
          .where(
            inArray(
              stepResults.runId,
              unknownFinals.map((f) => f.id),
            ),
          );
  const unknowns = unknownFinals.map((f) => {
    const failing = steps.filter((s) => s.runId === f.id && s.outcome === 'FAIL');
    const step = failing.find((s) => s.stepId === f.failedStepId) ?? failing[failing.length - 1];
    return {
      runId: f.id,
      slug: toolById.get(f.toolId)?.slug ?? 'unknown',
      startedAt: f.startedAt.toISOString(),
      failedStepId: f.failedStepId,
      evidenceLine: step ? (lastLine(step.stderrTail) ?? lastLine(step.stdoutTail)) : null,
    };
  });

  const llmClassified = queue
    .filter((q) => q.reason === 'llm_classified')
    .slice(0, MAX_LIST)
    .map((q) => {
      const detail = (q.detail ?? {}) as {
        failureClass?: unknown;
        confidence?: unknown;
        evidenceLine?: unknown;
      };
      return {
        runId: q.runId,
        slug: q.toolId ? (toolById.get(q.toolId)?.slug ?? null) : null,
        createdAt: q.createdAt.toISOString(),
        failureClass: typeof detail.failureClass === 'string' ? detail.failureClass : null,
        confidence: typeof detail.confidence === 'number' ? detail.confidence : null,
        evidenceLine: typeof detail.evidenceLine === 'string' ? detail.evidenceLine : null,
      };
    });

  // ---- model calls
  const calls = await db
    .select()
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, since))
    .orderBy(llmCalls.createdAt);
  const groqByDay = new Map<string, { calls: number; failedCalls: number; tokens: number }>();
  for (const c of calls) {
    const key = dayOf(c.createdAt);
    const entry = groqByDay.get(key) ?? { calls: 0, failedCalls: 0, tokens: 0 };
    entry.calls += 1;
    if (!c.ok) entry.failedCalls += 1;
    entry.tokens += (c.tokensIn ?? 0) + (c.tokensOut ?? 0);
    groqByDay.set(key, entry);
  }

  // ---- incidents: opened in the window, or still open
  const incidentRows = await db
    .select({
      id: incidents.id,
      toolId: incidents.toolId,
      state: incidents.state,
      review: incidents.review,
      failureClass: incidents.failureClass,
      openedAt: incidents.openedAt,
      confirmedAt: incidents.confirmedAt,
      resolvedAt: incidents.resolvedAt,
      docsChanged: incidents.docsChanged,
    })
    .from(incidents)
    .where(or(gte(incidents.openedAt, since), eq(incidents.state, 'OPEN')))
    .orderBy(desc(incidents.openedAt))
    .limit(MAX_LIST);

  // ---- canaries, against what each must do
  const canaryStats = new Map<string, { runs: number; matched: number }>();
  for (const f of finals.filter((x) => isCanary(x.toolId) && finished(x.cycleId))) {
    const slug = toolById.get(f.toolId)?.slug ?? '';
    const expected = CANARY_EXPECTATIONS[slug as CanarySlug];
    if (!expected) continue;
    const entry = canaryStats.get(slug) ?? { runs: 0, matched: 0 };
    entry.runs += 1;
    if (
      f.outcome === expected.outcome &&
      (expected.failureClass === null || f.failureClass === expected.failureClass)
    )
      entry.matched += 1;
    canaryStats.set(slug, entry);
  }

  // ---- storage
  const dbSize = await db.execute(
    sql`select pg_database_size(current_database())::bigint as bytes`,
  );
  const bytes = Number((dbSize[0] as { bytes: string | number } | undefined)?.bytes ?? 0);
  const tableRows = await db.execute(
    sql`select relname as name, n_live_tup::bigint as rows, pg_total_relation_size(relid)::bigint as bytes
        from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 12`,
  );
  let objects: StatsResponse['storage']['objects'] = null;
  try {
    // Supabase keeps its object metadata in the storage schema of the same database; a plain Postgres has none.
    const rows = await db.execute(
      sql`select bucket_id, count(*)::bigint as n, coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
          from storage.objects group by bucket_id`,
    );
    const of = (bucket: string) => {
      const row = (rows as unknown as { bucket_id: string; n: string; bytes: string }[]).find(
        (r) => r.bucket_id === bucket,
      );
      return { count: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
    };
    const pub = of('public-artifacts');
    const priv = of('private-artifacts');
    const totalBytes = pub.bytes + priv.bytes;
    objects = {
      publicBytes: pub.bytes,
      privateBytes: priv.bytes,
      publicCount: pub.count,
      privateCount: priv.count,
      totalBytes,
      limitBytes: FREE_TIER.storageBytes,
      targetBytes: FREE_TIER.storageTargetBytes,
      percent: (totalBytes / FREE_TIER.storageBytes) * 100,
    };
  } catch {
    objects = null;
  }

  const slowest = perTool
    .filter((t) => t.medianDurationMs !== null)
    .sort((a, b) => (b.medianDurationMs as number) - (a.medianDurationMs as number))
    .slice(0, SLOWEST)
    .map((t) => ({
      slug: t.slug,
      medianDurationMs: t.medianDurationMs as number,
      maxDurationMs: t.maxDurationMs as number,
    }));

  return {
    generatedAt: now.toISOString(),
    days,
    since: since.toISOString(),
    cycles: {
      total: cycles.length,
      valid: cycles.filter((c) => c.valid === true).length,
      invalid: cycles.filter((c) => c.valid === false).length,
      unfinished: cycles.filter((c) => c.finishedAt === null).length,
      recent: cycles.slice(0, MAX_RECENT_CYCLES).map((c) => {
        const inCycle = real.filter((f) => f.cycleId === c.id);
        const finish = c.finishResult as { canaryProblems?: unknown } | null;
        return {
          id: c.id,
          startedAt: c.startedAt.toISOString(),
          trigger: c.trigger,
          valid: c.valid,
          canaryOk: c.canaryOk,
          durationSeconds:
            c.finishedAt === null
              ? null
              : Math.round((c.finishedAt.getTime() - c.startedAt.getTime()) / 1000),
          tools: inCycle.length,
          harnessErrors: inCycle.filter((f) => f.outcome === 'HARNESS_ERROR').length,
          problems: Array.isArray(finish?.canaryProblems)
            ? (finish.canaryProblems as unknown[]).filter((p): p is string => typeof p === 'string')
            : [],
        };
      }),
    },
    harness: {
      overall: { runs: ran.length, errors: harnessErrors, rate: rate(harnessErrors, ran.length) },
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, v]) => ({ day, runs: v.runs, errors: v.errors, rate: rate(v.errors, v.runs) })),
    },
    tools: perTool,
    unknowns,
    llmClassified,
    compile: {
      deferrals: [...deferralsBySlug.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([slug, reasons]) => ({
          slug,
          count: Object.values(reasons).reduce((a, b) => a + b, 0),
          reasons,
        })),
      staleRuns: perTool.reduce((sum, t) => sum + t.staleRuns, 0),
      llm: {
        calls: calls.length,
        failedCalls: calls.filter((c) => !c.ok).length,
        tokensIn: calls.reduce((s, c) => s + (c.tokensIn ?? 0), 0),
        tokensOut: calls.reduce((s, c) => s + (c.tokensOut ?? 0), 0),
      },
    },
    incidents: {
      open: incidentRows.filter((i) => i.state === 'OPEN').length,
      resolved: incidentRows.filter((i) => i.state === 'RESOLVED').length,
      confirmed: incidentRows.filter((i) => i.review === 'CONFIRMED').length,
      falsePositive: incidentRows.filter((i) => i.review === 'FALSE_POSITIVE').length,
      pendingReview: incidentRows.filter((i) => i.review === 'PENDING_REVIEW').length,
      list: incidentRows.map((i) => ({
        id: i.id,
        slug: toolById.get(i.toolId)?.slug ?? 'unknown',
        state: i.state,
        review: i.review,
        failureClass: i.failureClass,
        openedAt: i.openedAt.toISOString(),
        confirmedAt: i.confirmedAt?.toISOString() ?? null,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        docsChanged: i.docsChanged,
      })),
    },
    canaries: [...canaryStats.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([slug, v]) => ({
        slug,
        runs: v.runs,
        expected: CANARY_EXPECTATIONS[slug as CanarySlug].outcome,
        matched: v.matched,
        mismatched: v.runs - v.matched,
      })),
    slowest,
    groq: [...groqByDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, v]) => ({ day, ...v })),
    storage: {
      database: {
        bytes,
        limitBytes: FREE_TIER.databaseBytes,
        percent: (bytes / FREE_TIER.databaseBytes) * 100,
      },
      tables: (tableRows as unknown as { name: string; rows: string; bytes: string }[]).map(
        (r) => ({
          name: r.name,
          rows: Number(r.rows),
          bytes: Number(r.bytes),
        }),
      ),
      objects,
    },
  };
}
