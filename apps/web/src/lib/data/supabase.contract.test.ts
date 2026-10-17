import { describe, expect, it } from 'vitest';
import { createSupabaseDataSource } from './supabase';

// Contract test: the REAL SupabaseDataSource against the live public views. Every row is parsed with the Zod
// schemas from @qsr/core inside the data source, so a view that drifts from the schema fails here. Runs only when
// the Supabase URL and the PUBLIC anon key are in the environment (CI has neither: it is skipped there).
//   node --env-file=../../.env node_modules/vitest/vitest.mjs run src/lib/data/supabase.contract.test.ts

const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
const live = Boolean(url && anonKey);

describe.skipIf(!live)('SupabaseDataSource against the live public views', () => {
  const source = () => createSupabaseDataSource(url as string, anonKey as string);

  it('reads the tools and parses every row', async () => {
    const tools = await source().listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('never exposes a canary', async () => {
    const s = source();
    const tools = await s.listTools();
    expect(tools.filter((t) => t.slug.startsWith('canary-'))).toEqual([]);
    const history = await s.listHistory(5);
    expect(history.filter((h) => h.tool_slug.startsWith('canary-'))).toEqual([]);
    const incidents = await s.listIncidents();
    expect(incidents.filter((i) => i.tool_slug.startsWith('canary-'))).toEqual([]);
  });

  it('reads the history, newest first per tool, at most the requested number', async () => {
    const history = await source().listHistory(28);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((h) => h.rn >= 1 && h.rn <= 28)).toBe(true);
  });

  it('lists only confirmed incidents', async () => {
    const incidents = await source().listIncidents();
    expect(incidents.every((i) => i.review === 'CONFIRMED')).toBe(true);
  });

  it('opens the latest run of a tool: plan, steps and environment parse', async () => {
    const s = source();
    const withRun = (await s.listTools()).find((t) => t.last_run_id);
    expect(withRun).toBeDefined();
    const run = await s.getRun(withRun?.last_run_id as string);
    expect(run).not.toBeNull();
    expect(run?.steps.length).toBeGreaterThan(0);
    expect(run?.image_digest.length).toBeGreaterThan(0);
  });

  it('answers null for a run that does not exist', async () => {
    expect(await source().getRun('00000000-0000-4000-8000-00000000dead')).toBeNull();
  });

  it('a failed run without a confirmed incident arrives with its details removed by the view', async () => {
    const s = source();
    const incidents = await s.listIncidents();
    const confirmedSlugs = new Set(incidents.map((i) => i.tool_slug));
    const failedUnconfirmed = (await s.listHistory(60)).filter(
      (h) => h.kind === 'fail' && !confirmedSlugs.has(h.tool_slug),
    );
    for (const h of failedUnconfirmed.slice(0, 5)) {
      const run = await s.getRun(h.run_id);
      expect(run?.failure_signature ?? null).toBeNull();
      expect(run?.steps.every((st) => st.stdout_tail === null && st.stderr_tail === null)).toBe(
        true,
      );
    }
  });
});
