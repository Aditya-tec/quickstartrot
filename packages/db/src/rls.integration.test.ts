import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { BASE_TABLES, PUBLIC_VIEWS } from './schema.js';
import { SEED_SLUGS, seed, unseed } from './seed.js';

// P1 acceptance (spec section 15): "a test proves the anon key can read the views and gets nothing
// from base tables". Runs against the live Supabase project; skipped when env is not provided
// (e.g. in CI). Seeds rows prefixed `seed-` and removes them afterwards.
const SUPABASE_URL = process.env['SUPABASE_URL'];
const ANON_KEY = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
const DATABASE_URL = process.env['DATABASE_URL'];
const enabled = Boolean(SUPABASE_URL && ANON_KEY && DATABASE_URL);

async function anon(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY ?? '',
      Authorization: `Bearer ${ANON_KEY ?? ''}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

describe.skipIf(!enabled)('RLS: anon key against live Supabase', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL ?? '', { max: 1 });
    await seed(handle.db);
    // Make sure PostgREST has picked up the views.
    await handle.sql.unsafe(`NOTIFY pgrst, 'reload schema'`);
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    await unseed(handle.db);
    await handle.close();
  }, 60_000);

  it.each(BASE_TABLES)('anon gets nothing from base table %s', async (table) => {
    const { status, body } = await anon(`${table}?select=*&limit=5`);
    const rows = Array.isArray(body) ? body : [];
    expect(rows).toHaveLength(0);
    expect([200, 401, 403]).toContain(status);
  });

  it.each(BASE_TABLES)('anon cannot write to base table %s', async (table) => {
    const { status } = await anon(table, { method: 'POST', body: JSON.stringify({}) });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it.each(PUBLIC_VIEWS)('anon can read view %s', async (view) => {
    const { status, body } = await anon(`${view}?select=*&limit=50`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it.each(PUBLIC_VIEWS)('anon cannot write to view %s', async (view) => {
    const { status } = await anon(view, { method: 'POST', body: JSON.stringify({}) });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('public_tools maps unreviewed BROKEN to DEGRADED and confirmed BROKEN to BROKEN', async () => {
    const { body } = await anon(
      `public_tools?slug=like.seed-*&select=slug,status,pass_rate_30d,current_streak,streak_kind`,
    );
    const bySlug = new Map(
      (body as { slug: string; status: string; pass_rate_30d: string | number | null }[]).map(
        (r) => [r.slug, r],
      ),
    );
    expect(bySlug.get(SEED_SLUGS.healthy)?.status).toBe('HEALTHY');
    expect(bySlug.get(SEED_SLUGS.pending)?.status).toBe('DEGRADED');
    expect(bySlug.get(SEED_SLUGS.confirmed)?.status).toBe('BROKEN');
    // The run in the invalid cycle is ignored, so the healthy tool is at 100%.
    expect(Number(bySlug.get(SEED_SLUGS.healthy)?.pass_rate_30d)).toBe(1);
    expect(Number(bySlug.get(SEED_SLUGS.pending)?.pass_rate_30d)).toBe(0);
  });

  it('public_runs excludes runs from invalid cycles and embeds ordered steps', async () => {
    const { body } = await anon(
      `public_runs?tool_slug=eq.${SEED_SLUGS.healthy}&select=outcome,steps,plan_ir,grounding_report,snapshot_hash`,
    );
    const rows = body as {
      outcome: string;
      steps: { ordinal: number }[];
      grounding_report: unknown;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.outcome === 'PASS')).toBe(true);
    expect(rows[0]?.steps.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(rows[0]?.grounding_report).toEqual({ ok: true, violations: [] });
  });

  it('public_incidents lists only CONFIRMED incidents and hides internal notes', async () => {
    const { body } = await anon(
      `public_incidents?tool_slug=like.seed-*&select=tool_slug,review,events`,
    );
    const rows = body as { tool_slug: string; review: string; events: { type: string }[] }[];
    expect(rows.map((r) => r.tool_slug)).toEqual([SEED_SLUGS.confirmed]);
    expect(rows[0]?.review).toBe('CONFIRMED');
    expect(rows[0]?.events.map((e) => e.type)).toEqual(['opened', 'confirmed']);
  });

  it('disabled tools disappear from every view (opt-out hides history)', async () => {
    await handle.sql.unsafe(
      `update tools set enabled = false where slug = '${SEED_SLUGS.confirmed}'`,
    );
    try {
      for (const [view, col] of [
        ['public_tools', 'slug'],
        ['public_runs', 'tool_slug'],
        ['public_incidents', 'tool_slug'],
      ] as const) {
        const { body } = await anon(`${view}?${col}=eq.${SEED_SLUGS.confirmed}&select=${col}`);
        expect(body).toEqual([]);
      }
    } finally {
      await handle.sql.unsafe(
        `update tools set enabled = true where slug = '${SEED_SLUGS.confirmed}'`,
      );
    }
  });
});
