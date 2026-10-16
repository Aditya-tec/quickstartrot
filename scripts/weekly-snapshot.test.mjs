import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSnapshot, fetchSnapshot, SnapshotError } from './weekly-snapshot.mjs';

// The weekly snapshot (spec section 12, "Gotchas"): the public views, read with the anon key, committed to
// the repository as data/weekly-status.json. It keeps scheduled workflows alive (GitHub disables them after
// 60 days without repository activity) and doubles as a public, diffable history.

const NOW = new Date('2026-10-19T05:07:00.000Z');
const tool = (slug, over = {}) => ({
  slug,
  name: slug,
  docs_url: `https://docs.${slug}.dev`,
  language: 'node',
  level: 3,
  status: 'HEALTHY',
  status_since: '2026-10-01T00:00:00Z',
  last_run_at: '2026-10-19T03:00:00Z',
  pass_rate_30d: '0.9667',
  current_streak: 12,
  streak_kind: 'pass',
  ...over,
});

test('lists the tools sorted by slug, with the generation time in UTC', () => {
  const snap = buildSnapshot(
    { tools: [tool('zeta-node'), tool('alpha-node')], incidents: [] },
    NOW,
  );
  assert.equal(snap.generatedAt, '2026-10-19T05:07:00.000Z');
  assert.deepEqual(
    snap.tools.map((t) => t.slug),
    ['alpha-node', 'zeta-node'],
  );
});

test('summarises the statuses, so the file diff shows movement at a glance', () => {
  const snap = buildSnapshot(
    {
      tools: [
        tool('a-node'),
        tool('b-node', { status: 'BROKEN' }),
        tool('c-node', { status: 'HEALTHY' }),
      ],
      incidents: [],
    },
    NOW,
  );
  assert.deepEqual(snap.counts, { HEALTHY: 2, BROKEN: 1 });
  assert.equal(snap.total, 3);
});

test('keeps only the public fields of an incident, newest first', () => {
  const snap = buildSnapshot(
    {
      tools: [],
      incidents: [
        {
          id: 'i1',
          tool_slug: 'a-node',
          failure_class: 'API_DRIFT',
          state: 'OPEN',
          opened_at: '2026-10-01T00:00:00Z',
          summary: 's',
          suggested_fix: 'f',
          events: [{ big: 'x' }],
          internal: 'no',
        },
        {
          id: 'i2',
          tool_slug: 'b-node',
          failure_class: 'DOCS_SNIPPET_ERROR',
          state: 'RESOLVED',
          opened_at: '2026-10-05T00:00:00Z',
          resolved_at: '2026-10-06T00:00:00Z',
          summary: null,
        },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    snap.incidents.map((i) => i.id),
    ['i2', 'i1'],
  );
  assert.equal('internal' in snap.incidents[1], false);
  assert.equal('events' in snap.incidents[1], false);
});

test('the same input always gives the same bytes (so an unchanged week is an unchanged file)', () => {
  const input = { tools: [tool('b-node'), tool('a-node')], incidents: [] };
  assert.equal(
    JSON.stringify(buildSnapshot(input, NOW)),
    JSON.stringify(buildSnapshot({ tools: [...input.tools].reverse(), incidents: [] }, NOW)),
  );
});

test('never contains a canary, even if the view were to return one', () => {
  const snap = buildSnapshot(
    {
      tools: [tool('canary-pass-node'), tool('a-node')],
      incidents: [{ id: 'x', tool_slug: 'canary-fail-dep', opened_at: '2026-10-01T00:00:00Z' }],
    },
    NOW,
  );
  assert.deepEqual(
    snap.tools.map((t) => t.slug),
    ['a-node'],
  );
  assert.equal(snap.incidents.length, 0);
});

test('fetchSnapshot reads the two views with the anon key and nothing else', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(
      JSON.stringify(String(url).includes('public_tools') ? [tool('a-node')] : []),
      { status: 200 },
    );
  };
  const snap = await fetchSnapshot({
    url: 'https://abc.supabase.co/',
    anonKey: 'anon-key',
    fetch: fetchFn,
    now: NOW,
  });
  assert.equal(snap.tools.length, 1);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ['/rest/v1/public_tools', '/rest/v1/public_incidents'],
  );
  for (const c of calls) {
    assert.equal(c.headers.apikey, 'anon-key');
    assert.equal(c.headers.Authorization, 'Bearer anon-key');
  }
});

test('a refused or failing read is a SnapshotError that does not contain the key', async () => {
  const fetchFn = async () => new Response('denied', { status: 401 });
  await assert.rejects(
    fetchSnapshot({
      url: 'https://abc.supabase.co',
      anonKey: 'anon-key',
      fetch: fetchFn,
      now: NOW,
    }),
    (err) =>
      err instanceof SnapshotError &&
      err.message.includes('401') &&
      !err.message.includes('anon-key'),
  );
});
