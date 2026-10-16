import { createHmac } from 'node:crypto';
import { SAFE_STEP_ID } from '@qsr/core';

// Where a run's step logs live in the `public-artifacts` bucket. The bucket is public-read, so paths must be
// unguessable, and cycle ids are NOT secret (the public views expose them): the run directory carries an
// HMAC of (cycle, tool, attempt) under the ingest secret. The server can recompute it, so /internal/runs
// re-validates a reported path by exact equality instead of storing what it handed out.

export { SAFE_STEP_ID };

function token(secret: string, cycleId: string, toolSlug: string, attempt: number): string {
  return createHmac('sha256', secret)
    .update(`log-dir\n${cycleId}\n${toolSlug}\n${attempt}`)
    .digest('hex')
    .slice(0, 24);
}

/** `logs/<cycle>/<tool>-<attempt>-<token>/` */
export function runPathPrefix(
  secret: string,
  cycleId: string,
  toolSlug: string,
  attempt: number,
): string {
  return `logs/${cycleId}/${toolSlug}-${attempt}-${token(secret, cycleId, toolSlug, attempt)}/`;
}

/** The one path a step's gzipped log may be uploaded to and reported under. */
export function logPathFor(
  secret: string,
  cycleId: string,
  toolSlug: string,
  attempt: number,
  step: { stepId: string; ordinal: number },
): string {
  const file = `${String(step.ordinal).padStart(2, '0')}-${step.stepId}.log.gz`;
  return `${runPathPrefix(secret, cycleId, toolSlug, attempt)}${file}`;
}
