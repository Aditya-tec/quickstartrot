'use server';

import { ConfirmBody, FalsePositiveBody } from '@qsr/core/public';
import { revalidateTag } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { attemptLogin, cookieOptions } from '@/lib/admin-login';
import { createAdminApi } from '@/lib/admin-api';
import { SESSION_COOKIE, createRateLimiter, verifySession } from '@/lib/admin-session';
import { DATA_TAG } from '@/lib/cached';
import { ConfigError, adminConfig } from '@/lib/env';

// Server actions for /admin. They run on the server: the admin token and the API address are read here and
// never sent to the browser. Every action except login re-checks the session cookie.

export type ActionState =
  { status: 'idle' } | { status: 'error'; message: string } | { status: 'done'; message: string };

// Failed logins per client. In memory, so on serverless this is per instance and resets when an instance is
// recycled: it slows a guesser and nothing more. The API's own limiter on bad tokens is the backstop.
const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60_000, now: () => Date.now() });

async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get('x-real-ip')?.trim() || h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let config: ReturnType<typeof adminConfig>;
  try {
    config = adminConfig();
  } catch (err) {
    // names the variable that is missing, never a value
    return {
      status: 'error',
      message: err instanceof ConfigError ? err.message : 'The admin area is not configured.',
    };
  }
  const result = await attemptLogin({
    givenToken: String(form.get('token') ?? ''),
    expectedToken: config.adminToken,
    sessionSecret: config.sessionSecret,
    limiter,
    clientKey: await clientKey(),
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });
  if (result.kind === 'limited')
    return {
      status: 'error',
      message: `Too many failed attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
    };
  if (result.kind === 'bad') return { status: 'error', message: 'That token is not correct.' };
  (await cookies()).set(SESSION_COOKIE, result.session, cookieOptions());
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete({ name: SESSION_COOKIE, path: '/admin' });
  redirect('/admin/login');
}

async function authorised(): Promise<ReturnType<typeof adminConfig> | null> {
  try {
    const config = adminConfig();
    const cookie = (await cookies()).get(SESSION_COOKIE)?.value ?? '';
    const valid =
      cookie !== '' &&
      (await verifySession(config.sessionSecret, cookie, Math.floor(Date.now() / 1000)));
    return valid ? config : null;
  } catch {
    return null;
  }
}

const SESSION_ENDED: ActionState = {
  status: 'error',
  message: 'Your session has ended. Sign in again.',
};

function apiFor(config: ReturnType<typeof adminConfig>) {
  return createAdminApi({ fetch, apiBaseUrl: config.apiBaseUrl, token: config.adminToken });
}

/**
 * Publishing an incident changes the public pages, so their cache is dropped. The admin page itself is not
 * refreshed here: the reviewed incident stays on screen with its confirmation until the page is reloaded.
 */
function refresh(): void {
  revalidateTag(DATA_TAG);
}

export async function confirmAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const config = await authorised();
  if (!config) return SESSION_ENDED;
  const body = ConfirmBody.safeParse({
    summary: String(form.get('summary') ?? '').trim(),
    suggestedFix: String(form.get('suggestedFix') ?? '').trim(),
  });
  if (!body.success)
    return {
      status: 'error',
      message: 'Write a summary (up to 4000 characters) before confirming.',
    };
  const result = await apiFor(config).confirm(String(form.get('id') ?? ''), body.data);
  if (!result.ok) return { status: 'error', message: result.message };
  refresh();
  return { status: 'done', message: 'Confirmed. The incident is now public.' };
}

export async function falsePositiveAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const config = await authorised();
  if (!config) return SESSION_ENDED;
  const body = FalsePositiveBody.safeParse({ reason: String(form.get('reason') ?? '').trim() });
  if (!body.success)
    return {
      status: 'error',
      message: 'Give a reason (up to 2000 characters) for the false positive.',
    };
  const result = await apiFor(config).falsePositive(String(form.get('id') ?? ''), body.data);
  if (!result.ok) return { status: 'error', message: result.message };
  refresh();
  return { status: 'done', message: 'Marked as a false positive. It stays hidden.' };
}
