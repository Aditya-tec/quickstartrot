import { describe, expect, it } from 'vitest';
import { ShadowReportResponse } from '@qsr/core';
import { renderShadowReport, shadowReportCommand } from './shadow-report.js';
import { recordingLogger } from './probe/probe.test-utils.js';

// `qsr shadow-report --days N` (P9d): a plain rendering of GET /admin/shadow for the person who decides, in P9b, whether the export
// check is promoted into status. It states plainly that shadow answers are recorded and never acted on.

const seeded = (over: Partial<ShadowReportResponse> = {}): ShadowReportResponse =>
  ShadowReportResponse.parse({
    generatedAt: '2026-10-25T12:00:00.000Z',
    days: 7,
    since: '2026-10-18T12:00:00.000Z',
    totals: { cycles: 28, runs: 1400, withShadow: 1100, pass: 1040, fail: 40, skipped: 20 },
    tools: [
      {
        slug: 'ably-node',
        optOut: null,
        cycles: 28,
        withShadow: 28,
        pass: 28,
        fail: 0,
        skipped: 0,
        missing: [],
        notes: [],
        lastFailAt: null,
      },
      {
        slug: 'flaky-node',
        optOut: null,
        cycles: 28,
        withShadow: 28,
        pass: 20,
        fail: 8,
        skipped: 0,
        missing: [{ name: 'acme: A', cycles: 8 }],
        notes: [],
        lastFailAt: '2026-10-24T06:17:00.000Z',
      },
      {
        slug: 'launchdarkly-node',
        optOut: 'The docs snippet is TypeScript and shows no TypeScript-only syntax.',
        cycles: 28,
        withShadow: 28,
        pass: 0,
        fail: 0,
        skipped: 28,
        missing: [],
        notes: ['skipExportCheck: the docs snippet is TypeScript'],
        lastFailAt: null,
      },
      {
        slug: 'netty-node',
        optOut: null,
        cycles: 28,
        withShadow: 28,
        pass: 28,
        fail: 0,
        skipped: 0,
        missing: [],
        notes: [
          'qsr-check-exports: not checked, the package could not be loaded here: netty (blocked)',
        ],
        lastFailAt: null,
      },
      {
        slug: 'stable-node',
        optOut: null,
        cycles: 28,
        withShadow: 28,
        pass: 0,
        fail: 28,
        skipped: 0,
        missing: [
          { name: 'acme.sub', cycles: 28 },
          { name: 'acme: B', cycles: 28 },
        ],
        notes: [],
        lastFailAt: '2026-10-25T06:17:00.000Z',
      },
      {
        slug: 'install-only-node',
        optOut: null,
        cycles: 28,
        withShadow: 0,
        pass: 0,
        fail: 0,
        skipped: 0,
        missing: [],
        notes: [],
        lastFailAt: null,
      },
    ],
    falsePositiveCandidates: [
      {
        slug: 'flaky-node',
        failCycles: 8,
        checkedCycles: 28,
        stable: false,
        missing: ['acme: A'],
        reason: 'failed in 8 of 28 checked cycles: intermittent, so look at the environment',
      },
      {
        slug: 'stable-node',
        failCycles: 28,
        checkedCycles: 28,
        stable: true,
        missing: ['acme.sub', 'acme: B'],
        reason: 'failed in every cycle it was checked (28 of 28) with the same names',
      },
    ],
    ...over,
  });

describe('renderShadowReport', () => {
  const md = renderShadowReport(seeded());

  it('says what shadow mode is: recorded, never acted on, and that a failure is a candidate and not a verdict', () => {
    expect(md).toMatch(/^# Shadow report/);
    expect(md).toContain('last 7 days');
    expect(md).toMatch(/never acted on/i);
    expect(md).toMatch(/changes no status/i);
    expect(md).toMatch(/candidate/i);
  });

  it('gives the totals and one row per target with cycles, results and the missing names', () => {
    expect(md).toContain('28 cycles');
    expect(md).toContain('1100');
    expect(md).toContain('| flaky-node | 28 | 28 | 20 | 8 | 0 |');
    expect(md).toContain('acme: A (8)');
    expect(md).toContain('| install-only-node | 28 | 0 | 0 | 0 | 0 |');
  });

  it('marks the opted-out target with its reason, and a package that could not be loaded', () => {
    expect(md).toContain('opted out: The docs snippet is TypeScript');
    expect(md).toContain('not checked');
  });

  it('lists every failing target as a false-positive candidate, stable ones first, with why', () => {
    const section = md.slice(md.indexOf('## False-positive candidates'));
    expect(section.indexOf('stable-node')).toBeLessThan(section.indexOf('flaky-node'));
    expect(section).toContain('every cycle');
    expect(section).toContain('intermittent');
  });

  it('says so when nothing failed, and when there is no data yet', () => {
    const quiet = renderShadowReport(seeded({ falsePositiveCandidates: [] }));
    expect(quiet).toMatch(/False-positive candidates\s+None\./);
    const empty = renderShadowReport(
      seeded({
        tools: [],
        falsePositiveCandidates: [],
        totals: { cycles: 0, runs: 0, withShadow: 0, pass: 0, fail: 0, skipped: 0 },
      }),
    );
    expect(empty).toMatch(/no shadow results yet/i);
  });

  it('is deterministic', () => {
    expect(renderShadowReport(seeded())).toBe(renderShadowReport(seeded()));
  });
});

describe('shadowReportCommand', () => {
  const io = () => {
    let out = '';
    let err = '';
    return {
      io: { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t) },
      out: () => out,
      err: () => err,
    };
  };
  const api = (body: unknown, seen: string[]) => ({
    wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
    get: (async (p: string) => {
      seen.push(p);
      return body;
    }) as never,
  });

  it('asks for the window, parses the answer and prints the report', async () => {
    const seen: string[] = [];
    const x = io();
    expect(
      await shadowReportCommand(['--days', '3'], recordingLogger(), x.io, api(seeded(), seen)),
    ).toBe(0);
    expect(seen).toEqual(['/admin/shadow?days=3']);
    expect(x.out()).toContain('# Shadow report');
  });

  it('defaults to 7 days, refuses a bad window, and fails cleanly on an answer of the wrong shape', async () => {
    const seen: string[] = [];
    await shadowReportCommand([], recordingLogger(), io().io, api(seeded(), seen));
    expect(seen).toEqual(['/admin/shadow?days=7']);
    for (const days of ['0', '91', 'x', '1.5']) {
      const x = io();
      expect(
        await shadowReportCommand(['--days', days], recordingLogger(), x.io, api(seeded(), [])),
      ).toBe(2);
      expect(x.err()).toContain('--days');
    }
    const bad = io();
    expect(await shadowReportCommand([], recordingLogger(), bad.io, api({ days: 7 }, []))).toBe(1);
    expect(bad.err().length).toBeGreaterThan(0);
  });
});
