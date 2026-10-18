import { describe, expect, it } from 'vitest';
import { FREE_TIER, StatsResponse } from '@qsr/core';
import { calibrationCommand, formatBytes, renderCalibrationReport } from './calibration.js';
import { recordingLogger } from './probe/probe.test-utils.js';

// `qsr calibration-report --days 7` (P9a): the Markdown a person reads at the end of the 7-day calibration run
// (P9b) to decide what to fix. It is a pure rendering of GET /admin/stats, so it is tested with seeded data.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function seeded(over: Partial<StatsResponse> = {}): StatsResponse {
  return StatsResponse.parse({
    generatedAt: '2026-10-24T12:00:00.000Z',
    days: 7,
    since: '2026-10-17T12:00:00.000Z',
    cycles: {
      total: 28,
      valid: 26,
      invalid: 1,
      unfinished: 1,
      recent: [
        {
          id: ID(1),
          startedAt: '2026-10-24T11:00:00.000Z',
          trigger: 'cron',
          valid: false,
          canaryOk: false,
          durationSeconds: 1500,
          tools: 50,
          harnessErrors: 4,
          problems: ['canary-pass-node: expected PASS, got FAIL'],
        },
        {
          id: ID(2),
          startedAt: '2026-10-24T05:00:00.000Z',
          trigger: 'cron',
          valid: true,
          canaryOk: true,
          durationSeconds: 1380,
          tools: 50,
          harnessErrors: 0,
          problems: [],
        },
      ],
    },
    harness: {
      overall: { runs: 1400, errors: 14, rate: 0.01 },
      byDay: [
        { day: '2026-10-22', runs: 200, errors: 0, rate: 0 },
        { day: '2026-10-23', runs: 200, errors: 2, rate: 0.01 },
        { day: '2026-10-24', runs: 100, errors: 4, rate: 0.04 },
      ],
      versions: [
        {
          version: 1,
          runs: 1000,
          firstAt: '2026-10-18T06:17:00.000Z',
          lastAt: '2026-10-24T18:17:00.000Z',
        },
        {
          version: 2,
          runs: 400,
          firstAt: '2026-10-25T00:17:00.000Z',
          lastAt: '2026-10-25T06:17:00.000Z',
        },
      ],
    },
    tools: [
      {
        slug: 'alpha-node',
        name: 'Alpha',
        enabled: true,
        level: 3,
        status: 'HEALTHY',
        pass: 26,
        fail: 0,
        skipped: 0,
        harnessErrors: 0,
        notRun: 0,
        deferred: 0,
        staleRuns: 0,
        flakeScore: 0,
        flipping: false,
        medianDurationMs: 21_000,
        maxDurationMs: 30_000,
      },
      {
        slug: 'beta-node',
        name: 'Beta',
        enabled: true,
        level: 2,
        status: 'DEGRADED',
        pass: 12,
        fail: 12,
        skipped: 0,
        harnessErrors: 1,
        notRun: 1,
        deferred: 2,
        staleRuns: 3,
        flakeScore: 0.8,
        flipping: true,
        medianDurationMs: 95_000,
        maxDurationMs: 140_000,
      },
      {
        slug: 'gone-node',
        name: 'Gone',
        enabled: false,
        level: 2,
        status: 'UNKNOWN',
        pass: 3,
        fail: 0,
        skipped: 0,
        harnessErrors: 0,
        notRun: 0,
        deferred: 0,
        staleRuns: 0,
        flakeScore: 0,
        flipping: false,
        medianDurationMs: null,
        maxDurationMs: null,
      },
    ],
    unknowns: [
      {
        runId: ID(10),
        slug: 'beta-node',
        startedAt: '2026-10-23T05:00:00.000Z',
        failedStepId: 's3',
        evidenceLine: 'weird error | with a pipe and a `tick`',
      },
      {
        runId: ID(11),
        slug: 'gamma-python',
        startedAt: '2026-10-23T11:00:00.000Z',
        failedStepId: null,
        evidenceLine: null,
      },
    ],
    llmClassified: [
      {
        runId: ID(12),
        slug: 'beta-node',
        createdAt: '2026-10-22T05:00:00.000Z',
        failureClass: 'API_DRIFT',
        confidence: 0.82,
        evidenceLine: 'x is not a function',
      },
    ],
    compile: {
      deferrals: [{ slug: 'beta-node', count: 2, reasons: { llm_budget: 1, llm_unavailable: 1 } }],
      staleRuns: 3,
      llm: { calls: 40, failedCalls: 2, tokensIn: 100_000, tokensOut: 20_000 },
      hashChurn: {
        flagAt: 3,
        tools: [
          { slug: 'ably-python', distinctHashes: 5, flagged: true },
          { slug: 'beta-node', distinctHashes: 2, flagged: false },
        ],
      },
    },
    incidents: {
      open: 2,
      resolved: 1,
      confirmed: 1,
      falsePositive: 1,
      pendingReview: 1,
      list: [
        {
          id: ID(20),
          slug: 'beta-node',
          state: 'OPEN',
          review: 'CONFIRMED',
          failureClass: 'API_DRIFT',
          openedAt: '2026-10-23T05:00:00.000Z',
          confirmedAt: '2026-10-23T09:00:00.000Z',
          resolvedAt: null,
          docsChanged: true,
        },
        {
          id: ID(21),
          slug: 'alpha-node',
          state: 'RESOLVED',
          review: 'FALSE_POSITIVE',
          failureClass: 'NETWORK_TRANSIENT',
          openedAt: '2026-10-20T05:00:00.000Z',
          confirmedAt: null,
          resolvedAt: '2026-10-21T05:00:00.000Z',
          docsChanged: false,
        },
        {
          id: ID(22),
          slug: 'gamma-python',
          state: 'OPEN',
          review: 'PENDING_REVIEW',
          failureClass: 'DOCS_SNIPPET_ERROR',
          openedAt: '2026-10-24T05:00:00.000Z',
          confirmedAt: null,
          resolvedAt: null,
          docsChanged: null,
        },
      ],
    },
    canaries: [
      { slug: 'canary-fail-drift', runs: 28, expected: 'FAIL', matched: 28, mismatched: 0 },
      { slug: 'canary-pass-node', runs: 28, expected: 'PASS', matched: 27, mismatched: 1 },
    ],
    slowest: [{ slug: 'beta-node', medianDurationMs: 95_000, maxDurationMs: 140_000 }],
    groq: [
      { day: '2026-10-23', calls: 20, failedCalls: 1, tokens: 60_000 },
      { day: '2026-10-24', calls: 20, failedCalls: 1, tokens: 60_000 },
    ],
    storage: {
      database: { bytes: 120 * 1024 * 1024, limitBytes: FREE_TIER.databaseBytes, percent: 24 },
      tables: [{ name: 'runs', rows: 9000, bytes: 40 * 1024 * 1024 }],
      objects: {
        publicBytes: 300 * 1024 * 1024,
        privateBytes: 20 * 1024 * 1024,
        publicCount: 12_000,
        privateCount: 80,
        totalBytes: 320 * 1024 * 1024,
        limitBytes: FREE_TIER.storageBytes,
        targetBytes: FREE_TIER.storageTargetBytes,
        percent: 31.25,
      },
    },
    ...over,
  });
}

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [1.5 * 1024 * 1024 * 1024, '1.50 GB'],
  ])('%d -> %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});

describe('renderCalibrationReport', () => {
  const md = renderCalibrationReport(seeded());

  it('lists the pages whose content hash changed more than once, and flags 3 or more as volatile', () => {
    expect(md).toContain('### Content hash churn');
    expect(md).toContain('| ably-python | 5 | VOLATILE: 3 or more |');
    expect(md).toMatch(/\| beta-node \| 2 \| +\|/);
    expect(md).not.toContain('| beta-node | 2 | VOLATILE');
    expect(md).toMatch(
      /3 or more distinct hashes in the window usually mean a value on the page that rotates/,
    );
  });

  it('says so when no page changed more than once', () => {
    const quiet = renderCalibrationReport(
      seeded({
        compile: { ...seeded().compile, hashChurn: { flagAt: 3, tools: [] } },
      }),
    );
    expect(quiet).toMatch(/Content hash churn\s+None\./);
  });

  it('starts with the window and what it covers', () => {
    expect(md).toMatch(/^# Calibration report/);
    expect(md).toContain('last 7 days');
    expect(md).toContain('2026-10-24');
  });

  it('counts the cycles and gives the reason an invalid one is invalid', () => {
    expect(md).toMatch(/28 cycles/);
    expect(md).toMatch(/26 valid/);
    expect(md).toMatch(/1 invalid/);
    expect(md).toContain('canary-pass-node: expected PASS, got FAIL');
  });

  it('lists the harness versions that produced the window, and says a version bump cannot make an incident by itself', () => {
    expect(md).toContain('### Harness versions in the window');
    expect(md).toContain('| v1 | 1000 | 2026-10-18T06:17:00.000Z | 2026-10-24T18:17:00.000Z |');
    expect(md).toContain('| v2 | 400 |');
    expect(md).toMatch(/never counts failures under different harness versions as consecutive/);
  });

  it('shows the harness error rate per day and overall, and judges the last three days against the 2% bar', () => {
    expect(md).toMatch(/Overall: 14 errors in 1400 runs \(1\.0%\)/);
    expect(md).toContain('| 2026-10-24 | 100 | 4 | 4.0% |');
    // last three days: 6 errors in 500 runs = 1.2%
    expect(md).toMatch(/last 3 days: 1\.2% .*under 2%.*met/is);
  });

  it('says the bar is NOT met when the last three days are at or over 2%', () => {
    const bad = renderCalibrationReport(
      seeded({
        harness: {
          overall: { runs: 300, errors: 12, rate: 0.04 },
          byDay: [
            { day: '2026-10-22', runs: 100, errors: 4, rate: 0.04 },
            { day: '2026-10-23', runs: 100, errors: 4, rate: 0.04 },
            { day: '2026-10-24', runs: 100, errors: 4, rate: 0.04 },
          ],
          versions: [],
        },
      }),
    );
    expect(bad).toMatch(/last 3 days: 4\.0% .*not met/is);
  });

  it('lists every tool with its counts, and marks the flipping and the disabled ones', () => {
    expect(md).toContain(
      '| beta-node | on | L2 | DEGRADED | 12 | 12 | 0 | 1 | 1 | 2 | 3 | 0.80 flipping |',
    );
    expect(md).toContain('| gone-node | off |');
    expect(md).toContain('Flaky tools');
    expect(md.split('Flaky tools')[1]).toContain('beta-node');
  });

  it('lists every UNKNOWN failure with its evidence, with pipes and backticks made safe', () => {
    expect(md).toContain('UNKNOWN classifications');
    expect(md).toContain('weird error \\| with a pipe and a tick');
    expect(md).toContain('(no output line)');
    expect(md.match(/00000000-0000-4000-8000-000000000010/g)?.length).toBeGreaterThan(0);
  });

  it('lists the model classifications with their confidence', () => {
    expect(md).toContain('| beta-node | API_DRIFT | 0.82 |');
    expect(md).toContain('x is not a function');
  });

  it('reports compile deferrals, stale plans and the model tokens per day', () => {
    expect(md).toContain('| beta-node | 2 | llm_budget: 1, llm_unavailable: 1 |');
    expect(md).toMatch(/Stale-plan runs: 3/);
    expect(md).toContain('| 2026-10-23 | 20 | 1 | 60000 |');
    expect(md).toMatch(/Total: 40 calls, 2 failed, 120000 tokens/);
  });

  it('lists the incidents by review state', () => {
    expect(md).toMatch(/1 confirmed, 1 false positive, 1 pending review/);
    expect(md).toContain('| beta-node | API_DRIFT | OPEN | CONFIRMED |');
  });

  it('shows each canary against what it must do, and flags a mismatch', () => {
    expect(md).toContain('| canary-pass-node | PASS | 28 | 27 | 1 |');
    expect(md).toMatch(/canary-pass-node.*MISMATCH|MISMATCH.*canary-pass-node/s);
  });

  it('ranks the slowest tools', () => {
    expect(md).toContain('| beta-node | 95.0 s | 140.0 s |');
  });

  it('shows storage against the free tier, with the 800 MB target', () => {
    expect(md).toContain('120.0 MB of 500.0 MB (24.0%)');
    expect(md).toContain('320.0 MB of 1.00 GB (31.3%)');
    expect(md).toMatch(/800\.0 MB/);
  });

  it('says so when Storage cannot be seen, and when there is no data at all', () => {
    const noObjects = renderCalibrationReport(
      seeded({ storage: { ...seeded().storage, objects: null } }),
    );
    expect(noObjects).toMatch(/Storage objects: not visible/);
    const empty = renderCalibrationReport(
      StatsResponse.parse({
        ...seeded(),
        cycles: { total: 0, valid: 0, invalid: 0, unfinished: 0, recent: [] },
        harness: { overall: { runs: 0, errors: 0, rate: 0 }, byDay: [], versions: [] },
        tools: [],
        unknowns: [],
        llmClassified: [],
        compile: {
          deferrals: [],
          staleRuns: 0,
          llm: { calls: 0, failedCalls: 0, tokensIn: 0, tokensOut: 0 },
          hashChurn: { flagAt: 3, tools: [] },
        },
        incidents: {
          open: 0,
          resolved: 0,
          confirmed: 0,
          falsePositive: 0,
          pendingReview: 0,
          list: [],
        },
        canaries: [],
        slowest: [],
        groq: [],
      }),
    );
    expect(empty).toMatch(/No cycles in this window/);
    expect(empty).toMatch(/None\./);
  });

  it('is deterministic: the same data gives the same text', () => {
    expect(renderCalibrationReport(seeded())).toBe(renderCalibrationReport(seeded()));
  });
});

describe('calibrationCommand', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (x: string) => void out.push(x), stderr: (x: string) => void err.push(x) },
    };
  };
  const api = (data: unknown, seen: string[] = []) => ({
    wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
    get: (async (path: string) => {
      seen.push(path);
      if (data instanceof Error) throw data;
      return data;
    }) as never,
  });

  it('asks for the window and prints the report', async () => {
    const seen: string[] = [];
    const x = io();
    expect(
      await calibrationCommand(['--days', '3'], recordingLogger(), x.io, api(seeded(), seen)),
    ).toBe(0);
    expect(seen).toEqual(['/admin/stats?days=3']);
    expect(x.out.join('')).toContain('# Calibration report');
  });

  it('defaults to 7 days', async () => {
    const seen: string[] = [];
    await calibrationCommand([], recordingLogger(), io().io, api(seeded(), seen));
    expect(seen).toEqual(['/admin/stats?days=7']);
  });

  it.each(['0', '91', 'x', '2.5'])(
    'refuses --days %s before asking the API anything',
    async (days) => {
      const seen: string[] = [];
      const x = io();
      expect(
        await calibrationCommand(['--days', days], recordingLogger(), x.io, api(seeded(), seen)),
      ).toBe(2);
      expect(seen).toEqual([]);
    },
  );

  it('exits 1 with the reason when the API fails, and refuses an answer that is not stats', async () => {
    const x = io();
    expect(await calibrationCommand([], recordingLogger(), x.io, api(new Error('boom')))).toBe(1);
    expect(x.err.join('')).toContain('boom');
    const y = io();
    expect(await calibrationCommand([], recordingLogger(), y.io, api({ hello: 'world' }))).toBe(1);
    expect(y.out).toEqual([]);
  });
});
