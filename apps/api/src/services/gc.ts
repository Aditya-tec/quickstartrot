import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { PIPELINE, type GcResponse, type Logger } from '@qsr/core';
import { incidents, runs, stepResults } from '@qsr/db';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';
import { PRIVATE_BUCKET, PUBLIC_BUCKET } from '../storage.js';

// POST /admin/gc (spec section 5, "Storage"), called by the nightly workflow:
//   public-artifacts:  redacted step logs and docs diffs live 30 days, except those an incident links (kept);
//   private-artifacts: Playwright traces live 14 days.
// Objects are removed first and the database pointers are cleared only after that succeeded, so a storage
// failure never leaves a row that points at a file that is gone.

const DAY = 24 * 60 * 60 * 1000;
export const LOG_RETENTION_DAYS = PIPELINE.logRetentionDays;
export const TRACE_RETENTION_DAYS = PIPELINE.traceRetentionDays;
const BATCH = 100;

/**
 * The sizes of objects in a bucket, from the object metadata Supabase keeps in storage.objects (the same database).
 * Null when the database cannot see that table (a plain Postgres): the freed total is then unknown, never guessed.
 * Must be called BEFORE the objects are removed: deleting an object deletes its metadata row.
 */
async function sizesOf(ctx: Ctx, bucket: string, paths: readonly string[]): Promise<number | null> {
  let total = 0;
  try {
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      const rows = await ctx.db.execute(
        sql`select coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
            from storage.objects
            where bucket_id = ${bucket} and name in (${sql.join(
              chunk.map((p) => sql`${p}`),
              sql`, `,
            )})`,
      );
      total += Number((rows[0] as { bytes: string | number } | undefined)?.bytes ?? 0);
    }
  } catch {
    return null;
  }
  return total;
}

export async function collectGarbage(ctx: Ctx, log: Logger): Promise<GcResponse> {
  const { storage } = ctx.deps;
  if (storage === null)
    throw new HttpError(503, 'Service Unavailable', 'Storage is not configured.');
  const now = ctx.deps.now();
  const logCutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * DAY);
  const traceCutoff = new Date(now.getTime() - TRACE_RETENTION_DAYS * DAY);

  // Bytes freed so far; null as soon as one measurement is impossible.
  let freed: number | null = 0;
  const removeAll = async (bucket: string, paths: string[], knownBytes?: number) => {
    if (paths.length > 0) {
      const bytes = knownBytes ?? (await sizesOf(ctx, bucket, paths));
      freed = freed === null || bytes === null ? null : freed + bytes;
    }
    try {
      for (let i = 0; i < paths.length; i += BATCH)
        await storage.remove(bucket, paths.slice(i, i + BATCH));
    } catch (err) {
      log.error({ err, bucket }, 'storage cleanup failed');
      throw new HttpError(
        502,
        'Bad Gateway',
        'Storage cleanup failed; nothing was recorded as deleted.',
      );
    }
  };

  // ---- step logs: older than 30 days and not linked to an incident
  const linkedRows = await ctx.db
    .select({ first: incidents.firstFailingRunId, last: incidents.lastPassingRunId })
    .from(incidents);
  const linked = linkedRows
    .flatMap((r) => [r.first, r.last])
    .filter((id): id is string => id !== null);
  const expired = await ctx.db
    .select({ id: stepResults.id, path: stepResults.logPath })
    .from(stepResults)
    .innerJoin(runs, eq(runs.id, stepResults.runId))
    .where(
      and(
        isNotNull(stepResults.logPath),
        lt(runs.finishedAt, logCutoff),
        linked.length > 0 ? notInArray(runs.id, linked) : undefined,
      ),
    );
  const logPaths = expired.map((r) => r.path as string);
  await removeAll(PUBLIC_BUCKET, logPaths);
  if (expired.length > 0)
    await ctx.db
      .update(stepResults)
      .set({ logPath: null })
      .where(
        inArray(
          stepResults.id,
          expired.map((r) => r.id),
        ),
      );

  // ---- docs diffs: only those of false-positive incidents expire; every other incident keeps its evidence
  const falsePositives = await ctx.db
    .select({ id: incidents.id, path: incidents.docsDiffPath })
    .from(incidents)
    .where(
      and(
        eq(incidents.review, 'FALSE_POSITIVE'),
        isNotNull(incidents.docsDiffPath),
        lt(incidents.resolvedAt, logCutoff),
      ),
    );
  await removeAll(
    PUBLIC_BUCKET,
    falsePositives.map((r) => r.path as string),
  );
  if (falsePositives.length > 0)
    await ctx.db
      .update(incidents)
      .set({ docsDiffPath: null })
      .where(
        inArray(
          incidents.id,
          falsePositives.map((r) => r.id),
        ),
      );

  // ---- Playwright traces in the private bucket
  let traces: string[];
  let oldTraces: { name: string; size: number }[];
  try {
    oldTraces = (await storage.list(PRIVATE_BUCKET, 'traces')).filter(
      (o) => Date.parse(o.updatedAt) < traceCutoff.getTime(),
    );
    traces = oldTraces.map((o) => o.name);
  } catch (err) {
    log.error({ err }, 'could not list traces');
    throw new HttpError(
      502,
      'Bad Gateway',
      'Storage cleanup failed; nothing was recorded as deleted.',
    );
  }
  await removeAll(
    PRIVATE_BUCKET,
    traces,
    // the listing already carries each trace's size
    oldTraces.reduce((sum, o) => sum + o.size, 0),
  );

  const result = {
    freedBytes: freed,
    deletedLogs: logPaths.length,
    deletedDiffs: falsePositives.length,
    deletedTraces: traces.length,
  };
  log.info(result, 'storage cleanup finished');
  return result;
}
