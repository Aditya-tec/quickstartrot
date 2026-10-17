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

  it('public_runs hides the cause of an unreviewed failure and publishes a confirmed one (migration 0006)', async () => {
    type Step = { stderr_tail: string | null; log_path: string | null };
    type Row = {
      outcome: string;
      failure_class: string | null;
      failure_signature: string | null;
      details_published: boolean;
      steps: Step[];
    };
    const pending = (
      await anon(
        `public_runs?tool_slug=eq.${SEED_SLUGS.pending}&outcome=eq.FAIL&select=outcome,failure_class,failure_signature,details_published,steps`,
      )
    ).body as Row[];
    expect(pending.length).toBeGreaterThan(0);
    for (const r of pending) {
      expect(r.details_published).toBe(false);
      expect(r.failure_class).toBeNull();
      expect(r.failure_signature).toBeNull();
      expect(r.steps.every((s) => s.stderr_tail === null && s.log_path === null)).toBe(true);
    }
    expect(JSON.stringify(pending)).not.toContain('client.send is not a function');

    const confirmed = (
      await anon(
        `public_runs?tool_slug=eq.${SEED_SLUGS.confirmed}&outcome=eq.FAIL&select=outcome,failure_class,failure_signature,details_published,steps`,
      )
    ).body as Row[];
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed.every((r) => r.details_published && r.failure_class !== null)).toBe(true);
    expect(confirmed.every((r) => r.failure_signature === 'seed-sig-confirmed')).toBe(true);
    // the confirmed incident's steps keep their output; the pending tool's are blank (checked above)
    expect(JSON.stringify(confirmed)).toContain('added 1 package');
  });

  it('public_run_history has one light row per run, no cause, newest first, ranked (migration 0006)', async () => {
    const { body } = await anon(
      `public_run_history?tool_slug=like.seed-*&select=tool_slug,kind,rn,run_id,started_at&order=started_at.desc`,
    );
    const rows = body as { tool_slug: string; kind: string; rn: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((r) => r.tool_slug === SEED_SLUGS.pending).every((r) => r.kind === 'fail'),
    ).toBe(true);
    expect(
      rows.filter((r) => r.tool_slug === SEED_SLUGS.healthy).every((r) => r.kind === 'pass'),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain('client.send');
    expect(Object.keys((body as object[])[0] as object).sort()).toEqual(
      ['kind', 'rn', 'run_id', 'started_at', 'tool_slug'].sort(),
    );
  });

  it('public_tools carries the latest run of each tool (migration 0006)', async () => {
    const { body } = await anon(
      `public_tools?slug=eq.${SEED_SLUGS.healthy}&select=slug,last_run_id,last_outcome,last_reached_level,decided_30d`,
    );
    const row = (body as { last_run_id: string | null; last_outcome: string | null }[])[0];
    expect(row?.last_run_id).toBeTruthy();
    expect(row?.last_outcome).toBe('PASS');
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
        ['public_run_history', 'tool_slug'],
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
