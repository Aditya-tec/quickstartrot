import { createHash, timingSafeEqual } from 'node:crypto';

// Spec section 11: admin endpoints take `Bearer ADMIN_TOKEN`.

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Constant-time string comparison. Both sides are hashed first, so lengths are equal (timingSafeEqual
 * throws otherwise) and the length of the real token is not leaked by an early return.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function parseBearer(header: string | undefined): string | null {
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  return match ? (match[1] as string) : null;
}

export interface FailureLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

/** Counts failures per key inside a sliding window. In-memory is fine for one instance (spec section 11). */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: FailureLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.failures.size;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs;
    return (this.failures.get(key) ?? []).filter((t) => t > cutoff);
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.options.max;
  }

  recordFailure(key: string): void {
    // Sweep keys whose failures all expired, so an attacker cycling addresses cannot grow the map forever.
    const cutoff = this.now() - this.options.windowMs;
    for (const [k, times] of this.failures)
      if (times.every((t) => t <= cutoff)) this.failures.delete(k);
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export type AdminAuthResult = 'ok' | 'unauthorized' | 'rate_limited';

/**
 * A blocked key is refused without looking at the token at all, so a flood of guesses learns nothing, not
 * even from a lucky correct one. A success clears the key's earlier failures.
 */
export function authorizeAdmin(input: {
  header: string | undefined;
  token: string;
  limiter: FailureLimiter;
  key: string;
}): AdminAuthResult {
  const { header, token, limiter, key } = input;
  if (limiter.isBlocked(key)) return 'rate_limited';
  const given = parseBearer(header);
  if (given !== null && constantTimeEqual(given, token)) {
    limiter.reset(key);
    return 'ok';
  }
  limiter.recordFailure(key);
  return 'unauthorized';
}
