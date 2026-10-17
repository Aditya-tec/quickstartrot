import { describe, expect, it, vi } from 'vitest';
import { checkSubmission, forwardSubmission, type SubmitDeps } from './submit';

// /submit: the browser posts to our route handler, which validates with the schema and URL rule shared with the
// API (@qsr/core), drops honeypot hits, and forwards to the API with retries while a free-tier server wakes up.

const ID = '00000000-0000-4000-8000-000000000001';
const API = 'https://api.example.com';

const created = () =>
  new Response(JSON.stringify({ id: ID, status: 'NEW' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
const problem = (status: number, detail: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

function deps(responses: (Response | Error)[]): SubmitDeps & {
  fetch: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const fetchFn = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  return { fetch: fetchFn, sleep, apiBaseUrl: API, retryDelaysMs: [10, 20, 30] };
}

describe('checkSubmission', () => {
  it('accepts a valid https docs URL and trims the optional fields', () => {
    const r = checkSubmission({
      docsUrl: ' https://docs.example.com/quickstart ',
      contact: ' a@b.co ',
      note: '',
    });
    expect(r).toEqual({
      ok: true,
      honeypot: false,
      body: { docsUrl: 'https://docs.example.com/quickstart', contact: 'a@b.co' },
    });
  });

  it.each([
    ['http://docs.example.com/x', /https/],
    ['https://127.0.0.1/x', /IP/],
    ['https://localhost/x', /local/],
    ['not a url', /URL/],
    ['', /URL|empty/i],
  ])('rejects %j with a reason the user can act on', (docsUrl, reason) => {
    const r = checkSubmission({ docsUrl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(reason);
  });

  it('rejects a body of the wrong shape', () => {
    expect(checkSubmission(null).ok).toBe(false);
    expect(checkSubmission({ docsUrl: 42 }).ok).toBe(false);
    expect(checkSubmission({ docsUrl: 'https://a.example.com/', note: 'x'.repeat(1001) }).ok).toBe(
      false,
    );
  });

  it('recognises the honeypot', () => {
    const r = checkSubmission({ docsUrl: 'https://docs.example.com/x', company: 'Acme Bots Ltd' });
    expect(r).toMatchObject({ ok: true, honeypot: true });
  });

  it('keeps the Turnstile token and nothing unknown', () => {
    const r = checkSubmission({
      docsUrl: 'https://docs.example.com/x',
      turnstileToken: 'tok',
      isAdmin: true,
    });
    expect(r).toMatchObject({
      ok: true,
      body: { docsUrl: 'https://docs.example.com/x', turnstileToken: 'tok' },
    });
    if (r.ok) expect(Object.keys(r.body)).not.toContain('isAdmin');
  });
});

describe('forwardSubmission', () => {
  const body = { docsUrl: 'https://docs.example.com/x' };

  it('posts to /submissions with the visitor address and no credentials', async () => {
    const d = deps([created()]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toEqual({ ok: true, id: ID });
    const [url, init] = d.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/submissions`);
    const headers = new Headers(init.headers);
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(headers.get('authorization')).toBeNull();
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('retries a network error and a 503 (the server is waking up), then succeeds', async () => {
    const d = deps([new TypeError('fetch failed'), problem(503, 'starting'), created()]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toEqual({ ok: true, id: ID });
    expect(d.fetch).toHaveBeenCalledTimes(3);
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it('gives up after the last retry and says the server is unavailable', async () => {
    const d = deps([
      problem(502, 'bad gateway'),
      problem(502, 'bad gateway'),
      problem(504, 'timeout'),
      problem(503, 'x'),
    ]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry a 400 and passes on the reason', async () => {
    const d = deps([problem(400, 'Invalid docs URL: only https URLs are accepted.')]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toMatchObject({
      ok: false,
      kind: 'invalid',
      message: expect.stringContaining('https'),
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports the daily limit with when to try again', async () => {
    const d = deps([problem(429, 'At most 5 submissions a day', { 'retry-after': '7200' })]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toMatchObject({ ok: false, kind: 'rate_limited', retryAfterSeconds: 7200 });
  });

  it('reports a failed Turnstile check', async () => {
    const d = deps([problem(403, 'Turnstile verification failed.')]);
    expect(await forwardSubmission(d, body, '203.0.113.9')).toMatchObject({
      ok: false,
      kind: 'turnstile',
    });
  });

  it('treats an unexpected answer as unavailable, without echoing it', async () => {
    const d = deps([new Response('<html>oops</html>', { status: 201 })]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(JSON.stringify(r)).not.toContain('oops');
  });

  it('treats any other 4xx as invalid and 5xx other than gateway errors as unavailable without retry storms', async () => {
    const d = deps([problem(500, 'boom')]);
    const r = await forwardSubmission(d, body, '203.0.113.9');
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('omits the forwarded address when it is unknown', async () => {
    const d = deps([created()]);
    await forwardSubmission(d, body, null);
    const init = d.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-forwarded-for')).toBeNull();
  });
});
