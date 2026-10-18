import { parseArgs } from 'node:util';
import {
  L3_SHADOW_CLEAN_CYCLES,
  L3ShadowReportResponse,
  SHADOW_L3_VERDICTS,
  type Logger,
} from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, type CliIo } from './commands.js';

// `qsr l3-shadow-report --days N`: what the L3 step of each shadow-L3 target said, for the person who decides whether a target may start
// to count at L3. A rendering of GET /admin/l3-shadow. It changes nothing; neither does the step it reports on. Promoting a target is a
// separate decision (remove `l3:` from its target file), never something this command does.

const cell = (text: string): string => text.replaceAll('|', '/').replaceAll('\n', ' ').trim();
const row = (cells: readonly (string | number)[]): string =>
  `| ${cells.map((c) => cell(String(c))).join(' | ')} |`;

export function renderL3ShadowReport(r: L3ShadowReportResponse): string {
  const out: string[] = [];
  const add = (...lines: string[]): void => void out.push(...lines);
  add(
    '# L3 shadow report: targets whose L3 step is recorded but not counted',
    '',
    `Window: the last ${r.days} days, up to ${r.generatedAt.slice(0, 10)} (generated ${r.generatedAt}).`,
    '',
    "In shadow mode the L3 step of a target runs once per cycle, after everything else, and its answer is only recorded. It is never acted on: it changes no level, status, incident, badge or public page, and the target is shown at level 2 meanwhile. A result without evidence is AMBIGUOUS, not a failure: it may be a break, the network, or a snippet that swallows the vendor's answer. Promotion needs a person: the verdict below only says whether the evidence is there.",
    '',
    `A target is promotion-ready when it has at least ${L3_SHADOW_CLEAN_CYCLES} cycles with a record in the window, every one with evidence that a vendor was reached, the same evidence every time, and no cycle without a record.`,
    '',
    '## Targets',
    '',
  );
  if (r.tools.length === 0) {
    add('No shadow-L3 targets have run in this window.', '');
    return `${out.join('\n')}\n`;
  }
  add(
    row([
      'Target',
      'Cycles',
      'With a record',
      'Verdicts',
      'Evidence (pattern: cycles)',
      'Ambiguous',
      'Last record',
      'Promotion',
    ]),
    row(['---', '---', '---', '---', '---', '---', '---', '---']),
  );
  for (const t of r.tools) {
    // always in the same order: the clean answer first, then the ambiguous ones as the schema lists them
    const order = (v: string): number => {
      const at = (SHADOW_L3_VERDICTS as readonly string[]).indexOf(v);
      return at < 0 ? SHADOW_L3_VERDICTS.length : at;
    };
    const verdicts = Object.entries(t.verdicts)
      .sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : 1))
      .map(([v, n]) => `${v} ${n}`)
      .join(', ');
    add(
      row([
        t.slug,
        t.cycles,
        t.withRecord,
        verdicts === '' ? 'none' : verdicts,
        t.patterns.map((p) => `${p.pattern} (${p.cycles})`).join(', ') || 'none',
        t.ambiguous,
        t.lastAt === null ? 'never' : t.lastAt.slice(0, 16).replace('T', ' '),
        t.promotion.ready ? `ready (${t.promotion.cleanCycles} clean cycles)` : 'not ready',
      ]),
    );
  }
  add('', '## Observed text (exact, truncated), per target', '');
  for (const t of r.tools) {
    add(`### ${t.slug}`, '');
    if (t.reason !== null) add(`Why it is in shadow: ${cell(t.reason)}`, '');
    if (t.observed.length === 0) add('Nothing recorded yet.', '');
    else for (const o of t.observed) add(`- ${o.cycles} x \`${cell(o.text)}\``);
    add('');
  }
  const notReady = r.tools.filter((t) => !t.promotion.ready);
  add('## Not ready', '');
  if (notReady.length === 0)
    add('Every shadow target in the window is ready. Nothing is promoted by this report.', '');
  else {
    for (const t of notReady) add(`- ${t.slug}: ${t.promotion.blockers.join('; ') || 'not ready'}`);
    add('');
  }
  return `${out.join('\n')}\n`;
}

export async function l3ShadowReportCommand(
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
      renderL3ShadowReport(
        L3ShadowReportResponse.parse(await client.get(`/admin/l3-shadow?days=${days}`)),
      ),
    );
    return 0;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'l3 shadow report failed');
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
