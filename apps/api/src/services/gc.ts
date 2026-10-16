import { and, eq, inArray, isNotNull, lt, notInArray } from 'drizzle-orm';
import type { GcResponse, Logger } from '@qsr/core';
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
export const LOG_RETENTION_DAYS = 30;
export const TRACE_RETENTION_DAYS = 14;
const BATCH = 100;

export async function collectGarbage(ctx: Ctx, log: Logger): Promise<GcResponse> {
  const { storage } = ctx.deps;
  if (storage === null)
    throw new HttpError(503, 'Service Unavailable', 'Storage is not configured.');
  const now = ctx.deps.now();
  const logCutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * DAY);
  const traceCutoff = new Date(now.getTime() - TRACE_RETENTION_DAYS * DAY);

  const removeAll = async (bucket: string, paths: string[]) => {
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
  try {
    traces = (await storage.list(PRIVATE_BUCKET, 'traces'))
      .filter((o) => Date.parse(o.updatedAt) < traceCutoff.getTime())
      .map((o) => o.name);
  } catch (err) {
    log.error({ err }, 'could not list traces');
    throw new HttpError(
      502,
      'Bad Gateway',
      'Storage cleanup failed; nothing was recorded as deleted.',
    );
  }
  await removeAll(PRIVATE_BUCKET, traces);

  const result = {
    deletedLogs: logPaths.length,
    deletedDiffs: falsePositives.length,
    deletedTraces: traces.length,
  };
  log.info(result, 'storage cleanup finished');
  return result;
}
