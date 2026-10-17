import { apiBaseUrl } from '@/lib/env';
import {
  DEFAULT_RETRY_DELAYS_MS,
  checkSubmission,
  forwardSubmission,
  type SubmitResult,
} from '@/lib/submit';

// POST /api/submit: the only way the /submit form reaches the API. The API address stays on the server.
// A cold API can take up to a minute to wake, so this handler waits and retries (see lib/submit.ts).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 8 * 1024;
const STATUS = { invalid: 400, rate_limited: 429, turnstile: 403, unavailable: 503 } as const;

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

function clientIp(req: Request): string | null {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first ? first : null;
}

export async function POST(req: Request): Promise<Response> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES)
    return json({ ok: false, kind: 'invalid', message: 'The submission is too large.' }, 413);

  let input: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('too large');
    input = JSON.parse(text);
  } catch {
    return json({ ok: false, kind: 'invalid', message: 'The form could not be read.' }, 400);
  }

  const checked = checkSubmission(input);
  if (!checked.ok) return json({ ok: false, kind: 'invalid', message: checked.message }, 400);
  // A bot filled the hidden field. Answer as if it worked and store nothing.
  if (checked.honeypot) return json({ ok: true }, 200);

  let base: string;
  try {
    base = apiBaseUrl();
  } catch {
    return json(
      { ok: false, kind: 'unavailable', message: 'Submissions are not available right now.' },
      503,
    );
  }

  const result: SubmitResult = await forwardSubmission(
    {
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      apiBaseUrl: base,
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    },
    checked.body,
    clientIp(req),
  );
  if (result.ok) return json({ ok: true }, 200);
  return json(result, STATUS[result.kind], {
    ...(result.retryAfterSeconds ? { 'retry-after': String(result.retryAfterSeconds) } : {}),
  });
}
