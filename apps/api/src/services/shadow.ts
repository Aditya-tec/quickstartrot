import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  ShadowExportCheck,
  Target,
  type ShadowReportResponse,
  type ShadowToolRow,
} from '@qsr/core';
import { probeCycles, runs, stepResults, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';

// GET /admin/shadow?days=N (P9d). The experimental export check runs in shadow mode in every production execute job and its answer
// is recorded on the imports-check step. This is the ONE reader of those records: nothing here (or anywhere) may feed a shadow
// answer into a classification, a status, an incident, a queue item or a public view. P9b reads this report to decide whether to
// promote the check; promoting it is a decision, not something a report does.

const DAY_MS = 24 * 60 * 60 * 1000;
/** The first harness version that records shadow results. */
const FIRST_SHADOW_VERSION = 2;

const byCyclesThenName = (
  a: { name: string; cycles: number },
  b: { name: string; cycles: number },
): number => b.cycles - a.cycles || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function loadShadowReport(ctx: Ctx, days: number): Promise<ShadowReportResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const since = new Date(now.getTime() - days * DAY_MS);

  // Final attempts of real tools in valid cycles of the window, from a harness that records shadow results.
  const rows = await db
    .select({
      runId: runs.id,
      cycleId: runs.cycleId,
      attempt: runs.attempt,
      toolId: runs.toolId,
      slug: tools.slug,
      config: tools.config,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .innerJoin(tools, eq(tools.id, runs.toolId))
    .innerJoin(probeCycles, eq(probeCycles.id, runs.cycleId))
    .where(
      and(
        gte(probeCycles.startedAt, since),
        eq(probeCycles.valid, true),
        eq(tools.isCanary, false),
        gte(runs.harnessVersion, FIRST_SHADOW_VERSION),
      ),
    )
    .orderBy(desc(runs.attempt));
  const finals = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.cycleId}|${r.toolId}`;
    if (!finals.has(key)) finals.set(key, r);
  }
  const final = [...finals.values()];

  const shadowByRun = new Map<string, ShadowExportCheck>();
  if (final.length > 0) {
    const stored = await db
      .select({ runId: stepResults.runId, shadow: stepResults.shadowExportCheck })
      .from(stepResults)
      .where(
        and(
          inArray(
            stepResults.runId,
            final.map((f) => f.runId),
          ),
          isNotNull(stepResults.shadowExportCheck),
        ),
      );
    for (const s of stored) {
      const parsed = ShadowExportCheck.safeParse(s.shadow);
      if (parsed.success) shadowByRun.set(s.runId, parsed.data);
    }
  }

  const perTool = new Map<
    string,
    ShadowToolRow & { names: Map<string, number>; failSets: string[][]; checked: number }
  >();
  for (const f of final) {
    const optOut = Target.safeParse(f.config);
    const row = perTool.get(f.slug) ?? {
      slug: f.slug,
      optOut: optOut.success ? (optOut.data.harness?.reason ?? null) : null,
      cycles: 0,
      withShadow: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      missing: [],
      notes: [],
      lastFailAt: null,
      names: new Map<string, number>(),
      failSets: [],
      checked: 0,
    };
    row.cycles += 1;
    const shadow = shadowByRun.get(f.runId);
    if (shadow) {
      row.withShadow += 1;
      row[shadow.outcome] += 1;
      if (shadow.outcome !== 'skipped') row.checked += 1;
      if (shadow.note && !row.notes.includes(shadow.note)) row.notes.push(shadow.note);
      if (shadow.outcome === 'fail') {
        for (const name of new Set(shadow.missing))
          row.names.set(name, (row.names.get(name) ?? 0) + 1);
        row.failSets.push([...new Set(shadow.missing)].sort());
        const at = f.startedAt.toISOString();
        if (row.lastFailAt === null || at > row.lastFailAt) row.lastFailAt = at;
      }
    }
    perTool.set(f.slug, row);
  }

  const toolRows = [...perTool.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const candidates: ShadowReportResponse['falsePositiveCandidates'] = [];
  for (const r of toolRows) {
    r.missing = [...r.names.entries()]
      .map(([name, cycles]) => ({ name, cycles }))
      .sort(byCyclesThenName);
    if (r.fail === 0) continue;
    const sameNames = r.failSets.every((s) => JSON.stringify(s) === JSON.stringify(r.failSets[0]));
    const stable = r.fail === r.checked && sameNames;
    candidates.push({
      slug: r.slug,
      failCycles: r.fail,
      checkedCycles: r.checked,
      stable,
      missing: r.missing.map((m) => m.name),
      reason: stable
        ? `failed in every cycle it was checked (${r.fail} of ${r.checked}) with the same names: a fact about the page or the plan (a real docs problem, or a systematic false positive such as a type imported into a JavaScript file); read the docs snippet`
        : `failed in ${r.fail} of ${r.checked} checked cycles: intermittent, so look at the environment (a package that loads differently, a registry change) before the docs`,
    });
  }

  const totals = {
    cycles: new Set(final.map((f) => f.cycleId)).size,
    runs: final.length,
    withShadow: toolRows.reduce((n, r) => n + r.withShadow, 0),
    pass: toolRows.reduce((n, r) => n + r.pass, 0),
    fail: toolRows.reduce((n, r) => n + r.fail, 0),
    skipped: toolRows.reduce((n, r) => n + r.skipped, 0),
  };
  return {
    generatedAt: now.toISOString(),
    days,
    since: since.toISOString(),
    totals,
    tools: toolRows.map((r) => ({
      slug: r.slug,
      optOut: r.optOut,
      cycles: r.cycles,
      withShadow: r.withShadow,
      pass: r.pass,
      fail: r.fail,
      skipped: r.skipped,
      missing: r.missing,
      notes: r.notes,
      lastFailAt: r.lastFailAt,
    })),
    falsePositiveCandidates: candidates,
  };
}
