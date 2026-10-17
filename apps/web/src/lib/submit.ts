import { SubmissionBody, SubmissionResponse, validateSubmissionUrl } from '@qsr/core/public';
import { z } from 'zod';

// /submit. The browser posts the form to our route handler. The handler checks it with the schema and the URL
// rule the API itself uses (both from @qsr/core), drops honeypot hits quietly, and forwards the rest to the API
// with retries, because the API runs on a free tier that sleeps and takes up to a minute to wake.

/** The form: the API's body plus a honeypot field that real visitors never see or fill. */
const FormBody = SubmissionBody.extend({ company: z.string().max(200).optional() });

export type SubmissionCheck =
  { ok: true; honeypot: boolean; body: SubmissionBody } | { ok: false; message: string };

const blank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

export function checkSubmission(input: unknown): SubmissionCheck {
  if (
    typeof input === 'object' &&
    input !== null &&
    'docsUrl' in input &&
    typeof input.docsUrl === 'string' &&
    input.docsUrl.trim() === ''
  )
    return { ok: false, message: 'Invalid docs URL: the URL is empty.' };
  const parsed = FormBody.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: 'The form could not be read. Check the fields and try again.' };
  const url = validateSubmissionUrl(parsed.data.docsUrl);
  if (!url.ok) return { ok: false, message: `Invalid docs URL: ${url.reason}.` };
  const body: SubmissionBody = { docsUrl: url.url };
  const contact = blank(parsed.data.contact);
  const note = blank(parsed.data.note);
  const token = blank(parsed.data.turnstileToken);
  if (contact) body.contact = contact;
  if (note) body.note = note;
  if (token) body.turnstileToken = token;
  return { ok: true, honeypot: blank(parsed.data.company) !== undefined, body };
}

export type SubmitResult =
  | { ok: true; id: string | null }
  | {
      ok: false;
      kind: 'invalid' | 'rate_limited' | 'turnstile' | 'unavailable';
      message: string;
      retryAfterSeconds?: number;
    };

export interface SubmitDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  apiBaseUrl: string;
  /** Waits before each retry; the number of entries is the number of retries. */
  retryDelaysMs: readonly number[];
  attemptTimeoutMs?: number;
}

/** 5 + 2 + 3 + 5 + 7 seconds of waiting plus up to 8 seconds per attempt stays inside a 60 second function. */
export const DEFAULT_RETRY_DELAYS_MS = [2000, 3000, 5000, 7000] as const;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 8000;

const Problem = z.object({ detail: z.string().optional() });
const WAKING = new Set([502, 503, 504]);
const UNAVAILABLE: SubmitResult = {
  ok: false,
  kind: 'unavailable',
  message: 'The server is not answering right now. Please try again in a few minutes.',
};

async function problemDetail(res: Response): Promise<string | null> {
  try {
    const parsed = Problem.safeParse(await res.json());
    const detail = parsed.success ? parsed.data.detail : undefined;
    return detail ? detail.slice(0, 300) : null;
  } catch {
    return null;
  }
}

export async function forwardSubmission(
  deps: SubmitDeps,
  body: SubmissionBody,
  clientIp: string | null,
): Promise<SubmitResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // The API limits submissions per visitor address, so it must see the visitor's, not this server's.
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  const attempts = deps.retryDelaysMs.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await deps.fetch(`${deps.apiBaseUrl}/submissions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deps.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS),
      });
    } catch {
      res = null; // a sleeping server resets or times out the first connections
    }

    if (res !== null && !WAKING.has(res.status)) {
      if (res.status === 201) {
        try {
          const parsed = SubmissionResponse.safeParse(await res.json());
          return parsed.success ? { ok: true, id: parsed.data.id } : UNAVAILABLE;
        } catch {
          return UNAVAILABLE;
        }
      }
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        return {
          ok: false,
          kind: 'rate_limited',
          message: 'You have reached the limit of submissions for today. Please try again later.',
          ...(Number.isFinite(wait) && wait > 0 ? { retryAfterSeconds: Math.ceil(wait) } : {}),
        };
      }
      if (res.status === 403)
        return {
          ok: false,
          kind: 'turnstile',
          message: 'The human check failed. Reload the page and try again.',
        };
      if (res.status >= 400 && res.status < 500)
        return {
          ok: false,
          kind: 'invalid',
          message: (await problemDetail(res)) ?? 'The submission was not accepted.',
        };
      return UNAVAILABLE; // another 5xx: not a server that is still waking up
    }

    const delay = deps.retryDelaysMs[attempt];
    if (delay !== undefined) await deps.sleep(delay);
  }
  return UNAVAILABLE;
}
