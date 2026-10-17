import { SESSION_TTL_SECONDS, signSession, type createRateLimiter } from './admin-session';
import { compareSecrets } from './secret-compare';

// The decision behind the login form. The server action calls this and sets the cookie it returns.

export type Limiter = ReturnType<typeof createRateLimiter>;

export type LoginResult =
  | { kind: 'ok'; session: string }
  | { kind: 'bad' }
  | { kind: 'limited'; retryAfterSeconds: number };

export async function attemptLogin(input: {
  givenToken: string;
  expectedToken: string;
  sessionSecret: string;
  limiter: Limiter;
  clientKey: string;
  nowSeconds: () => number;
}): Promise<LoginResult> {
  const gate = input.limiter.check(input.clientKey);
  // Checked before the token: a client that is over the limit learns nothing about whether its guess was right.
  if (!gate.allowed) return { kind: 'limited', retryAfterSeconds: gate.retryAfterSeconds };
  if (input.givenToken === '' || !compareSecrets(input.givenToken, input.expectedToken)) {
    input.limiter.fail(input.clientKey);
    return { kind: 'bad' };
  }
  input.limiter.succeed();
  return { kind: 'ok', session: await signSession(input.sessionSecret, input.nowSeconds()) };
}

/** The session cookie. Scoped to /admin, so it is not even sent with the public pages. */
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: '/admin',
    maxAge: SESSION_TTL_SECONDS,
  };
}
