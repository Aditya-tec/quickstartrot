import { parseArgs } from 'node:util';
import { StatsResponse, type Logger } from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, type CliIo } from './commands.js';

// `qsr calibration-report` (P9a): turns GET /admin/stats into the Markdown a person reads at the end of the 7-day
// calibration run (P9b). A pure function of the stats, so the same data always gives the same text and it can be
// tested with seeded data.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const seconds = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);

/** One table cell: no pipes, backticks or line breaks, and not unbounded. */
function cell(text: string | null, fallback = '-'): string {
  if (text === null || text === '') return fallback;
  return text
    .replaceAll('|', '\\|')
    .replaceAll('`', '')
    .replaceAll(/\s*\n\s*/g, ' ')
    .slice(0, 200);
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

const NONE = 'None.';

/** The spec's bar for P9 (section 15): a harness error rate under 2% over the last 3 days. */
export const HARNESS_BAR = 0.02;
export const HARNESS_BAR_DAYS = 3;

export function renderCalibrationReport(stats: StatsResponse): string {
  const out: string[] = [];
  const add = (...lines: string[]): void => void out.push(...lines);

  add(
    '# Calibration report',
    '',
    `Window: the last ${stats.days} days, up to ${stats.generatedAt.slice(0, 10)} (generated ${stats.generatedAt}).`,
    '',
  );

  // ---- cycles
  add('## Cycles', '');
  if (stats.cycles.total === 0) {
    add('No cycles in this window.', '');
  } else {
    add(
      `${stats.cycles.total} cycles in the window: ${stats.cycles.valid} valid, ${stats.cycles.invalid} invalid, ${stats.cycles.unfinished} not finished.`,
      '',
    );
    const invalid = stats.cycles.recent.filter((c) => c.valid === false);
    add('Invalid cycles and why (an invalid cycle changes no status):', '');
    add(
      ...(invalid.length === 0
        ? [NONE]
        : invalid.map(
            (c) =>
              `- ${c.startedAt.slice(0, 16).replace('T', ' ')} UTC (${c.id}): ${c.problems.length > 0 ? c.problems.map((p) => cell(p)).join('; ') : 'no reason recorded'}`,
          )),
      '',
    );
    add(
      ...table(
        ['Started (UTC)', 'Trigger', 'Valid', 'Minutes', 'Tools', 'Harness errors'],
        stats.cycles.recent
          .slice(0, 10)
          .map((c) => [
            c.startedAt.slice(0, 16).replace('T', ' '),
            c.trigger,
            c.valid === null ? 'running' : c.valid ? 'yes' : 'NO',
            c.durationSeconds === null ? '-' : (c.durationSeconds / 60).toFixed(1),
            String(c.tools),
            String(c.harnessErrors),
          ]),
      ),
      '',
    );
  }

  // ---- harness error rate
  add('## Harness error rate', '');
  const o = stats.harness.overall;
  add(`Overall: ${o.errors} errors in ${o.runs} runs (${pct(o.rate)}).`, '');
  if (stats.harness.byDay.length > 0) {
    add(
      ...table(
        ['Day', 'Runs', 'Errors', 'Rate'],
        stats.harness.byDay.map((d) => [d.day, String(d.runs), String(d.errors), pct(d.rate)]),
      ),
      '',
    );
    const lastDays = stats.harness.byDay.slice(-HARNESS_BAR_DAYS);
    const runs = lastDays.reduce((s, d) => s + d.runs, 0);
    const errors = lastDays.reduce((s, d) => s + d.errors, 0);
    const rate = runs === 0 ? 0 : errors / runs;
    add(
      `Spec bar (harness error rate under ${HARNESS_BAR * 100}% over the last ${HARNESS_BAR_DAYS} days): ` +
        `last ${HARNESS_BAR_DAYS} days: ${pct(rate)} (${errors} of ${runs} runs), ` +
        (rate < HARNESS_BAR
          ? `under ${HARNESS_BAR * 100}%, bar met.`
          : `not under ${HARNESS_BAR * 100}%, bar not met.`),
      '',
    );
  } else {
    add('No runs by day.', '');
  }

  // ---- tools
  add('## Tools', '');
  add(
    ...(stats.tools.length === 0
      ? [NONE]
      : table(
          [
            'Tool',
            'State',
            'Level',
            'Status',
            'Pass',
            'Fail',
            'Skipped',
            'Harness',
            'Not run',
            'Deferred',
            'Stale',
            'Flake',
          ],
          stats.tools.map((t) => [
            t.slug,
            t.enabled ? 'on' : 'off',
            `L${t.level}`,
            t.status,
            String(t.pass),
            String(t.fail),
            String(t.skipped),
            String(t.harnessErrors),
            String(t.notRun),
            String(t.deferred),
            String(t.staleRuns),
            `${t.flakeScore.toFixed(2)}${t.flipping ? ' flipping' : ''}`,
          ]),
        )),
    '',
  );
  const flaky = stats.tools.filter((t) => t.flipping);
  add('### Flaky tools (alternating pass and fail)', '');
  add(
    ...(flaky.length === 0
      ? [NONE]
      : flaky.map(
          (t) =>
            `- ${t.slug}: flake score ${t.flakeScore.toFixed(2)} (${t.pass} pass, ${t.fail} fail)`,
        )),
    '',
  );

  // ---- classification
  add(
    '## UNKNOWN classifications',
    '',
    'Every failure no rule matched, with the last line it printed. Each needs a rule or an explanation.',
    '',
  );
  add(
    ...(stats.unknowns.length === 0
      ? [NONE]
      : table(
          ['Run', 'Tool', 'Step', 'Evidence'],
          stats.unknowns.map((u) => [
            u.runId,
            u.slug,
            u.failedStepId ?? '-',
            cell(u.evidenceLine, '(no output line)'),
          ]),
        )),
    '',
  );
  add(
    '## Runs classified by the model',
    '',
    'Accepted only with confidence of 0.7 or more and an evidence line found in the log. Each wants a rule.',
    '',
  );
  add(
    ...(stats.llmClassified.length === 0
      ? [NONE]
      : table(
          ['Tool', 'Class', 'Confidence', 'Evidence'],
          stats.llmClassified.map((r) => [
            r.slug ?? '-',
            r.failureClass ?? '-',
            r.confidence === null ? '-' : r.confidence.toFixed(2),
            cell(r.evidenceLine),
          ]),
        )),
    '',
  );

  // ---- compile
  add('## Compile', '');
  add('### Deferrals (the model was not asked, or could not answer)', '');
  add(
    ...(stats.compile.deferrals.length === 0
      ? [NONE]
      : table(
          ['Tool', 'Count', 'Reasons'],
          stats.compile.deferrals.map((d) => [
            d.slug,
            String(d.count),
            Object.entries(d.reasons)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, v]) => `${k}: ${v}`)
              .join(', '),
          ]),
        )),
    '',
  );
  add(`Stale-plan runs: ${stats.compile.staleRuns}`, '');
  add('### Content hash churn', '');
  add(
    ...(stats.compile.hashChurn.tools.length === 0
      ? [NONE]
      : [
          ...table(
            ['Tool', 'Distinct hashes', 'Flag'],
            stats.compile.hashChurn.tools.map((c) => [
              c.slug,
              String(c.distinctHashes),
              c.flagged ? `VOLATILE: ${stats.compile.hashChurn.flagAt} or more` : '',
            ]),
          ),
          '',
          `${stats.compile.hashChurn.flagAt} or more distinct hashes in the window usually mean a value on the page that rotates by itself (a generated demo key, a date, a nonce). Each one costs a compile; see extract.hashIgnore in docs/TARGET-SELECTION.md.`,
        ]),
    '',
  );
  add('### Model tokens per day', '');
  add(
    ...(stats.groq.length === 0
      ? [NONE]
      : table(
          ['Day', 'Calls', 'Failed', 'Tokens'],
          stats.groq.map((g) => [g.day, String(g.calls), String(g.failedCalls), String(g.tokens)]),
        )),
    '',
  );
  const l = stats.compile.llm;
  add(`Total: ${l.calls} calls, ${l.failedCalls} failed, ${l.tokensIn + l.tokensOut} tokens.`, '');

  // ---- incidents
  add('## Incidents', '');
  const i = stats.incidents;
  add(
    `${i.confirmed} confirmed, ${i.falsePositive} false positive, ${i.pendingReview} pending review (${i.open} open, ${i.resolved} resolved).`,
    '',
  );
  add(
    ...(i.list.length === 0
      ? [NONE]
      : table(
          ['Tool', 'Class', 'State', 'Review', 'Opened', 'Docs changed'],
          i.list.map((x) => [
            x.slug,
            x.failureClass,
            x.state,
            x.review,
            x.openedAt.slice(0, 16).replace('T', ' '),
            x.docsChanged === null ? '-' : x.docsChanged ? 'yes' : 'no',
          ]),
        )),
    '',
  );

  // ---- canaries
  add('## Canaries', '');
  add(
    ...(stats.canaries.length === 0
      ? [NONE]
      : table(
          ['Canary', 'Expected', 'Runs', 'Matched', 'Mismatched'],
          stats.canaries.map((c) => [
            c.slug,
            c.expected,
            String(c.runs),
            String(c.matched),
            String(c.mismatched),
          ]),
        )),
    '',
  );
  for (const c of stats.canaries.filter((x) => x.mismatched > 0))
    add(
      `MISMATCH: ${c.slug} gave the wrong answer ${c.mismatched} time(s); each invalidated its cycle.`,
      '',
    );

  // ---- slowest
  add('## Slowest tools', '');
  add(
    ...(stats.slowest.length === 0
      ? [NONE]
      : table(
          ['Tool', 'Median', 'Slowest'],
          stats.slowest.map((s) => [s.slug, seconds(s.medianDurationMs), seconds(s.maxDurationMs)]),
        )),
    '',
  );

  // ---- storage
  add('## Storage used', '');
  const db = stats.storage.database;
  add(
    `Database: ${formatBytes(db.bytes)} of ${formatBytes(db.limitBytes)} (${db.percent.toFixed(1)}%).`,
    '',
  );
  const ob = stats.storage.objects;
  add(
    ob === null
      ? 'Storage objects: not visible from the database; check the Supabase dashboard.'
      : `Storage objects: ${formatBytes(ob.totalBytes)} of ${formatBytes(ob.limitBytes)} (${ob.percent.toFixed(1)}%): ${formatBytes(ob.publicBytes)} public (${ob.publicCount} files), ${formatBytes(ob.privateBytes)} private (${ob.privateCount} files). Cleanup target: under ${formatBytes(ob.targetBytes)}.`,
    '',
  );
  add(
    ...table(
      ['Largest tables', 'Rows (estimate)', 'Size'],
      stats.storage.tables.slice(0, 6).map((t) => [t.name, String(t.rows), formatBytes(t.bytes)]),
    ),
    '',
  );

  return `${out.join('\n')}\n`;
}

/** `qsr calibration-report [--days 7]`: fetch GET /admin/stats and print the Markdown. Exit codes: 0, 1 failed, 2 usage. */
export async function calibrationCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  api?: Pick<ApiClient, 'wakeApi' | 'get'>,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { days: { type: 'string', default: '7' } },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    io.stderr('--days must be a whole number from 1 to 90\n');
    return 2;
  }
  let client = api;
  if (!client) {
    try {
      client = adminClientFromEnv();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      io.stderr(`${err.message}\n`);
      return 2;
    }
  }
  try {
    await client.wakeApi();
    const stats = StatsResponse.parse(await client.get(`/admin/stats?days=${days}`));
    io.stdout(renderCalibrationReport(stats));
    return 0;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'calibration report failed',
    );
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
