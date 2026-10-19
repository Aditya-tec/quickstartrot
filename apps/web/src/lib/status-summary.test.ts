import { describe, expect, it } from 'vitest';
import { PublicStatusSummary, type PublicStatus } from '@qsr/core/public';
import { buildHomeModel, type ToolSummary } from './model';
import { buildStatusSummary } from './status-summary';

// The numbers behind GET /api/status. They are the home page's numbers (same model), and nothing else.

const tool = (slug: string, level: number, status: PublicStatus): ToolSummary => ({
  slug,
  name: `Name of ${slug}`,
  language: 'node',
  level,
  docsUrl: 'https://example.test/docs',
  status,
  statusSince: null,
  failingSince: status === 'failing' ? '2026-10-12T00:00:00.000Z' : null,
  lastRunAt: slug === 'newest' ? '2026-10-18T12:00:00.000Z' : '2026-10-18T06:00:00.000Z',
  lastRunId: null,
  lastReachedLevel: level,
  passRate: null,
  decided30d: 0,
  streak: { kind: 'pass', count: 1 },
  strip: [],
  optedOutAt: null,
  historyHidden: false,
  coverageNotes: [],
  openIncidentId: null,
});

const model = () =>
  buildHomeModel([
    tool('newest', 3, 'passing'),
    tool('b', 3, 'passing'),
    tool('c', 2, 'passing'),
    tool('d', 2, 'verifying'),
    tool('e', 2, 'failing'),
    tool('f', 1, 'passing'),
    tool('g', 2, 'needs_person'),
    tool('h', 2, 'unknown'),
  ]);

describe('buildStatusSummary', () => {
  it('has the headline of the home page, its tiers, and the time the data is from', () => {
    const m = model();
    const s = buildStatusSummary(m);
    expect(s.asOf).toBe('2026-10-18T12:00:00.000Z');
    expect(s.headline).toEqual({
      passing: 4,
      tested: 6,
      failing: 1,
      verifying: 1,
      needsPerson: 1,
      notTested: 1,
      testedAtL3: 2,
      testedAtL2: 3,
      testedAtL1: 1,
      passingAtL3: 2,
      passingAtL2: 1,
      passingAtL1: 1,
    });
    expect(s.tiers).toEqual([
      { tier: 'L3', total: 2, passing: 2, verifying: 0, failing: 0 },
      { tier: 'L2', total: 3, passing: 1, verifying: 1, failing: 1 },
      { tier: 'L1', total: 1, passing: 1, verifying: 0, failing: 0 },
    ]);
  });

  it('is valid against the strict public schema, and carries no name, slug, date of failure or text', () => {
    const s = buildStatusSummary(model());
    expect(PublicStatusSummary.parse(s)).toEqual(s);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/Name of|newest|example\.test|2026-10-12|proves/);
  });

  it('is empty, not an error, before the first cycle', () => {
    const s = buildStatusSummary(buildHomeModel([]));
    expect(s.asOf).toBeNull();
    expect(s.headline.tested).toBe(0);
    expect(s.tiers).toEqual([]);
  });
});
