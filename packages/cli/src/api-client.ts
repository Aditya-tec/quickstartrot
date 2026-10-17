import { Health, SIGNATURE_HEADER, TIMESTAMP_HEADER, signRequest } from '@qsr/core';
import type { z } from 'zod';

// The client the probe workflow uses to reach the API (spec section 11). Every POST is HMAC-signed over
// `timestamp + "." + rawBody`. The API runs on Render's free tier, which sleeps after 15 minutes and takes
// 30-60 s to wake, so there are two layers of patience:
//   wakeApi()      polls GET /health every 10 s for up to 3 minutes before the cycle starts;
//   post()         retries 502/503/504 and network errors with exponential backoff.
// 4xx and 500 are never retried: the request may have been processed, and the idempotency keys on
// /internal/cycles and /internal/runs exist for the cases where a retry really is wanted.

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export interface WakeOptions {
  intervalMs: number;
  timeoutMs: number;
}
export interface ApiClientOptions {
  baseUrl: string;
  /** The HMAC secret: signs every POST to /internal/*. */
  secret?: string;
  /** The admin token: sent as a bearer header on /admin/* (GET and POST). Use one of the two. */
  bearerToken?: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Injected so a test can move time without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retry?: Partial<RetryOptions>;
  wake?: Partial<WakeOptions>;
  requestTimeoutMs?: number;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 7, baseDelayMs: 2_000, maxDelayMs: 30_000 };
export const DEFAULT_WAKE: WakeOptions = { intervalMs: 10_000, timeoutMs: 180_000 };
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE = new Set([502, 503, 504]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string | undefined,
    readonly route: string,
    /** The Retry-After of the answer in whole seconds, when it was a plain number; null otherwise. */
    readonly retryAfterS: number | null = null,
  ) {
    super(`${route} failed: ${status} ${title}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
  }
}

export class ApiWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiWakeError';
  }
}

export interface WakeResult {
  attempts: number;
  waitedMs: number;
}

export interface ApiClient {
  health(): Promise<Health>;
  wakeApi(): Promise<WakeResult>;
  /** GET with the same retries as post. Carries the bearer token when the client has one; never signed. */
  get<T = unknown>(path: string, schema?: z.ZodType<T>): Promise<T>;
  post<T = unknown>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T>;
}

interface ProblemBody {
  title?: unknown;
  detail?: unknown;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const cause = err.cause instanceof Error ? (err.cause as Error & { code?: string }) : null;
  return cause ? `${err.message} (${cause.code ?? cause.message})` : err.message;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  if (!options.secret && !options.bearerToken)
    throw new Error(
      'createApiClient needs a secret (internal routes) or a bearerToken (admin routes)',
    );
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...options.retry };
  const wake: WakeOptions = { ...DEFAULT_WAKE, ...options.wake };
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function errorFor(res: Response, route: string): Promise<ApiError> {
    const text = await res.text().catch(() => '');
    let title = res.statusText || `HTTP ${res.status}`;
    let detail: string | undefined;
    try {
      const body = JSON.parse(text) as ProblemBody;
      if (typeof body.title === 'string') title = body.title;
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      detail = text.slice(0, 200) || undefined;
    }
    const header = Number(res.headers.get('retry-after'));
    const retryAfterS =
      res.headers.get('retry-after') !== null && Number.isInteger(header) && header >= 0
        ? header
        : null;
    return new ApiError(res.status, title, detail, route, retryAfterS);
  }

  async function parseJson<T>(res: Response, route: string, schema?: z.ZodType<T>): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'Invalid response', 'the response body is not JSON', route);
    }
    return schema ? schema.parse(parsed) : (parsed as T);
  }

  function retryDelay(attempt: number, res: Response | null): number {
    const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    const header = res?.headers.get('retry-after');
    const seconds = header ? Number(header) : NaN;
    // Retry-After is honoured when it asks for longer than our own backoff, within a sane cap.
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.max(backoff, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS))
      : backoff;
  }

  async function health(): Promise<Health> {
    const route = 'GET /health';
    const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw await errorFor(res, route);
    return parseJson(res, route, Health);
  }

  /** One request with the retries: 502/503/504 and network errors, with backoff; everything else fails at once. */
  async function send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const route = `${method} ${path}`;
    const raw = method === 'POST' ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    let failure: Error = new Error(`${route} was not attempted`);
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      const headers: Record<string, string> = raw ? { 'content-type': 'application/json' } : {};
      if (options.bearerToken) {
        headers['authorization'] = `Bearer ${options.bearerToken}`;
      } else if (raw && options.secret) {
        // A fresh timestamp and signature per attempt: a long outage must not age the request out of the
        // server's 300 s window. The body bytes are identical every time.
        const timestamp = Math.floor(now() / 1000);
        headers[TIMESTAMP_HEADER] = String(timestamp);
        headers[SIGNATURE_HEADER] = signRequest(options.secret, timestamp, raw);
      }
      let res: Response | null = null;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          ...(raw ? { body: raw } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        failure = new Error(`Could not reach ${base}${path}: ${describeNetworkError(err)}`);
      }
      if (res !== null) {
        if (res.ok) return parseJson(res, route, schema);
        const error = await errorFor(res, route);
        if (!RETRYABLE.has(res.status)) throw error;
        failure = error;
      }
      if (attempt < retry.attempts) await sleep(retryDelay(attempt, res));
    }
    throw failure;
  }

  return {
    health,

    async wakeApi() {
      const started = now();
      let attempts = 0;
      let last = 'no answer';
      for (;;) {
        attempts += 1;
        try {
          await health();
          return { attempts, waitedMs: now() - started };
        } catch (err) {
          last = err instanceof ApiError ? `HTTP ${err.status}` : describeNetworkError(err);
        }
        if (now() - started >= wake.timeoutMs)
          throw new ApiWakeError(
            `The API at ${base} did not wake up within ${Math.round(wake.timeoutMs / 60_000)} minutes (last answer: ${last}). ` +
              'Check that the Render service is deployed and healthy, and that the API_BASE_URL variable points at it.',
          );
        await sleep(wake.intervalMs);
      }
    },

    get: <T = unknown>(path: string, schema?: z.ZodType<T>): Promise<T> =>
      send('GET', path, undefined, schema),

    post: <T = unknown>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> =>
      send('POST', path, body, schema),
  };
}
