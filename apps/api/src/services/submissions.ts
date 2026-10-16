import { createHmac } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { SubmissionBody, SubmissionResponse } from '@qsr/core';
import { submissions, type Db } from '@qsr/db';
import type { Config } from '../config.js';
import { HttpError } from '../problem.js';
import { validateSubmissionUrl } from '../submission-url.js';

// POST /submissions (spec sections 11 and 14). Founders submit a quickstart URL; a human turns an accepted
// one into a target PR. The URL is stored, never fetched.

export const DAILY_LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The address is never stored: only HMAC-SHA256(server secret, address), so the hash cannot be reversed by brute force without the secret. */
export const hashIp = (secret: string, ip: string): string =>
  createHmac('sha256', secret).update(ip).digest('hex');

async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  doFetch: typeof fetch,
): Promise<void> {
  if (!token) throw new HttpError(400, 'Bad Request', 'Turnstile verification is required.');
  let res: Response;
  try {
    // The visitor's address is deliberately NOT sent to Cloudflare.
    res = await doFetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
  } catch {
    throw new HttpError(
      503,
      'Service Unavailable',
      'Turnstile verification is unavailable; try again later.',
    );
  }
  if (!res.ok)
    throw new HttpError(
      503,
      'Service Unavailable',
      'Turnstile verification is unavailable; try again later.',
    );
  const body = (await res.json().catch(() => null)) as { success?: unknown } | null;
  if (body?.success !== true)
    throw new HttpError(403, 'Forbidden', 'Turnstile verification failed.');
}

export async function createSubmission(
  db: Db,
  input: { body: SubmissionBody; ip: string; config: Config; now: Date; fetch: typeof fetch },
): Promise<SubmissionResponse> {
  const { body, ip, config, now } = input;
  const checked = validateSubmissionUrl(body.docsUrl);
  if (!checked.ok) throw new HttpError(400, 'Bad Request', `Invalid docs URL: ${checked.reason}.`);

  const ipHash = hashIp(config.submissionIpSecret, ip);
  const since = new Date(now.getTime() - WINDOW_MS);
  const recent = await db
    .select({ createdAt: submissions.createdAt })
    .from(submissions)
    .where(and(eq(submissions.ipHash, ipHash), gt(submissions.createdAt, since)))
    .orderBy(asc(submissions.createdAt));
  if (recent.length >= DAILY_LIMIT) {
    const oldest = recent[recent.length - DAILY_LIMIT] as { createdAt: Date };
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest.createdAt.getTime() + WINDOW_MS - now.getTime()) / 1000),
    );
    throw new HttpError(
      429,
      'Too Many Requests',
      `At most ${DAILY_LIMIT} submissions a day; try again later.`,
      {
        headers: { 'retry-after': String(retryAfter) },
      },
    );
  }

  if (config.turnstileSecret)
    await verifyTurnstile(config.turnstileSecret, body.turnstileToken, input.fetch);

  const [row] = await db
    .insert(submissions)
    .values({
      docsUrl: checked.url,
      contact: body.contact ?? null,
      note: body.note ?? null,
      ipHash,
      createdAt: now,
    })
    .returning({ id: submissions.id });
  return { id: (row as { id: string }).id, status: 'NEW' };
}
