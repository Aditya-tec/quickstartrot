import { parseArgs } from 'node:util';
import { ShadowReportResponse, type Logger } from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, type CliIo } from './commands.js';

// `qsr shadow-report --days N` (P9d): what the export check said in shadow mode, per target, for the person who decides in P9b whether
// to promote it. A rendering of GET /admin/shadow. It never changes anything; neither does the check it reports on.

const cell = (text: string): string => text.replaceAll('|', '/').replaceAll('\n', ' ').trim();
const row = (cells: readonly (string | number)[]): string =>
  `| ${cells.map((c) => cell(String(c))).join(' | ')} |`;

export function renderShadowReport(r: ShadowReportResponse): string {
  const out: string[] = [];
  const add = (...lines: string[]): void => void out.push(...lines);
  const t = r.totals;
  add(
    '# Shadow report: the export check (qsr-check-exports)',
    '',
    `Window: the last ${r.days} days, up to ${r.generatedAt.slice(0, 10)} (generated ${r.generatedAt}).`,
    '',
    "In shadow mode the export check runs after the normal L2 checks of every production run and its answer is only recorded. It is never acted on: it changes no status, level, classification, incident, badge or public page. A failure here is a CANDIDATE for a false positive, not a verdict; promoting the check into status is a person's decision after reading this.",
    '',
    '## Totals',
    '',
  );
  if (t.withShadow === 0) {
    add(
      'No shadow results yet in this window (they exist from harness version 2 on, for runs that reach the L2 checks).',
      '',
    );
  } else {
    add(
      `${t.cycles} cycles, ${t.runs} runs, ${t.withShadow} with a shadow record: ${t.pass} pass, ${t.fail} fail, ${t.skipped} skipped.`,
      '',
    );
  }
  add('## Per target', '');
  if (r.tools.length === 0) add('None.', '');
  else {
    add(
      row([
        'Target',
        'Cycles',
        'Checked',
        'Pass',
        'Fail',
        'Skipped',
        'Missing names (cycles)',
        'Notes',
      ]),
      row(['---', '---', '---', '---', '---', '---', '---', '---']),
    );
    for (const x of r.tools) {
      const notes = [
        ...(x.optOut ? [`opted out: ${x.optOut}`] : []),
        ...x.notes.filter((n) => !n.startsWith('skipExportCheck:')),
      ];
      add(
        row([
          x.slug,
          x.cycles,
          x.withShadow,
          x.pass,
          x.fail,
          x.skipped,
          x.missing.map((m) => `${m.name} (${m.cycles})`).join(', '),
          notes.join('; '),
        ]),
      );
    }
    add('');
  }
  add('## False-positive candidates', '');
  if (r.falsePositiveCandidates.length === 0) add('None.', '');
  else {
    add(
      'Every target whose check failed at least once. A failure in every cycle with the same names is a fact about the page or the plan; an intermittent one is weather.',
      '',
      row(['Target', 'Failed', 'Stable', 'Missing', 'Why']),
      row(['---', '---', '---', '---', '---']),
    );
    const ordered = [...r.falsePositiveCandidates].sort(
      (a, b) =>
        Number(b.stable) - Number(a.stable) ||
        b.failCycles - a.failCycles ||
        (a.slug < b.slug ? -1 : 1),
    );
    for (const c of ordered)
      add(
        row([
          c.slug,
          `${c.failCycles} of ${c.checkedCycles}`,
          c.stable ? 'yes' : 'no',
          c.missing.join(', '),
          c.reason,
        ]),
      );
    add('');
  }
  return `${out.join('\n')}\n`;
}

export async function shadowReportCommand(
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
    io.stdout(
      renderShadowReport(
        ShadowReportResponse.parse(await client.get(`/admin/shadow?days=${days}`)),
      ),
    );
    return 0;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'shadow report failed');
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
