// Waking the API. It runs on Render's free tier, which sleeps after a quiet spell and then takes up to a minute to answer. Public pages
// never wait for it (they read the public database views, cached). Only the /submit form posts to it, so opening /submit sends one
// GET /health, and by the time a visitor has typed a URL the server is awake. Nothing is sent and nothing is read.

export type WarmResult = 'woken' | 'asleep' | 'skipped';

export interface WarmerDeps {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  now: () => number;
  /** How long to wait for the answer before giving up; the request itself keeps the server waking. */
  timeoutMs?: number;
  /** At most one request in this window, however many pages are opened. */
  windowMs?: number;
}

export const WARM_TIMEOUT_MS = 55_000;
export const WARM_WINDOW_MS = 60_000;

/** A function that wakes the API at most once per window and never throws. A failed attempt does not start a window. */
export function createWarmer(deps: WarmerDeps): () => Promise<WarmResult> {
  let lastWoken = Number.NEGATIVE_INFINITY;
  const windowMs = deps.windowMs ?? WARM_WINDOW_MS;
  return async () => {
    const now = deps.now();
    if (now - lastWoken < windowMs) return 'skipped';
    try {
      const res = await deps.fetch(`${deps.apiBaseUrl}/health`, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(deps.timeoutMs ?? WARM_TIMEOUT_MS),
      });
      if (!res.ok) return 'asleep';
      lastWoken = now;
      return 'woken';
    } catch {
      return 'asleep';
    }
  };
}
