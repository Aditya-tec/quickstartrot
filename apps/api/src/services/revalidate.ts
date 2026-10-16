import type { Logger } from '@qsr/core';
import type { AppDeps } from '../deps.js';

/**
 * Spec section 13: at cycle finish the API calls the web app's POST /api/revalidate with REVALIDATE_SECRET so
 * the public pages refresh without waiting for ISR. Best effort: a failure here is logged, never fatal, and
 * the secret is never logged.
 */
export async function notifyWeb(deps: AppDeps, cycleId: string, log: Logger): Promise<void> {
  const { revalidateUrl, revalidateSecret } = deps.config;
  if (!revalidateUrl || !revalidateSecret) return;
  try {
    const res = await deps.fetch(revalidateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-revalidate-secret': revalidateSecret },
      body: JSON.stringify({ source: 'api', cycleId }),
    });
    if (!res.ok) log.warn({ cycleId, status: res.status }, 'web revalidation was refused');
  } catch (err) {
    log.warn(
      { cycleId, err: err instanceof Error ? err.message : String(err) },
      'web revalidation failed',
    );
  }
}
