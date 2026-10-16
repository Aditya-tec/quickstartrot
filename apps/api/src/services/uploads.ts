import { eq } from 'drizzle-orm';
import type { Logger, UploadsBody, UploadsResponse } from '@qsr/core';
import { probeCycles, tools } from '@qsr/db';
import type { Ctx } from '../deps.js';
import { logPathFor, SAFE_STEP_ID } from '../log-paths.js';
import { HttpError } from '../problem.js';
import { PUBLIC_BUCKET } from '../storage.js';

/** POST /internal/uploads: a signed upload URL per step log, at a path derived from the run. */
export async function createUploads(
  ctx: Ctx,
  body: UploadsBody,
  log: Logger,
): Promise<UploadsResponse> {
  const { storage, config } = ctx.deps;
  const ids = body.files.map((f) => f.stepId);
  if (ids.some((id) => !SAFE_STEP_ID.test(id)))
    throw new HttpError(
      400,
      'Bad Request',
      'A step id contains characters that are not allowed in a log path.',
    );
  if (new Set(ids).size !== ids.length)
    throw new HttpError(400, 'Bad Request', 'A step id is repeated.');

  const [cycle] = await ctx.db.select().from(probeCycles).where(eq(probeCycles.id, body.cycleId));
  if (!cycle) throw new HttpError(404, 'Not Found', 'No such cycle.');
  if (cycle.finishedAt !== null)
    throw new HttpError(409, 'Conflict', 'This cycle is already finished.');
  const [tool] = await ctx.db
    .select({ id: tools.id })
    .from(tools)
    .where(eq(tools.slug, body.toolSlug));
  if (!tool) throw new HttpError(404, 'Not Found', 'No such tool.');
  if (storage === null)
    throw new HttpError(503, 'Service Unavailable', 'Storage is not configured.');

  try {
    const files = await Promise.all(
      body.files.map(async (f) => {
        const path = logPathFor(
          config.ingestHmacSecret,
          body.cycleId,
          body.toolSlug,
          body.attempt,
          f,
        );
        const { signedUrl, token } = await storage.createSignedUpload(PUBLIC_BUCKET, path);
        return { stepId: f.stepId, path, signedUrl, token };
      }),
    );
    return { bucket: PUBLIC_BUCKET, files };
  } catch (err) {
    log.error({ err }, 'storage could not create upload URLs');
    throw new HttpError(502, 'Bad Gateway', 'Storage could not create the upload URLs.');
  }
}
