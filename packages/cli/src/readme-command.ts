import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  badgeParagraph,
  levelStatements,
  PIPELINE,
  PublicStatusSummary,
  type DetectionSummary,
  type Logger,
} from '@qsr/core';
import { processIo, type CliIo } from './commands.js';
import { buildSummaryFromRepo } from './detection-summary-command.js';

// `qsr readme [--check] [--site <url>] [--root <dir>]`: keeps two blocks of README.md in step with the data, so the README never says
// something the site and the documents do not. The first block is the table of live counts, fetched from the site's public
// GET /api/status (the same counts as the home headline). The second is the approved wording about what each level proves, from
// docs/detection-power.json. Everything else in the README is prose that a test keeps free of figures. `--check` changes nothing
// and exits 1 when a block differs (the launch check uses it); the "As of" time is the one thing it ignores.

export const DEFAULT_SITE = 'https://quickstartrot.vercel.app';

const marker = (name: string, edge: 'start' | 'end'): string => `<!-- qsr:${name}:${edge} -->`;

/** What is between a block's markers, trimmed. */
export function extractBlock(doc: string, name: string): string {
  const [start, end] = [marker(name, 'start'), marker(name, 'end')];
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`README.md has no <!-- qsr:${name}:start --> ... end block`);
  if (doc.indexOf(start, a + 1) >= 0)
    throw new Error(`README.md has the qsr:${name} block more than once`);
  return doc.slice(a + start.length, b).trim();
}

/** The document with the block's content replaced; the markers and everything outside them are kept as they were. */
export function replaceBlock(doc: string, name: string, body: string): string {
  extractBlock(doc, name); // throws when the markers are missing or repeated
  const [start, end] = [marker(name, 'start'), marker(name, 'end')];
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  return `${doc.slice(0, a + start.length)}\n${body.trim()}\n${doc.slice(b)}`;
}

const TIER_LABEL: Record<'L3' | 'L2' | 'L1', string> = {
  L3: "L3 (reached the vendor's API)",
  L2: 'L2 (installs, builds, imports resolve)',
  L1: 'L1 (installs only)',
};

const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The table of live counts. Counts only: an unreviewed failure is "being verified" here, as on the site. */
export function renderStatusBlock(s: PublicStatusSummary, site: string = DEFAULT_SITE): string {
  const h = s.headline;
  const out: string[] = [];
  if (h.tested === 0) {
    out.push('No quickstart has been tested yet.');
  } else {
    out.push(
      `**${h.passing} of ${h.tested}** quickstarts work on a fresh machine right now. Every quickstart is run on a fresh machine every ${PIPELINE.cycleHours} hours, and a failure is shown as "being verified" until a person has confirmed it.`,
      '',
      '| Tested up to | Passing | Being verified | Confirmed failing | Tested |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...s.tiers.map(
        (t) =>
          `| ${TIER_LABEL[t.tier]} | ${t.passing} | ${t.verifying} | ${t.failing} | ${t.total} |`,
      ),
    );
  }
  const aside: string[] = [];
  if (h.needsPerson > 0)
    aside.push(
      `${h.needsPerson} more ${h.needsPerson === 1 ? 'needs' : 'need'} a person (a sign-up or an interactive step)`,
    );
  if (h.notTested > 0)
    aside.push(`${h.notTested} ${h.notTested === 1 ? 'has' : 'have'} not been tested yet`);
  if (aside.length > 0) out.push('', `${aside.join(' and ')}; they are not counted above.`);
  if (s.asOf !== null)
    out.push('', `As of ${utc(s.asOf)}, from the [site's status counts](${site}/api/status).`);
  return out.join('\n');
}

/** What each level proves: the approved wording, with the figures of the measurement. */
export function renderDetectionBlock(d: DetectionSummary): string {
  const statements = levelStatements(d);
  const trial =
    d.shadowTargets.length > 0
      ? `${d.shadowTargets.length} more ${d.shadowTargets.length === 1 ? 'quickstart runs its' : 'quickstarts run their'} Level 3 step as a trial, labelled verifying: the result is recorded and not counted.`
      : null;
  return [
    badgeParagraph(d),
    '',
    `- **L1:** ${statements.L1}`,
    `- **L2:** ${statements.L2}`,
    `- **L3:** ${statements.L3}`,
    `- **Executed locally (no vendor):** ${statements.local}`,
    '',
    ...(trial ? [trial, ''] : []),
    `Install-level and code-level results are never added together. None of this measures how often real quickstarts break; it measures what the monitor can see. The method, every survivor and the raw data: [docs/DETECTION-POWER.md](docs/DETECTION-POWER.md).`,
  ].join('\n');
}

// The "As of" line is when the data was taken; two runs of the same counts differ only there.
const withoutAsOf = (block: string): string =>
  block
    .split('\n')
    .filter((l) => !l.startsWith('As of '))
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

export interface ReadmeDeps {
  fetch?: (url: string | URL | Request) => Promise<Response>;
}

export async function readmeCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  deps: ReadmeDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      root: { type: 'string', default: '.' },
      site: { type: 'string', default: DEFAULT_SITE },
    },
  });
  const root = path.resolve(values.root);
  const site = values.site.replace(/\/+$/, '');
  const file = path.join(root, 'README.md');
  const doFetch = deps.fetch ?? ((url: string | URL | Request) => fetch(url));

  let status: PublicStatusSummary;
  try {
    const res = await doFetch(`${site}/api/status`);
    if (!res.ok) {
      io.stderr(`${site}/api/status answered ${res.status}: the README was not touched\n`);
      return 2;
    }
    const parsed = PublicStatusSummary.safeParse(await res.json());
    if (!parsed.success) {
      io.stderr(
        `${site}/api/status did not return the status summary: the README was not touched\n`,
      );
      return 2;
    }
    status = parsed.data;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}: the README was not touched\n`);
    return 2;
  }

  const wanted = {
    status: renderStatusBlock(status, site),
    detection: renderDetectionBlock(await buildSummaryFromRepo(root)),
  };
  const readme = await readFile(file, 'utf8');

  if (values.check) {
    let bad = 0;
    for (const name of ['status', 'detection'] as const) {
      if (withoutAsOf(extractBlock(readme, name)) !== withoutAsOf(wanted[name])) {
        io.stderr(`README.md: the ${name} block is out of date. Run: qsr readme\n`);
        bad += 1;
      }
    }
    if (bad === 0) io.stdout('README.md matches the site and docs/detection-power.json\n');
    return bad === 0 ? 0 : 1;
  }

  const next = replaceBlock(
    replaceBlock(readme, 'status', wanted.status),
    'detection',
    wanted.detection,
  );
  if (next !== readme) await writeFile(file, next);
  log.info({ changed: next !== readme }, 'README blocks written');
  io.stdout(next === readme ? 'README.md already up to date\n' : 'README.md updated\n');
  return 0;
}
