import { describe, expect, it } from 'vitest';
import { filterAndSort, homeHref, parseHomeParams, DEFAULT_PARAMS } from './filters.js';
import type { ToolSummary } from './model.js';

// Filters and sort live in the URL (/?lang=node&status=failing&sort=name), so a view can be shared and the page
// is rendered on the server. Anything the URL says that we do not understand falls back to the default.

const tool = (slug: string, over: Partial<ToolSummary> = {}): ToolSummary => ({
  slug,
  name: slug,
  language: 'node',
  level: 3,
  docsUrl: `https://docs.${slug}.dev`,
  status: 'passing',
  statusSince: null,
  failingSince: null,
  lastRunAt: '2026-10-17T10:00:00Z',
  lastRunId: null,
  lastReachedLevel: 3,
  passRate: 1,
  decided30d: 10,
  streak: { kind: 'pass', count: 3 },
  strip: [],
  openIncidentId: null,
  ...over,
});

describe('parseHomeParams', () => {
  it('has sensible defaults: everything, failing first', () => {
    expect(parseHomeParams({})).toEqual(DEFAULT_PARAMS);
    expect(DEFAULT_PARAMS).toMatchObject({
      lang: 'all',
      status: 'all',
      level: 'all',
      sort: 'status',
      dir: 'asc',
    });
  });

  it('reads valid values', () => {
    expect(
      parseHomeParams({
        lang: 'python',
        status: 'failing',
        level: 'L3',
        sort: 'pass_rate',
        dir: 'desc',
      }),
    ).toEqual({
      lang: 'python',
      status: 'failing',
      level: 'L3',
      sort: 'pass_rate',
      dir: 'desc',
    });
  });

  it.each([
    [{ lang: 'cobol' }],
    [{ status: '<script>' }],
    [{ level: 'L9' }],
    [{ sort: 'drop table' }],
    [{ dir: 'sideways' }],
    [{ lang: ['node', 'python'] }],
  ])('falls back to the default for %j', (input) => {
    expect(parseHomeParams(input as Record<string, string | string[] | undefined>)).toEqual(
      DEFAULT_PARAMS,
    );
  });
});

describe('homeHref', () => {
  it('omits defaults, so the plain home page has no query', () => {
    expect(homeHref(DEFAULT_PARAMS)).toBe('/');
    expect(homeHref({ ...DEFAULT_PARAMS, lang: 'node' })).toBe('/?lang=node');
    expect(
      homeHref({ ...DEFAULT_PARAMS, lang: 'node', status: 'failing', sort: 'name', dir: 'desc' }),
    ).toBe('/?lang=node&status=failing&sort=name&dir=desc');
  });

  it('round-trips through parseHomeParams', () => {
    const p = {
      lang: 'python',
      status: 'verifying',
      level: 'L2',
      sort: 'checked',
      dir: 'desc',
    } as const;
    const query = Object.fromEntries(new URLSearchParams(homeHref(p).split('?')[1]));
    expect(parseHomeParams(query)).toEqual(p);
  });
});

describe('filterAndSort', () => {
  const tools = [
    tool('zeta-node', { status: 'passing', passRate: 0.9, lastRunAt: '2026-10-17T08:00:00Z' }),
    tool('alpha-node', { status: 'failing', passRate: 0.4, lastRunAt: '2026-10-17T09:00:00Z' }),
    tool('beta-python', {
      language: 'python',
      level: 2,
      status: 'verifying',
      passRate: 0.8,
      lastRunAt: '2026-10-17T10:00:00Z',
    }),
    tool('gamma-node', { status: 'passing', level: 2, passRate: null, lastRunAt: null }),
    tool('delta-python', {
      language: 'python',
      status: 'passing',
      passRate: 1,
      lastRunAt: '2026-10-17T07:00:00Z',
    }),
  ];
  const slugs = (p: Partial<typeof DEFAULT_PARAMS>) =>
    filterAndSort(tools, { ...DEFAULT_PARAMS, ...p }).map((t) => t.slug);

  it('by default shows failing first, then verifying, then passing, each by name', () => {
    expect(slugs({})).toEqual([
      'alpha-node',
      'beta-python',
      'delta-python',
      'gamma-node',
      'zeta-node',
    ]);
  });

  it('filters by language, status and level', () => {
    expect(slugs({ lang: 'python' })).toEqual(['beta-python', 'delta-python']);
    expect(slugs({ status: 'passing' })).toEqual(['delta-python', 'gamma-node', 'zeta-node']);
    expect(slugs({ level: 'L2' })).toEqual(['beta-python', 'gamma-node']);
    expect(slugs({ lang: 'python', status: 'passing', level: 'L3' })).toEqual(['delta-python']);
  });

  it('an L3 filter includes L4 tools (they reach the vendor too)', () => {
    const withL4 = [
      tool('a-node', { level: 4 }),
      tool('b-node', { level: 3 }),
      tool('c-node', { level: 2 }),
    ];
    expect(filterAndSort(withL4, { ...DEFAULT_PARAMS, level: 'L3' }).map((t) => t.slug)).toEqual([
      'a-node',
      'b-node',
    ]);
  });

  it('sorts by name, either way', () => {
    expect(slugs({ sort: 'name' })).toEqual([
      'alpha-node',
      'beta-python',
      'delta-python',
      'gamma-node',
      'zeta-node',
    ]);
    expect(slugs({ sort: 'name', dir: 'desc' })).toEqual([
      'zeta-node',
      'gamma-node',
      'delta-python',
      'beta-python',
      'alpha-node',
    ]);
  });

  it('sorts by pass rate with tools that have none last, in both directions', () => {
    expect(slugs({ sort: 'pass_rate' })).toEqual([
      'alpha-node',
      'beta-python',
      'zeta-node',
      'delta-python',
      'gamma-node',
    ]);
    expect(slugs({ sort: 'pass_rate', dir: 'desc' })).toEqual([
      'delta-python',
      'zeta-node',
      'beta-python',
      'alpha-node',
      'gamma-node',
    ]);
  });

  it('sorts by last checked (oldest first when ascending), never-checked last', () => {
    expect(slugs({ sort: 'checked' })).toEqual([
      'delta-python',
      'zeta-node',
      'alpha-node',
      'beta-python',
      'gamma-node',
    ]);
    expect(slugs({ sort: 'checked', dir: 'desc' })).toEqual([
      'beta-python',
      'alpha-node',
      'zeta-node',
      'delta-python',
      'gamma-node',
    ]);
  });

  it('is stable and does not change its input', () => {
    const copy = [...tools];
    filterAndSort(tools, { ...DEFAULT_PARAMS, sort: 'name' });
    expect(tools).toEqual(copy);
  });
});
