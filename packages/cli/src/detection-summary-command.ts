import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { countsPublicly, summariseDetection, type DetectionSummary, type Logger } from '@qsr/core';
import { processIo, type CliIo } from './commands.js';
import { loadAllTargets } from './targets.js';

// `qsr detection-summary [--check] [--root <dir>]`: writes the small file the website's /methodology page reads
// (apps/web/src/data/detection-power.json) from docs/detection-power.json and the target files. The page quotes nothing that
// is not in that file, and the file says nothing that is not in the document. Local only: no network, no API.

export const SUMMARY_FILE = path.join('apps', 'web', 'src', 'data', 'detection-power.json');
const RESULTS_FILE = path.join('docs', 'detection-power.json');

export async function buildSummaryFromRepo(root: string): Promise<DetectionSummary> {
  const raw = JSON.parse(await readFile(path.join(root, RESULTS_FILE), 'utf8')) as unknown;
  // a target on probation is in no count until it leaves probation
  const targets = (await loadAllTargets(path.join(root, 'targets'))).filter(countsPublicly);
  // An enabled target whose level 3 step is recorded and not counted (the shadow mode: docs/NOTES.md).
  const shadow = targets.filter((t) => t.l3?.mode === 'shadow').map((t) => t.slug);
  // The enabled targets that reach level 3 in production: level 3 in the file and not in shadow (the API shows a shadow target at level 2).
  const production = targets
    .filter((t) => t.level >= 3 && t.l3?.mode !== 'shadow')
    .map((t) => t.slug);
  return summariseDetection(raw, shadow, production);
}

const text = (s: DetectionSummary): string => `${JSON.stringify(s, null, 2)}\n`;

export async function detectionSummaryCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { check: { type: 'boolean', default: false }, root: { type: 'string', default: '.' } },
  });
  const root = path.resolve(values.root);
  const file = path.join(root, SUMMARY_FILE);
  const want = await buildSummaryFromRepo(root);
  if (values.check) {
    let have: unknown = null;
    try {
      have = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      io.stderr(`${SUMMARY_FILE} is missing. Run: qsr detection-summary\n`);
      return 1;
    }
    // Compared as data, not text: the file is formatted by prettier afterwards.
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      io.stderr(
        `${SUMMARY_FILE} is out of date with docs/detection-power.json and the target files. Run: qsr detection-summary, then format it\n`,
      );
      return 1;
    }
    io.stdout(`${SUMMARY_FILE} is up to date\n`);
    return 0;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text(want));
  log.info({ file: SUMMARY_FILE }, 'detection summary written');
  io.stdout(`wrote ${SUMMARY_FILE}\n`);
  return 0;
}
