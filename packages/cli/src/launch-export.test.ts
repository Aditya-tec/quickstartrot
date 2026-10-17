import { describe, expect, it } from 'vitest';
import { LaunchExport } from '@qsr/core';
import { exportCommand, parseLaunchExport, renderLaunchMarkdown } from './launch-export.js';
import { recordingLogger } from './probe/probe.test-utils.js';

// `qsr export --launch` (P9a): the numbers a launch post needs, as Markdown and JSON, from reviewed and confirmed
// material only. It must refuse to print anything else, even if a server or a file said otherwise.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function seeded(over: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-10-30T12:00:00.000Z',
    tools: { tracked: 50, testedAtL3: 22, testedAtL2: 27, testedAtL1: 0, notYetRun: 1 },
    cycles: {
      valid: 27,
      invalid: 1,
      firstAt: '2026-10-17T12:00:00.000Z',
      lastAt: '2026-10-24T12:00:00.000Z',
    },
    runs: {
      total: 1350,
      perTool: [
        { slug: 'alpha-node', runs: 27, passes: 27, fails: 0 },
        { slug: 'beta-node', runs: 27, passes: 20, fails: 7 },
      ],
    },
    incidents: {
      confirmed: 2,
      byFailureClass: { API_DRIFT: 1, DEPENDENCY_RESOLUTION: 1 },
      coincidence: { docsOnly: 0, dependencyOnly: 1, both: 1, neither: 0, unknown: 0 },
      medianHoursToDetect: 12.5,
      medianHoursToConfirm: 3,
      list: [
        {
          id: ID(1),
          slug: 'beta-node',
          name: 'Beta (Node.js)',
          review: 'CONFIRMED',
          failureClass: 'API_DRIFT',
          state: 'OPEN',
          openedAt: '2026-10-23T05:00:00.000Z',
          confirmedAt: '2026-10-23T08:00:00.000Z',
          resolvedAt: null,
          docsChanged: true,
          dependencyChanged: true,
          summary: 'Beta 2.0 removed client.send | the quickstart still calls it.\nSecond line.',
          suggestedFix: 'Use client.emails.send.',
          toolPath: '/tools/beta-node',
          firstFailingRunPath: `/runs/${ID(50)}`,
          docsDiffPath: 'diffs/beta.diff',
        },
        {
          id: ID(2),
          slug: 'alpha-node',
          name: 'Alpha',
          review: 'CONFIRMED',
          failureClass: 'DEPENDENCY_RESOLUTION',
          state: 'RESOLVED',
          openedAt: '2026-10-20T05:00:00.000Z',
          confirmedAt: '2026-10-20T06:00:00.000Z',
          resolvedAt: '2026-10-21T05:00:00.000Z',
          docsChanged: false,
          dependencyChanged: true,
          summary: null,
          suggestedFix: null,
          toolPath: '/tools/alpha-node',
          firstFailingRunPath: null,
          docsDiffPath: null,
        },
      ],
    },
    ...over,
  };
}

describe('parseLaunchExport', () => {
  it('accepts a confirmed-only export', () => {
    expect(parseLaunchExport(seeded()).incidents.confirmed).toBe(2);
  });

  it.each(['PENDING_REVIEW', 'FALSE_POSITIVE'])(
    'REFUSES an export that contains a %s incident',
    (review) => {
      const data = seeded();
      (data.incidents.list[0] as { review: string }).review = review;
      expect(() => parseLaunchExport(data)).toThrow(/refus/i);
    },
  );

  it('refuses an export whose count does not match its list (something was left out or added)', () => {
    const data = seeded();
    data.incidents.confirmed = 3;
    expect(() => parseLaunchExport(data)).toThrow(/refus/i);
  });

  it('refuses something that is not an export at all', () => {
    expect(() => parseLaunchExport({ hello: 'world' })).toThrow(/refus/i);
    expect(() => parseLaunchExport(null)).toThrow(/refus/i);
  });
});

