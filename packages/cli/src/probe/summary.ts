// The Markdown outcome table `qsr report` writes to $GITHUB_STEP_SUMMARY (spec section 12), so debugging
// starts on GitHub. Pure: rows in, text out.

export interface SummaryRow {
  slug: string;
  isCanary: boolean;
  targetLevel: number;
  /** null when nothing ran (a pre-flight failure or a skip). */
  reachedLevel: number | null;
  /** PASS, FAIL, HARNESS_ERROR or SKIPPED. */
  outcome: string;
  failureClass: string | null;
  durationMs: number | null;
  /** The run used the tool's last accepted plan because the model was not asked. */
  stale: boolean;
  runId: string | null;
  note: string | null;
}

export interface SummaryInput {
  cycleId: string;
  valid: boolean;
  canaryProblems: readonly string[];
  /** The site, when it exists: run ids become links. */
  webBaseUrl: string | null;
  rows: readonly SummaryRow[];
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, ' ');
const line = (cells: readonly string[]): string =>
  `|${cells.map((c) => (c === '' ? ' |' : ` ${cell(c)} |`)).join('')}`;

export function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function renderSummary(input: SummaryInput): string {
  const real = input.rows.filter((r) => !r.isCanary);
  const count = (outcome: string): number => real.filter((r) => r.outcome === outcome).length;
  const parts = [`${count('PASS')} passed`, `${count('FAIL')} failed`];
  if (count('HARNESS_ERROR') > 0) parts.push(`${count('HARNESS_ERROR')} harness error`);
  if (count('SKIPPED') > 0) parts.push(`${count('SKIPPED')} skipped`);

  const out: string[] = [
    `### Probe cycle ${input.cycleId}: ${input.valid ? 'valid' : 'INVALID'}`,
    '',
  ];
  if (!input.valid) {
    out.push(
      'A canary did not behave as expected, so the cycle is invalid: no status was changed and no incident was opened.',
      '',
      ...input.canaryProblems.map((p) => `- ${p}`),
      '',
    );
  }

  if (input.rows.length === 0) {
    out.push('No tools in this cycle.', '');
    return out.join('\n');
  }
  out.push(
    `${parts.join(', ')} (${real.length} tools, ${input.rows.length - real.length} canaries)`,
    '',
  );

  const sorted = [...input.rows].sort(
    (a, b) =>
      Number(a.isCanary) - Number(b.isCanary) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  out.push(
    line(['Tool', 'Level', 'Outcome', 'Class', 'Duration', 'Plan', 'Run']),
    line(['---', '---', '---', '---', '---', '---', '---']),
  );
  for (const r of sorted) {
    const plan = [r.stale ? 'stale plan' : '', r.note ?? ''].filter((s) => s !== '').join('; ');
    const run = !r.runId
      ? ''
      : input.webBaseUrl
        ? `[run](${input.webBaseUrl.replace(/\/+$/, '')}/runs/${r.runId})`
        : r.runId.slice(0, 8);
    out.push(
      line([
        r.slug,
        `${r.reachedLevel === null ? '-' : `L${r.reachedLevel}`} / L${r.targetLevel}`,
        r.outcome,
        r.failureClass ?? '',
        formatDuration(r.durationMs),
        plan,
        run,
      ]),
    );
  }
  if (input.rows.some((r) => r.stale))
    out.push(
      '',
      "_stale plan: the model was not asked (token budget), so the tool's last accepted plan was run. A failure on a stale plan is not counted against the tool._",
    );
  out.push('');
  return out.join('\n');
}
