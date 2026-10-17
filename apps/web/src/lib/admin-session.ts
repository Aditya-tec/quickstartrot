// The admin session (spec section 13): after the login form checks ADMIN_TOKEN, the browser gets an httpOnly,
// secure, sameSite=strict cookie holding THIS value: an HMAC-signed, expiring claim. The admin token itself is
// never in the cookie and the browser never sees it. Web Crypto only, so the same code runs in the middleware
// (Edge) and in server actions (Node). The constant-time token comparison is in secret-compare.ts (Node only).

export const SESSION_COOKIE = 'qsr_admin';
export const SESSION_TTL_SECONDS = 8 * 3600;
const MIN_SECRET_LENGTH = 32;
/** A session whose issue time is this far in the future is refused (clock skew allowance). */
const FUTURE_SKEW_SECONDS = 60;

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded =
      text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** A new session value, valid for SESSION_TTL_SECONDS from `nowSeconds`. */
export async function signSession(secret: string, nowSeconds: number): Promise<string> {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new Error(`ADMIN_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64urlEncode(
    encoder.encode(
      JSON.stringify({
        sub: 'admin',
        iat: nowSeconds,
        exp: nowSeconds + SESSION_TTL_SECONDS,
        n: nonce,
      }),
    ),
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    encoder.encode(payload),
  );
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** True only for an unexpired value that this secret signed. Never throws. */
export async function verifySession(
  secret: string,
  value: string,
  nowSeconds: number,
): Promise<boolean> {
  try {
    if (secret.length < MIN_SECRET_LENGTH) return false;
    const parts = value.split('.');
    if (parts.length !== 2) return false;
    const [payload, sigText] = parts as [string, string];
    const sig = b64urlDecode(sigText);
    if (sig === null || sig.length === 0) return false;
    // crypto.subtle.verify compares in constant time
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      sig,
      encoder.encode(payload),
    );
    if (!ok) return false;
    const raw = b64urlDecode(payload);
    if (raw === null) return false;
    const claim = JSON.parse(new TextDecoder().decode(raw)) as {
      sub?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    if (claim.sub !== 'admin' || typeof claim.iat !== 'number' || typeof claim.exp !== 'number')
      return false;
    if (claim.iat > nowSeconds + FUTURE_SKEW_SECONDS) return false;
    return claim.exp > nowSeconds;
  } catch {
    return false;
  }
}

// ---- failed-login limiter

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Counts failed logins per client. In-memory, so on serverless it is per instance and resets when an instance
 * is recycled: it slows a naive attacker and nothing more. The token is long and random, and every admin
 * ACTION still needs the bearer token that only the server holds, whose failures the API limits itself.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const failures = new Map<string, number[]>();
  const live = (key: string): number[] => {
    const cutoff = options.now() - options.windowMs;
    const recent = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) failures.delete(key);
    else failures.set(key, recent);
    return recent;
  };
  const prune = (): void => {
    if (failures.size < 1000) return;
    for (const key of [...failures.keys()]) live(key);
  };
  return {
    check(key: string): RateLimitResult {
      const recent = live(key);
      if (recent.length < options.max) return { allowed: true, retryAfterSeconds: 0 };
      const oldest = Math.min(...recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((oldest + options.windowMs - options.now()) / 1000),
        ),
      };
    },
    fail(key: string): void {
      prune();
      failures.set(key, [...live(key), options.now()]);
    },
    /** A success does not forget earlier failures: logging in must not reset an attacker's count. */
    succeed(): void {
      /* intentionally nothing */
    },
    size(): number {
      return failures.size;
    },
  };
}
