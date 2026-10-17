import { parseArgs } from 'node:util';
import { LaunchExport, type Logger } from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, USAGE, type CliIo } from './commands.js';

// `qsr export --launch` (P9a): the numbers a launch post needs, as Markdown and JSON.
//
// It refuses to print anything that is not reviewed and confirmed: the API only selects confirmed incidents, and
// this command parses the answer with a schema that admits nothing else (review is the literal "CONFIRMED") and
// also checks that the count matches the list. A pending or false-positive incident cannot reach a post by mistake,
// even if a server, a proxy or a saved file said otherwise.

export class ExportRefusedError extends Error {
  override readonly name = 'ExportRefusedError';
}

export function parseLaunchExport(input: unknown): LaunchExport {
  const parsed = LaunchExport.safeParse(input);
  if (!parsed.success)
    throw new ExportRefusedError(
      `Refusing to export: the data is not a valid launch export, or it contains something that is not a confirmed incident (${parsed.error.issues[0]?.path.join('.') ?? 'unknown'}).`,
    );
  if (parsed.data.incidents.confirmed !== parsed.data.incidents.list.length)
    throw new ExportRefusedError(
      'Refusing to export: the number of confirmed incidents does not match the incidents listed.',
    );
  return parsed.data;
}

/** One line of reviewed text, safe inside a list item. */
const oneLine = (text: string | null): string | null =>
  text === null ? null : text.replaceAll(/\s*\n\s*/g, ' ').trim();

const hours = (value: number): string => `${value.toFixed(1)} hours`;

export function renderLaunchMarkdown(data: LaunchExport, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  const t = data.tools;
  const lines: string[] = [
    '# Launch numbers',
    '',
    `Generated ${data.generatedAt}. Everything here comes from runs in valid cycles and from incidents a person reviewed and confirmed.`,
    '',
    '## Coverage',
    '',
    `- ${t.tracked} quickstarts tracked: ${t.testedAtL3} tested at L3 (the snippet reached the vendor's API), ${t.testedAtL2} tested at L2 (installed and built, not run against the vendor), ${t.testedAtL1} at L1 or below, ${t.notYetRun} not yet run. A pass at L2 proves less than one at L3; do not add them together without saying so.`,
    `- ${data.cycles.valid} valid cycles${data.cycles.firstAt ? ` between ${data.cycles.firstAt.slice(0, 10)} and ${(data.cycles.lastAt ?? '').slice(0, 10)}` : ''}, ${data.cycles.invalid} invalid (ignored by every status).`,
    `- ${data.runs.total} runs of real quickstarts in those cycles.`,
    '',
    '### Runs per quickstart',
    '',
    '| Quickstart | Runs | Passed | Failed |',
    '| --- | --- | --- | --- |',
    ...data.runs.perTool.map((r) => `| ${r.slug} | ${r.runs} | ${r.passes} | ${r.fails} |`),
    '',
    '## Confirmed incidents',
    '',
  ];

  const i = data.incidents;
  if (i.confirmed === 0) {
    lines.push('No incident has been confirmed yet, so there is nothing to report here.', '');
  } else {
    lines.push(
      `${i.confirmed} confirmed incident${i.confirmed === 1 ? '' : 's'}.`,
      '',
      '| Failure class | Incidents |',
      '| --- | --- |',
      ...Object.entries(i.byFailureClass)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `| ${k} | ${v} |`),
      '',
      'What changed between the last passing run and the first failing one:',
      '',
      `- Docs changed and a dependency changed: ${i.coincidence.both}`,
      `- Only the docs changed: ${i.coincidence.docsOnly}`,
      `- Only a dependency changed: ${i.coincidence.dependencyOnly}`,
      `- Neither changed: ${i.coincidence.neither}`,
      `- Not determined: ${i.coincidence.unknown}`,
      '',
    );
    if (i.medianHoursToDetect !== null)
      lines.push(
        `- Median time to detect: ${hours(i.medianHoursToDetect)} (from the first failing run to the incident opening).`,
      );
    if (i.medianHoursToConfirm !== null)
      lines.push(
        `- Median time from detection to a person confirming it: ${hours(i.medianHoursToConfirm)}.`,
      );
    lines.push('', '### The incidents', '');
    for (const inc of i.list) {
      lines.push(
        `- **${inc.name}** (${inc.failureClass}, ${inc.state.toLowerCase()}, opened ${inc.openedAt.slice(0, 10)}): ${oneLine(inc.summary) ?? 'no summary written'}`,
      );
      if (inc.suggestedFix) lines.push(`  - Suggested fix: ${oneLine(inc.suggestedFix)}`);
      lines.push(
        `  - Evidence: ${site}${inc.toolPath}${inc.firstFailingRunPath ? `, first failing run ${site}${inc.firstFailingRunPath}` : ''}`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** `qsr export --launch [--site <url>] [--json | --md]`. Exit codes: 0 printed, 1 refused or failed, 2 usage. */
export async function exportCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  api?: Pick<ApiClient, 'wakeApi' | 'get'>,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      launch: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      md: { type: 'boolean', default: false },
      site: { type: 'string' },
    },
  });
  if (!values.launch) {
    io.stderr(`give --launch (the only export there is so far)\n\n${USAGE}`);
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
    const data = parseLaunchExport(await client.get('/admin/export/launch'));
    const site =
      values.site ?? process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://quickstartrot.vercel.app';
    const json = JSON.stringify(data, null, 2);
    if (values.json) io.stdout(`${json}\n`);
    else if (values.md) io.stdout(renderLaunchMarkdown(data, site));
    else io.stdout(`${renderLaunchMarkdown(data, site)}\n## JSON\n\n\`\`\`json\n${json}\n\`\`\`\n`);
    return 0;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'export failed');
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
