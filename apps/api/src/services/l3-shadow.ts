import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  L3_SHADOW_CLEAN_CYCLES,
  ShadowL3,
  Target,
  type L3ShadowReportResponse,
  type L3ShadowToolRow,
} from '@qsr/core';
import { probeCycles, runs, stepResults, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';

// GET /admin/l3-shadow?days=N. The L3 step of a shadow-L3 target runs in the executor (once per cycle, last) and its answer is recorded on
// the last step of the run. This is the ONE reader of those records: nothing here (or anywhere) may feed a shadow answer into a
// classification, a status, an incident, a queue item, a level or a public view. Promotion out of shadow is a person's decision; the
// verdict below only says whether the evidence is there.

const DAY_MS = 24 * 60 * 60 * 1000;
const OBSERVED_LISTED = 5;

const lastAt = (records: readonly { at: Date }[]): string | null => {
  let latest: Date | null = null;
  for (const r of records) if (latest === null || r.at > latest) latest = r.at;
  return latest === null ? null : latest.toISOString();
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function loadL3ShadowReport(ctx: Ctx, days: number): Promise<L3ShadowReportResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const since = new Date(now.getTime() - days * DAY_MS);

  // Final attempts of real tools in valid cycles of the window.
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
      ),
    )
    .orderBy(desc(runs.attempt));
  const finals = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.cycleId}|${r.toolId}`;
    if (!finals.has(key)) finals.set(key, r);
  }
  const final = [...finals.values()];

  const recordByRun = new Map<string, ShadowL3>();
  if (final.length > 0) {
    const stored = await db
      .select({ runId: stepResults.runId, shadow: stepResults.shadowL3 })
      .from(stepResults)
      .where(
        and(
          inArray(
            stepResults.runId,
            final.map((f) => f.runId),
          ),
          isNotNull(stepResults.shadowL3),
        ),
      );
    for (const s of stored) {
      const parsed = ShadowL3.safeParse(s.shadow);
      if (parsed.success) recordByRun.set(s.runId, parsed.data);
    }
  }

  type Acc = {
    slug: string;
    reason: string | null;
    cycles: number;
    records: { at: Date; rec: ShadowL3 }[];
  };
  const per = new Map<string, Acc>();
  for (const f of final) {
    const cfg = Target.safeParse(f.config);
    const reason = cfg.success ? (cfg.data.l3?.reason ?? null) : null;
    const rec = recordByRun.get(f.runId);
    // Only shadow targets (by their stored config) and anything that has recorded a result.
    if (reason === null && rec === undefined) continue;
    const acc = per.get(f.slug) ?? { slug: f.slug, reason, cycles: 0, records: [] };
    acc.cycles += 1;
    if (rec) acc.records.push({ at: f.startedAt, rec });
    per.set(f.slug, acc);
  }

  const toolRows: L3ShadowToolRow[] = [...per.values()]
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((acc) => {
      const verdicts: Record<string, number> = {};
      const patterns = new Map<string, number>();
      const observed = new Map<string, number>();
      for (const { rec } of acc.records) {
        verdicts[rec.verdict] = (verdicts[rec.verdict] ?? 0) + 1;
        if (rec.pattern !== null) patterns.set(rec.pattern, (patterns.get(rec.pattern) ?? 0) + 1);
        if (rec.observed !== null)
          observed.set(rec.observed, (observed.get(rec.observed) ?? 0) + 1);
      }
      const evidence = acc.records.filter((r) => r.rec.verdict === 'evidence');
      const ambiguous = acc.records.length - evidence.length;
      const patternList = [...patterns.entries()]
        .map(([pattern, cycles]) => ({ pattern, cycles }))
        .sort((a, b) => b.cycles - a.cycles || (a.pattern < b.pattern ? -1 : 1));
      const evidencePatterns = new Set(evidence.map((r) => r.rec.pattern));

      const blockers: string[] = [];
      if (acc.records.length < L3_SHADOW_CLEAN_CYCLES)
        blockers.push(
          `only ${plural(acc.records.length, 'cycle', 'cycles')} with a record (need ${L3_SHADOW_CLEAN_CYCLES})`,
        );
      if (ambiguous > 0)
        blockers.push(`${plural(ambiguous, 'result', 'results')} without evidence`);
      if (evidencePatterns.size > 1)
        blockers.push(
          `different evidence between cycles (${[...evidencePatterns].sort().join(', ')})`,
        );
      const missing = acc.cycles - acc.records.length;
      if (missing > 0) blockers.push(`${plural(missing, 'cycle', 'cycles')} ran without a record`);

      return {
        slug: acc.slug,
        reason: acc.reason,
        cycles: acc.cycles,
        withRecord: acc.records.length,
        verdicts,
        patterns: patternList,
        observed: [...observed.entries()]
          .map(([text, cycles]) => ({ text, cycles }))
          .sort((a, b) => b.cycles - a.cycles || (a.text < b.text ? -1 : 1))
          .slice(0, OBSERVED_LISTED),
        ambiguous,
        lastAt: lastAt(acc.records),
        promotion: { ready: blockers.length === 0, cleanCycles: evidence.length, blockers },
      };
    });

  return {
    generatedAt: now.toISOString(),
    days,
    since: since.toISOString(),
    tools: toolRows,
  };
}
