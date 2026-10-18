import { describe, expect, it } from 'vitest';
import { L3ShadowReportResponse } from '@qsr/core';
import { l3ShadowReportCommand, renderL3ShadowReport } from './l3-shadow-report.js';
import { recordingLogger } from './probe/probe.test-utils.js';

// `qsr l3-shadow-report --days N` (shadow-L3): a plain rendering of GET /admin/l3-shadow for the person who decides whether a shadow
// target may start to count at L3. It says plainly that shadow answers are recorded and never acted on, shows the exact observed text and
// the ambiguous results, and gives a promotion-ready verdict that PROMOTES NOTHING.

const seeded = (over: Partial<L3ShadowReportResponse> = {}): L3ShadowReportResponse =>
  L3ShadowReportResponse.parse({
    generatedAt: '2026-10-25T12:00:00.000Z',
    days: 7,
    since: '2026-10-18T12:00:00.000Z',
    tools: [
      {
        slug: 'ready-python',
        reason: 'New L3 step: observed before it counts',
        cycles: 28,
        withRecord: 28,
        verdicts: { evidence: 28 },
        patterns: [{ pattern: 'http_401_403', cycles: 28 }],
        observed: [
          {
            text: 'anthropic.AuthenticationError: Error code: 401 - invalid x-api-key',
            cycles: 28,
          },
        ],
        ambiguous: 0,
        lastAt: '2026-10-25T06:17:00.000Z',
        promotion: { ready: true, cleanCycles: 28, blockers: [] },
      },
      {
        slug: 'odd-node',
        reason: 'New L3 step',
        cycles: 28,
        withRecord: 27,
        verdicts: { evidence: 20, no_evidence: 5, error_no_evidence: 2 },
        patterns: [{ pattern: 'http_401_403', cycles: 20 }],
        observed: [
          { text: 'status code 401 | with a pipe', cycles: 20 },
          { text: 'Hello world!', cycles: 5 },
          { text: 'connect ECONNREFUSED', cycles: 2 },
        ],
        ambiguous: 7,
        lastAt: '2026-10-25T06:17:00.000Z',
        promotion: {
          ready: false,
          cleanCycles: 20,
          blockers: ['7 results without evidence', '1 cycle ran without a record'],
        },
      },
      {
        slug: 'new-node',
        reason: null,
        cycles: 1,
        withRecord: 0,
        verdicts: {},
        patterns: [],
        observed: [],
        ambiguous: 0,
        lastAt: null,
        promotion: {
          ready: false,
          cleanCycles: 0,
          blockers: ['only 0 cycles with a record (need 8)'],
        },
      },
    ],
    ...over,
  });

describe('renderL3ShadowReport', () => {
  const md = renderL3ShadowReport(seeded());

  it("says what shadow-L3 is: recorded, never acted on, and that promotion is a person's decision", () => {
    expect(md).toMatch(/^# L3 shadow report/);
    expect(md).toContain('last 7 days');
    expect(md).toMatch(/never acted on/i);
    expect(md).toMatch(/changes no level, status, incident, badge or public page/i);
    expect(md).toMatch(/promotion needs a person/i);
  });

  it('gives one row per target with cycles, records, verdicts, evidence and the promotion verdict', () => {
    expect(md).toContain('| ready-python | 28 | 28 |');
    expect(md).toContain('evidence 28');
    expect(md).toContain('http_401_403 (28)');
    expect(md).toContain('| odd-node | 28 | 27 |');
    expect(md).toContain('evidence 20, no_evidence 5, error_no_evidence 2');
    expect(md).toMatch(/\| ready-python .*ready/);
    expect(md).toMatch(/\| odd-node .*not ready/);
  });

  it('shows the exact observed text per target, with how many cycles produced it, and nothing breaks the table', () => {
    expect(md).toContain('28 x');
    expect(md).toContain('anthropic.AuthenticationError: Error code: 401 - invalid x-api-key');
    expect(md).toContain('status code 401 / with a pipe');
  });

  it('lists the ambiguous results and the reasons a target is not ready', () => {
    const section = md.slice(md.indexOf('## Not ready'));
    expect(section).toContain('odd-node');
    expect(section).toContain('7 results without evidence');
    expect(section).toContain('only 0 cycles with a record');
    expect(section).not.toContain('ready-python');
  });

  it('says so when there are no shadow targets yet', () => {
    expect(renderL3ShadowReport(seeded({ tools: [] }))).toMatch(/no shadow-L3 targets/i);
  });

  it('is deterministic', () => {
    expect(renderL3ShadowReport(seeded())).toBe(renderL3ShadowReport(seeded()));
  });
});

describe('l3ShadowReportCommand', () => {
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
      await l3ShadowReportCommand(['--days', '3'], recordingLogger(), x.io, api(seeded(), seen)),
    ).toBe(0);
    expect(seen).toEqual(['/admin/l3-shadow?days=3']);
    expect(x.out()).toContain('# L3 shadow report');
  });

  it('defaults to 7 days, refuses a bad window, and fails cleanly on an answer of the wrong shape', async () => {
    const seen: string[] = [];
    await l3ShadowReportCommand([], recordingLogger(), io().io, api(seeded(), seen));
    expect(seen).toEqual(['/admin/l3-shadow?days=7']);
    for (const days of ['0', '91', 'x', '1.5']) {
      const x = io();
      expect(
        await l3ShadowReportCommand(['--days', days], recordingLogger(), x.io, api(seeded(), [])),
      ).toBe(2);
      expect(x.err()).toContain('--days');
    }
    const bad = io();
    expect(await l3ShadowReportCommand([], recordingLogger(), bad.io, api({ days: 7 }, []))).toBe(
      1,
    );
    expect(bad.err().length).toBeGreaterThan(0);
  });
});
