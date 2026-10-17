import { desc, eq, inArray } from 'drizzle-orm';
import type { LaunchExport } from '@qsr/core';
import { incidents, probeCycles, runs, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';

// GET /admin/export/launch (P9a): the numbers a launch post needs. The only incidents it reads are the ones a
// person REVIEWED AND CONFIRMED (the query selects review = 'CONFIRMED', and the LaunchExport schema admits nothing
// else), so a pending or false-positive incident cannot appear in it: not its text, not even a count.

const HOUR = 3600_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** true when the dependency versions changed between the last passing run and the first failing one. */
function dependencyChanged(diff: unknown): boolean | null {
  if (diff === null || typeof diff !== 'object') return null;
  const d = diff as { changed?: unknown; added?: unknown; removed?: unknown };
  const size = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return size(d.changed) + size(d.added) + size(d.removed) > 0;
}

export async function loadLaunchExport(ctx: Ctx): Promise<LaunchExport> {
  const { db, deps } = ctx;

  const toolRows = await db.select().from(tools);
  const real = toolRows.filter((t) => t.isCanary !== true);
  const bySlug = new Map(toolRows.map((t) => [t.id, t]));

  const cycles = await db.select().from(probeCycles);
  const finished = cycles.filter((c) => c.finishedAt !== null);
  const validCycles = finished.filter((c) => c.valid === true);
  const validIds = new Set(validCycles.map((c) => c.id));

  const finals = (
    await db
      .selectDistinctOn([runs.cycleId, runs.toolId], {
        id: runs.id,
        cycleId: runs.cycleId,
        toolId: runs.toolId,
        outcome: runs.outcome,
        reachedLevel: runs.reachedLevel,
        classifierRule: runs.classifierRule,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .orderBy(runs.cycleId, runs.toolId, desc(runs.attempt))
  ).filter(
    (f) =>
      validIds.has(f.cycleId) &&
      f.classifierRule !== 'preflight' &&
      bySlug.get(f.toolId)?.isCanary !== true,
  );

  // the level each enabled tool's latest run reached
  const enabled = real.filter((t) => t.enabled);
  let l3 = 0;
  let l2 = 0;
  let l1 = 0;
  let never = 0;
  for (const t of enabled) {
    const latest = finals
      .filter((f) => f.toolId === t.id)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (!latest) never += 1;
    else if (latest.reachedLevel >= 3) l3 += 1;
    else if (latest.reachedLevel === 2) l2 += 1;
    else l1 += 1;
  }

  const perTool = real
    .map((t) => {
      const mine = finals.filter((f) => f.toolId === t.id);
      return {
        slug: t.slug,
        runs: mine.length,
        passes: mine.filter((f) => f.outcome === 'PASS').length,
        fails: mine.filter((f) => f.outcome === 'FAIL').length,
      };
    })
    .filter((t) => t.runs > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));

  // ---- the incidents a person confirmed, and only those
  const confirmed = await db
    .select({
      id: incidents.id,
      toolId: incidents.toolId,
      failureClass: incidents.failureClass,
      state: incidents.state,
      review: incidents.review,
      openedAt: incidents.openedAt,
      confirmedAt: incidents.confirmedAt,
      resolvedAt: incidents.resolvedAt,
      firstFailingRunId: incidents.firstFailingRunId,
      docsChanged: incidents.docsChanged,
      docsDiffPath: incidents.docsDiffPath,
      versionDiff: incidents.versionDiff,
      summary: incidents.summary,
      suggestedFix: incidents.suggestedFix,
    })
    .from(incidents)
    .where(eq(incidents.review, 'CONFIRMED'))
    .orderBy(desc(incidents.openedAt));

  const firstFailingIds = confirmed
    .map((i) => i.firstFailingRunId)
    .filter((x): x is string => x !== null);
  const failingRuns =
    firstFailingIds.length === 0
      ? []
      : await db
          .select({ id: runs.id, startedAt: runs.startedAt })
          .from(runs)
          .where(inArray(runs.id, firstFailingIds));
  const startedAt = new Map(failingRuns.map((r) => [r.id, r.startedAt]));

  const byFailureClass: Record<string, number> = {};
  const coincidence = { docsOnly: 0, dependencyOnly: 0, both: 0, neither: 0, unknown: 0 };
  const toDetect: number[] = [];
  const toConfirm: number[] = [];
  const list: LaunchExport['incidents']['list'] = [];
  for (const i of confirmed) {
    byFailureClass[i.failureClass] = (byFailureClass[i.failureClass] ?? 0) + 1;
    const dependency = dependencyChanged(i.versionDiff);
    if (i.docsChanged === true && dependency === true) coincidence.both += 1;
    else if (i.docsChanged === true && dependency !== true) coincidence.docsOnly += 1;
    else if (dependency === true) coincidence.dependencyOnly += 1;
    else if (i.docsChanged === false && dependency === false) coincidence.neither += 1;
    else coincidence.unknown += 1;
    const first = i.firstFailingRunId ? startedAt.get(i.firstFailingRunId) : undefined;
    if (first) toDetect.push((i.openedAt.getTime() - first.getTime()) / HOUR);
    if (i.confirmedAt) toConfirm.push((i.confirmedAt.getTime() - i.openedAt.getTime()) / HOUR);
    const tool = bySlug.get(i.toolId);
    list.push({
      id: i.id,
      slug: tool?.slug ?? 'unknown',
      name: tool?.name ?? 'unknown',
      review: 'CONFIRMED',
      failureClass: i.failureClass,
      state: i.state,
      openedAt: i.openedAt.toISOString(),
      confirmedAt: i.confirmedAt?.toISOString() ?? null,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      docsChanged: i.docsChanged,
      dependencyChanged: dependency,
      summary: i.summary,
      suggestedFix: i.suggestedFix,
      toolPath: `/tools/${tool?.slug ?? 'unknown'}`,
      firstFailingRunPath: i.firstFailingRunId ? `/runs/${i.firstFailingRunId}` : null,
      docsDiffPath: i.docsDiffPath,
    });
  }

  const starts = validCycles.map((c) => c.startedAt.getTime());
  return {
    generatedAt: deps.now().toISOString(),
    tools: {
      tracked: enabled.length,
      testedAtL3: l3,
      testedAtL2: l2,
      testedAtL1: l1,
      notYetRun: never,
    },
    cycles: {
      valid: validCycles.length,
      invalid: finished.filter((c) => c.valid === false).length,
      firstAt: starts.length === 0 ? null : new Date(Math.min(...starts)).toISOString(),
      lastAt: starts.length === 0 ? null : new Date(Math.max(...starts)).toISOString(),
    },
    runs: { total: finals.length, perTool },
    incidents: {
      confirmed: confirmed.length,
      byFailureClass,
      coincidence,
      medianHoursToDetect: median(toDetect),
      medianHoursToConfirm: median(toConfirm),
      list,
    },
  };
}
