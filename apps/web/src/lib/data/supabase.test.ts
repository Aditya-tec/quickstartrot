import { describe, expect, it } from 'vitest';
import {
  DataError,
  PUBLIC_VIEWS,
  SupabaseDataSource,
  type ViewClient,
  type ViewQuery,
} from './supabase.js';

// The only code in the app that talks to the database. It reads the four public views and nothing else, every
// row is parsed with a Zod schema from @qsr/core at this boundary, and a failure never carries a key.

const ANON_KEY = 'anon-key-do-not-leak-0123456789';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const toolRow = (n: number) => ({
  slug: `tool-${n}`,
  name: `Tool ${n}`,
  docs_url: 'https://docs.example.dev',
  language: 'node',
  level: 3,
  status: 'HEALTHY',
  status_since: null,
  last_run_at: null,
  pass_rate_30d: '1.0000',
  current_streak: 1,
  streak_kind: 'pass',
  last_run_id: null,
  last_outcome: null,
  last_reached_level: null,
  last_skip_reason: null,
  decided_30d: 0,
});
const historyRow = (n: number, rn = n) => ({
  run_id: id(n),
  tool_slug: 'tool-1',
  started_at: '2026-10-17T12:00:00Z',
  outcome: 'PASS',
  kind: 'pass',
  reached_level: 3,
  target_level: 3,
  stale: false,
  duration_ms: 100,
  rn,
});

interface Call {
  view: string;
  filters: [string, unknown][];
  range: [number, number] | null;
  order: string | null;
}

/** A fake of the part of supabase-js the data source uses. `tables` maps a view to its rows. */
function fakeClient(
  tables: Record<string, unknown[]>,
  error: { message: string } | null = null,
  pageCap = 1000,
) {
  const calls: Call[] = [];
  const client: ViewClient = {
    from(view: string) {
      const call: Call = { view, filters: [], range: null, order: null };
      calls.push(call);
      const query: ViewQuery = {
        select: () => query,
        eq: (c: string, v: unknown) => (call.filters.push(['eq', [c, v]]), query),
        lte: (c: string, v: unknown) => (call.filters.push(['lte', [c, v]]), query),
        order: (c: string) => ((call.order = c), query),
        range: (a: number, b: number) => ((call.range = [a, b]), query),
        limit: () => query,
        then: (
          resolve: (r: { data: unknown[] | null; error: { message: string } | null }) => void,
        ) => {
          if (error) return resolve({ data: null, error });
          const rows = tables[view] ?? [];
          const [from, to] = call.range ?? [0, pageCap - 1];
          resolve({ data: rows.slice(from, Math.min(to, from + pageCap - 1) + 1), error: null });
        },
      } as unknown as ViewQuery;
      return query;
    },
  };
  return { client, calls };
}

describe('SupabaseDataSource', () => {
  it('reads tools, parsing each row (a numeric string becomes a number)', async () => {
    const { client } = fakeClient({ public_tools: [toolRow(1), toolRow(2)] });
    const tools = await new SupabaseDataSource(client).listTools();
    expect(tools.map((t) => t.slug)).toEqual(['tool-1', 'tool-2']);
    expect(tools[0]?.pass_rate_30d).toBe(1);
  });

  it('only ever queries the four public views', async () => {
    const { client, calls } = fakeClient({
      public_tools: [toolRow(1)],
      public_run_history: [historyRow(1)],
      public_incidents: [],
      public_runs: [],
    });
    const source = new SupabaseDataSource(client);
    await source.listTools();
    await source.listHistory(28);
    await source.listToolHistory('tool-1', 60);
    await source.listIncidents();
    await source.getRun(id(1));
    const views = new Set(calls.map((c) => c.view));
    expect([...views].sort()).toEqual([...PUBLIC_VIEWS].sort());
    expect(PUBLIC_VIEWS).toEqual([
      'public_tools',
      'public_run_history',
      'public_incidents',
      'public_runs',
    ]);
  });

  it('limits history by rank: the newest N runs of each tool', async () => {
    const { client, calls } = fakeClient({ public_run_history: [historyRow(1)] });
    await new SupabaseDataSource(client).listHistory(28);
    expect(calls[0]?.filters).toContainEqual(['lte', ['rn', 28]]);
  });

  it('asks for one tool history by slug and one run by id', async () => {
    const { client, calls } = fakeClient({ public_run_history: [], public_runs: [] });
    const source = new SupabaseDataSource(client);
    await source.listToolHistory('resend-node', 60);
    expect(calls[0]?.filters).toContainEqual(['eq', ['tool_slug', 'resend-node']]);
    expect(await source.getRun(id(5))).toBeNull();
    expect(calls[1]?.filters).toContainEqual(['eq', ['id', id(5)]]);
  });

  it('reads past the 1000-row limit PostgREST applies, page by page', async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => historyRow(i + 1, (i % 60) + 1));
    const { client, calls } = fakeClient({ public_run_history: rows });
    const out = await new SupabaseDataSource(client).listHistory(60);
    expect(out).toHaveLength(2300);
    expect(calls.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('refuses a row that does not match its schema, naming the view and the field but not the row', async () => {
    const bad = { ...toolRow(1), status: 'FINE', docs_url: 'secret-looking-value-xyz' };
    const { client } = fakeClient({ public_tools: [bad] });
    const err = (await new SupabaseDataSource(client)
      .listTools()
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(DataError);
    expect(err.message).toContain('public_tools');
    expect(err.message).toContain('status');
    expect(err.message).not.toContain('secret-looking-value-xyz');
  });

  it('turns a database error into a DataError that carries no key', async () => {
    const { client } = fakeClient({}, { message: `JWT invalid for ${ANON_KEY}` });
    const err = (await new SupabaseDataSource(client)
      .listIncidents()
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(DataError);
    expect(err.message).toContain('public_incidents');
    expect(err.message).not.toContain(ANON_KEY);
  });

  it('parses a run with its steps and masks nothing itself (masking is sanitizeRun and the view)', async () => {
    const run = {
      id: id(1),
      tool_slug: 'tool-1',
      cycle_id: id(2),
      attempt: 1,
      outcome: 'PASS',
      failure_class: null,
      failure_signature: null,
      failed_step_id: null,
      image_digest: 'sha256:abc',
      runner_env: { node: 'v22' },
      duration_ms: 10,
      started_at: '2026-10-17T12:00:00Z',
      finished_at: '2026-10-17T12:00:01Z',
      snapshot_hash: null,
      plan_ir: null,
      grounding_report: null,
      steps: [
        {
          step_id: 's1',
          ordinal: 0,
          kind: 'shell',
          outcome: 'PASS',
          exit_code: 0,
          duration_ms: 5,
          stdout_tail: null,
          stderr_tail: null,
          log_path: null,
        },
      ],
      details_published: true,
      reached_level: 3,
      skip_reason: null,
      plan_compiler_version: null,
      plan_truncation: null,
      plan_stale: false,
      snapshot_blocks: null,
      snapshot_title: null,
      snapshot_url: null,
    };
    const { client } = fakeClient({ public_runs: [run] });
    const got = await new SupabaseDataSource(client).getRun(id(1));
    expect(got?.steps[0]?.step_id).toBe('s1');
  });
});