describe('renderLaunchMarkdown', () => {
  const md = renderLaunchMarkdown(parseLaunchExport(seeded()), 'https://quickstartrot.vercel.app/');

  it('gives the headline numbers, level by level, and never merges L2 into L3', () => {
    expect(md).toContain('50 quickstarts tracked');
    expect(md).toMatch(/22 tested at L3/);
    expect(md).toMatch(/27 tested at L2/);
    expect(md).toMatch(/1 not yet run/);
    expect(md).toMatch(/L2 proves less/i);
  });

  it('counts cycles and runs, and lists the runs per tool', () => {
    expect(md).toMatch(/27 valid cycles/);
    expect(md).toMatch(/1 invalid/);
    expect(md).toMatch(/1350 runs/);
    expect(md).toContain('| beta-node | 27 | 20 | 7 |');
  });

  it('breaks the confirmed incidents down by failure class, and by what changed', () => {
    expect(md).toMatch(/2 confirmed incidents/);
    expect(md).toContain('| API_DRIFT | 1 |');
    expect(md).toMatch(/docs changed and a dependency changed: 1/i);
    expect(md).toMatch(/only a dependency changed: 1/i);
    expect(md).toMatch(/only the docs changed: 0/i);
  });

  it('gives the median time to detect and to confirm', () => {
    expect(md).toMatch(/median time to detect: 12\.5 hours/i);
    expect(md).toMatch(/median time from detection to a person confirming it: 3\.0 hours/i);
  });

  it('lists each confirmed incident with evidence links built from the site URL (no double slash)', () => {
    expect(md).toContain('https://quickstartrot.vercel.app/tools/beta-node');
    expect(md).toContain(`https://quickstartrot.vercel.app/runs/${ID(50)}`);
    expect(md).not.toContain('vercel.app//');
    expect(md).toContain('Use client.emails.send.');
  });

  it('keeps reviewed text on one line each and safe in a table or list', () => {
    expect(md).toContain(
      'Beta 2.0 removed client.send | the quickstart still calls it. Second line.',
    );
  });

  it('says plainly when there are no confirmed incidents, and invents no number', () => {
    const none = renderLaunchMarkdown(
      parseLaunchExport(
        seeded({
          incidents: {
            confirmed: 0,
            byFailureClass: {},
            coincidence: { docsOnly: 0, dependencyOnly: 0, both: 0, neither: 0, unknown: 0 },
            medianHoursToDetect: null,
            medianHoursToConfirm: null,
            list: [],
          },
        }),
      ),
      'https://quickstartrot.vercel.app',
    );
    expect(none).toMatch(/No incident has been confirmed/i);
    expect(none).not.toMatch(/median time/i);
  });

  it('is deterministic', () => {
    expect(renderLaunchMarkdown(parseLaunchExport(seeded()), 'https://x.test')).toBe(
      renderLaunchMarkdown(parseLaunchExport(seeded()), 'https://x.test'),
    );
  });
});

describe('exportCommand', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) },
    };
  };
  const api = (data: unknown) => ({
    wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
    get: (async () => data) as never,
    post: (async () => ({})) as never,
  });

  it('needs --launch', async () => {
    const x = io();
    expect(await exportCommand([], recordingLogger(), x.io, api(seeded()))).toBe(2);
    expect(x.err.join('')).toMatch(/--launch/);
  });

  it('prints the Markdown and then the JSON', async () => {
    const x = io();
    expect(
      await exportCommand(
        ['--launch', '--site', 'https://x.test'],
        recordingLogger(),
        x.io,
        api(seeded()),
      ),
    ).toBe(0);
    const text = x.out.join('');
    expect(text).toContain('# Launch numbers');
    expect(text).toContain('```json');
    const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1] as string;
    expect(LaunchExport.parse(JSON.parse(json)).tools.tracked).toBe(50);
  });

  it('--json prints only the JSON, --md only the Markdown', async () => {
    const j = io();
    await exportCommand(['--launch', '--json'], recordingLogger(), j.io, api(seeded()));
    expect(() => JSON.parse(j.out.join(''))).not.toThrow();
    const m = io();
    await exportCommand(['--launch', '--md'], recordingLogger(), m.io, api(seeded()));
    expect(m.out.join('')).not.toContain('```json');
  });

  it('refuses, prints nothing, and exits 1 when the API sends an unconfirmed incident', async () => {
    const data = seeded();
    (data.incidents.list[1] as { review: string }).review = 'PENDING_REVIEW';
    const x = io();
    expect(await exportCommand(['--launch'], recordingLogger(), x.io, api(data))).toBe(1);
    expect(x.out).toEqual([]);
    expect(x.err.join('')).toMatch(/refus/i);
  });
});
