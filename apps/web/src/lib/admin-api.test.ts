import { describe, expect, it, vi } from 'vitest';
import { createAdminApi } from './admin-api';

// The admin pages call the Render API from the server with a bearer token. The browser never sees the token or the
// API address. Every answer is parsed with the schema from @qsr/core; a failure never carries the token.

const TOKEN = ['admin', 'token', 'for', 'tests', '0123456789abcdef'].join('-');
const API = 'https://api.example.com';
const ID = '00000000-0000-4000-8000-0000000000aa';

const queueBody = {
  pendingIncidents: [
    {
      id: ID,
      toolSlug: 'resend-node',
      signature: 'sig-1',
      failureClass: 'API_DRIFT',
      review: 'PENDING_REVIEW',
      openedAt: '2026-10-16T12:00:00.000Z',
      summary: 'Draft summary',
      suggestedFix: null,
      docsChanged: false,
    },
  ],
  items: [],
  submissions: [],
};

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(response: Response | Error) {
  const fetchFn = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { api: createAdminApi({ fetch: fetchFn, apiBaseUrl: API, token: TOKEN }), fetchFn };
}

const STATS = {
  generatedAt: '2026-10-17T12:00:00.000Z',
  days: 7,
  since: '2026-10-10T12:00:00.000Z',
  cycles: { total: 0, valid: 0, invalid: 0, unfinished: 0, recent: [] },
  harness: { overall: { runs: 0, errors: 0, rate: 0 }, byDay: [], versions: [] },
  tools: [],
  unknowns: [],
  llmClassified: [],
  compile: {
    deferrals: [],
    staleRuns: 0,
    hashChurn: { flagAt: 3, tools: [] },
    llm: { calls: 0, failedCalls: 0, tokensIn: 0, tokensOut: 0 },
  },
  incidents: { open: 0, resolved: 0, confirmed: 0, falsePositive: 0, pendingReview: 0, list: [] },
  canaries: [],
  slowest: [],
  groq: [],
  storage: { database: { bytes: 1, limitBytes: 2, percent: 50 }, tables: [], objects: null },
};

describe('createAdminApi', () => {
  it('reads the stats for a window with the bearer token and parses them', async () => {
    const { api: a, fetchFn } = api(ok(STATS));
    const r = await a.stats(3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.storage.database.percent).toBe(50);
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(API + '/admin/stats?days=3');
  });

  it('refuses stats of the wrong shape', async () => {
    const { api: a } = api(ok({ days: 7 }));
    expect(await a.stats()).toMatchObject({ ok: false });
  });

  it('reads the queue with the bearer token and parses it', async () => {
    const { api: a, fetchFn } = api(ok(queueBody));
    const r = await a.queue();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.pendingIncidents[0]?.toolSlug).toBe('resend-node');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/admin/queue`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(init.cache).toBe('no-store');
  });

  it('rejects an answer of the wrong shape instead of passing it on', async () => {
    const { api: a } = api(ok({ pendingIncidents: 'nope' }));
    const r = await a.queue();
    expect(r).toMatchObject({ ok: false });
  });

  it('turns 401 into a clear message without the token', async () => {
    const { api: a } = api(ok({ title: 'Unauthorized' }, 401));
    const r = await a.queue();
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('reports an unreachable API without the token or the address', async () => {
    const { api: a } = api(new TypeError(`fetch failed ${TOKEN}`));
    const r = await a.queue();
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain('api.example.com');
  });

  it('confirms an incident with the reviewed summary and fix', async () => {
    const { api: a, fetchFn } = api(ok({ ok: true }));
    const r = await a.confirm(ID, { summary: 'Reviewed', suggestedFix: 'Upgrade' });
    expect(r.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/admin/incidents/${ID}/confirm`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'Reviewed',
      suggestedFix: 'Upgrade',
    });
  });

  it('marks a false positive with a reason', async () => {
    const { api: a, fetchFn } = api(ok({ ok: true }));
    const r = await a.falsePositive(ID, { reason: 'Registry blip' });
    expect(r.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/admin/incidents/${ID}/false-positive`);
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Registry blip' });
  });

  it('refuses an id that is not a UUID before any request is made', async () => {
    const { api: a, fetchFn } = api(ok({ ok: true }));
    const r = await a.confirm('../../internal/uploads', { summary: 'x', suggestedFix: '' });
    expect(r).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('passes on the API reason for a 4xx', async () => {
    const { api: a } = api(
      new Response(
        JSON.stringify({ title: 'Conflict', status: 409, detail: 'Incident already reviewed.' }),
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    const r = await a.falsePositive(ID, { reason: 'x' });
    expect(r).toMatchObject({ ok: false, status: 409, message: 'Incident already reviewed.' });
  });
});
