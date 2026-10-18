import { after } from 'next/server';
import { apiBaseUrl } from '@/lib/env';
import { createWarmer, WARM_WINDOW_MS, type WarmResult } from '@/lib/warm';

// POST /api/warm: opening /submit calls this so the API (asleep on a free tier, up to a minute to answer) is awake by the time the form is
// sent. It answers at once and wakes the API after the response (one GET /health, at most once a minute per server instance). The API
// address stays on the server; the browser learns nothing about it.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let warmer: (() => Promise<WarmResult>) | null = null;

export function POST(): Response {
  try {
    // QSR_WARM_WINDOW_MS exists for the end-to-end suite, which opens /submit many times in one server and must see each warm-up
    warmer ??= createWarmer({
      fetch,
      apiBaseUrl: apiBaseUrl(),
      now: Date.now,
      windowMs: Number(process.env['QSR_WARM_WINDOW_MS'] ?? WARM_WINDOW_MS),
    });
    const warm = warmer;
    after(async () => {
      await warm();
    });
  } catch {
    // the API address is not configured here: there is nothing to wake
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
