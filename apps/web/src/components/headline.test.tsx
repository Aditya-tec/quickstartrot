import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FACTS } from '@/lib/facts';
import type { ToolSummary } from '@/lib/model';
import { Headline } from './headline';

const tool = (slug: string, level: number): ToolSummary => ({
  slug,
  name: slug,
  language: 'node',
  level,
  docsUrl: 'https://example.test/docs',
  status: 'passing',
  statusSince: null,
  failingSince: null,
  lastRunAt: null,
  lastRunId: null,
  lastReachedLevel: level,
  passRate: null,
  decided30d: 0,
  streak: { kind: 'pass', count: 1 },
  strip: [],
  openIncidentId: null,
});

const props = {
  headline: {
    passing: 6,
    tested: 8,
    failing: 1,
    verifying: 1,
    needsPerson: 1,
    notTested: 1,
    testedAtL3: 5,
    testedAtL2: 3,
    testedAtL1: 0,
    passingAtL3: 4,
    passingAtL2: 2,
    passingAtL1: 0,
  },
  tested: [tool('a', 3), tool('b', 2)],
  asOf: '2026-10-17T12:00:00.000Z',
  facts: FACTS,
};

describe('the home headline links to the methodology', () => {
  const html = renderToStaticMarkup(<Headline {...props} />);

  it('to what each level proves', () => {
    expect(html).toContain('href="/methodology#levels"');
  });

  it('and to how well the monitor sees a broken quickstart, the measured limit of a pass', () => {
    expect(html).toContain('href="/methodology#detection"');
    expect(html).toMatch(/how well each level sees a broken quickstart/);
  });
});
