import { describe, expect, it } from 'vitest';
import { headlineText, tierBreakdown } from './headline.js';
import type { ToolSummary } from './model.js';
import type { PublicStatus } from '@qsr/core/public';

// The home page headline is level-aware: a pass at L2 (installed and built, not run against the vendor) proves
// less than a pass at L3 (the snippet reached the vendor's API), so both numbers are shown side by side.

const tool = (slug: string, status: PublicStatus, level: number): ToolSummary => ({
  slug,
  name: slug,
  language: 'node',
  level,
  docsUrl: 'https://x.dev',
  status,
  statusSince: null,
  failingSince: null,
  lastRunAt: null,
  lastRunId: null,
  lastReachedLevel: null,
  passRate: null,
  decided30d: 0,
  streak: { kind: 'pass', count: 0 },
  strip: [],
  optedOutAt: null,
  historyHidden: false,
  coverageNotes: [],
  openIncidentId: null,
});

describe('tierBreakdown', () => {
  const tools = [
    tool('a', 'passing', 3),
    tool('b', 'passing', 3),
    tool('c', 'failing', 3),
    tool('d', 'passing', 2),
    tool('e', 'verifying', 2),
    tool('f', 'passing', 1),
    tool('g', 'passing', 4),
  ];

  it('groups tested tools by what their test proves, deepest first', () => {
    const rows = tierBreakdown(tools);
    expect(rows.map((r) => r.tier)).toEqual(['L3', 'L2', 'L1']);
    expect(rows[0]).toMatchObject({ total: 4, passing: 3, failing: 1, verifying: 0 });
    expect(rows[1]).toMatchObject({ total: 2, passing: 1, failing: 0, verifying: 1 });
    expect(rows[2]).toMatchObject({ total: 1, passing: 1 });
  });

  it('says in words what each tier proves', () => {
    const rows = tierBreakdown(tools);
    expect(rows[0]?.proves).toMatch(/reached the vendor/i);
    expect(rows[1]?.proves).toMatch(/not run against the vendor/i);
    expect(rows[2]?.proves).toMatch(/install/i);
  });

  it('leaves out a tier with no tools, and ignores tools that are not tested', () => {
    const rows = tierBreakdown([
      tool('a', 'passing', 3),
      tool('b', 'unknown', 2),
      tool('c', 'needs_person', 2),
    ]);
    expect(rows.map((r) => r.tier)).toEqual(['L3']);
  });

  it('is empty for no tools', () => {
    expect(tierBreakdown([])).toEqual([]);
  });
});

describe('headlineText', () => {
  it('is "X of Y developer quickstarts work on a fresh machine right now"', () => {
    expect(headlineText(7, 9)).toEqual({
      lead: '7 of 9',
      rest: 'developer quickstarts work on a fresh machine right now',
    });
  });

  it('handles nothing tested yet without a misleading "0 of 0"', () => {
    expect(headlineText(0, 0)).toEqual({
      lead: 'No quickstarts',
      rest: 'have been tested yet',
    });
  });

  it('uses the singular for one', () => {
    expect(headlineText(1, 1)).toEqual({
      lead: '1 of 1',
      rest: 'developer quickstart works on a fresh machine right now',
    });
  });
});
