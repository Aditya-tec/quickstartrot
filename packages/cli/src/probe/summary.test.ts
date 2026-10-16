import { describe, expect, it } from 'vitest';
import { renderSummary, type SummaryRow } from './summary.js';

// Spec section 12: "Every Actions run's step summary shows the outcome table, so debugging starts on GitHub."

const row = (over: Partial<SummaryRow> = {}): SummaryRow => ({
  slug: 'acme-node',
  isCanary: false,
  targetLevel: 3,
  reachedLevel: 3,
  outcome: 'PASS',
  failureClass: null,
  durationMs: 12_340,
  stale: false,
  runId: null,
  note: null,
  ...over,
});
const base = { cycleId: 'c-1', valid: true, canaryProblems: [], webBaseUrl: null };

describe('renderSummary', () => {
  it('is a Markdown table with one line per tool', () => {
    const md = renderSummary({
      ...base,
      rows: [
        row(),
        row({ slug: 'b-node', outcome: 'FAIL', failureClass: 'API_DRIFT', reachedLevel: 2 }),
      ],
    });
    expect(md).toContain('| Tool | Level | Outcome | Class | Duration | Plan | Run |');
    expect(md).toContain('| acme-node | L3 / L3 | PASS | | 12.3 s | | |');
    expect(md).toContain('| b-node | L2 / L3 | FAIL | API_DRIFT | 12.3 s | | |');
  });

  it('marks a run on a stale plan, in the row and in the legend', () => {
    const md = renderSummary({ ...base, rows: [row({ stale: true })] });
    expect(md).toMatch(/\| acme-node \|.*\| stale plan \|/);
    expect(md).toMatch(/stale plan.*model was not asked/i);
  });

  it('links a run to the site when the web base URL is known, else shows a short id', () => {
    const id = '0f9d2c1e-aaaa-bbbb-cccc-0123456789ab';
    const withWeb = renderSummary({
      ...base,
      webBaseUrl: 'https://qsr.vercel.app/',
      rows: [row({ runId: id })],
    });
    expect(withWeb).toContain(`[run](https://qsr.vercel.app/runs/${id})`);
    const without = renderSummary({ ...base, rows: [row({ runId: id })] });
    expect(without).toContain('0f9d2c1e');
    expect(without).not.toContain('](');
  });

  it('shows an unreached level and a missing duration as a dash, and a note', () => {
    const md = renderSummary({
      ...base,
      rows: [
        row({
          reachedLevel: null,
          durationMs: null,
          outcome: 'SKIPPED',
          note: 'deferred: llm_budget',
        }),
      ],
    });
    expect(md).toContain('| acme-node | - / L3 | SKIPPED | | - | deferred: llm_budget | |');
  });

  it('formats long durations as minutes', () => {
    expect(renderSummary({ ...base, rows: [row({ durationMs: 125_000 })] })).toContain('2 min 5 s');
  });

  it('lists canaries last, after the real tools, and counts outcomes in the headline', () => {
    const md = renderSummary({
      ...base,
      rows: [
        row({ slug: 'canary-pass-node', isCanary: true }),
        row({ slug: 'zeta-node' }),
        row({ slug: 'alpha-node', outcome: 'FAIL', failureClass: 'API_DRIFT' }),
      ],
    });
    const lines = md.split('\n');
    const at = (s: string) => lines.findIndex((l) => l.includes(`| ${s} |`));
    expect(at('alpha-node')).toBeLessThan(at('zeta-node'));
    expect(at('zeta-node')).toBeLessThan(at('canary-pass-node'));
    expect(md).toMatch(/1 passed, 1 failed/);
  });

  it('an invalid cycle says so at the top, with the canary problems', () => {
    const md = renderSummary({
      ...base,
      valid: false,
      canaryProblems: ['canary-pass-node: expected PASS but got FAIL (API_DRIFT)'],
      rows: [row()],
    });
    expect(md.split('\n')[0]).toMatch(/invalid/i);
    expect(md).toContain('canary-pass-node: expected PASS but got FAIL (API_DRIFT)');
    expect(md).toMatch(/no status was changed/i);
  });

  it('a valid cycle says so', () => {
    expect(renderSummary({ ...base, rows: [row()] }).split('\n')[0]).toMatch(/valid/i);
  });

  it('cell text cannot break the table: pipes and newlines are escaped', () => {
    const md = renderSummary({ ...base, rows: [row({ slug: 'a|b', note: 'line1\nline2 | x' })] });
    expect(md).toContain('a\\|b');
    expect(md).not.toMatch(/line1\nline2/);
  });

  it('an empty cycle still renders', () => {
    expect(renderSummary({ ...base, rows: [] })).toContain('No tools');
  });
});
