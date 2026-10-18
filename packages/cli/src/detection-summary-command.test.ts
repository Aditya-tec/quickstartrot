import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { badgeParagraph, DetectionSummary, levelStatements } from '@qsr/core';
import {
  buildSummaryFromRepo,
  detectionSummaryCommand,
  SUMMARY_FILE,
} from './detection-summary-command.js';
import { loadAllTargets } from './targets.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
  };
};
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return log;
  },
} as never;

// The website's /methodology page reads apps/web/src/data/detection-power.json. It is generated from docs/detection-power.json and
// the target files, and it must equal what they say today: a stale copy would put an old figure on a public page.
describe('the committed summary the website reads', () => {
  it('equals what docs/detection-power.json and the target files say now', async () => {
    const committed = JSON.parse(await readFile(path.join(ROOT, SUMMARY_FILE), 'utf8')) as unknown;
    expect(DetectionSummary.parse(committed)).toEqual(await buildSummaryFromRepo(ROOT));
  });

  it('lists exactly the enabled targets whose level 3 step runs in shadow mode, and none of them counts at level 3', async () => {
    const summary = await buildSummaryFromRepo(ROOT);
    const shadow = (await loadAllTargets(path.join(ROOT, 'targets')))
      .filter((t) => t.enabled !== false && t.l3?.mode === 'shadow')
      .map((t) => t.slug)
      .sort();
    expect(summary.shadowTargets).toEqual(shadow);
    expect(shadow.length).toBeGreaterThan(0);
    for (const slug of shadow) expect(summary.l3Targets).not.toContain(slug);
  });

  it('says level 3 rests on the targets that were measured at level 3, and counts them', async () => {
    const summary = await buildSummaryFromRepo(ROOT);
    expect(summary.l3Targets.length).toBe(summary.levelTargets.L3);
  });
});

describe('qsr detection-summary', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  /** A copy of the inputs, so the real file is never written by a test. */
  async function scratchRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-summary-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await cp(
      path.join(ROOT, 'docs', 'detection-power.json'),
      path.join(dir, 'docs', 'detection-power.json'),
    );
    await cp(path.join(ROOT, 'targets'), path.join(dir, 'targets'), { recursive: true });
    return dir;
  }

  it('writes the file, and --check then passes', async () => {
    const dir = await scratchRepo();
    const a = io();
    expect(await detectionSummaryCommand(['--root', dir], log, a)).toBe(0);
    const written = JSON.parse(await readFile(path.join(dir, SUMMARY_FILE), 'utf8')) as unknown;
    expect(DetectionSummary.parse(written)).toEqual(await buildSummaryFromRepo(dir));
    const b = io();
    expect(await detectionSummaryCommand(['--check', '--root', dir], log, b)).toBe(0);
  });

  it('--check fails, and says how to fix it, when the file is missing or stale', async () => {
    const dir = await scratchRepo();
    const missing = io();
    expect(await detectionSummaryCommand(['--check', '--root', dir], log, missing)).toBe(1);
    expect(missing.err.join('')).toMatch(/qsr detection-summary/);
    await detectionSummaryCommand(['--root', dir], log, io());
    const file = path.join(dir, SUMMARY_FILE);
    const stale = JSON.parse(await readFile(file, 'utf8')) as {
      code: { L2: { detected: number } };
    };
    stale.code.L2.detected += 1;
    await writeFile(file, JSON.stringify(stale));
    const r = io();
    expect(await detectionSummaryCommand(['--check', '--root', dir], log, r)).toBe(1);
    expect(r.err.join('')).toMatch(/out of date/i);
  });

  it('does not touch the file with --check', async () => {
    const dir = await scratchRepo();
    await detectionSummaryCommand(['--root', dir], log, io());
    const file = path.join(dir, SUMMARY_FILE);
    const before = await readFile(file, 'utf8');
    await detectionSummaryCommand(['--check', '--root', dir], log, io());
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

// "Use approved wording B": the sentences the site and the README quote are the approved ones in docs/DETECTION-POWER.md, with the
// figures read from the data. If a new measurement changes a figure, the hand-written recommendation must be updated with it, and this
// fails until it is: the page can never say something the document does not.
describe('the wording the site and the README quote is the approved wording', () => {
  const approved = async () => readFile(path.join(ROOT, 'docs', 'DETECTION-POWER.md'), 'utf8');
  const quoted = (md: string, lead: string): string => {
    const line = md.split('\n').find((l) => l.startsWith(lead));
    if (!line) throw new Error(`docs/DETECTION-POWER.md has no line starting ${lead}`);
    return /"(.*)"/.exec(line)?.[1] ?? '';
  };

  it('badge paragraph = Candidate B (the one number written as a word in the document is a digit here)', async () => {
    const md = await approved();
    expect(md).toMatch(/\*\*Preferred: B\.\*\*/);
    const b = quoted(md, '- **Candidate B');
    expect(badgeParagraph(await buildSummaryFromRepo(ROOT))).toBe(
      b.replace('rests on two quickstarts so far', 'rests on 2 quickstarts so far'),
    );
  });

  it('L1 and L2 lines = the approved per-level lines', async () => {
    const md = await approved();
    const s = levelStatements(await buildSummaryFromRepo(ROOT));
    expect(s.L1).toBe(quoted(md, '- **L1:**'));
    expect(s.L2).toBe(quoted(md, '- **L2:**'));
  });

  it('L3 line = the approved line, with the number of quickstarts named instead of "a small number"', async () => {
    const md = await approved();
    const s = levelStatements(await buildSummaryFromRepo(ROOT));
    const approvedL3 = quoted(md, '- **L3:**');
    const [head] = approvedL3.split(' It rests on ');
    expect(s.L3.startsWith(`${head ?? ''} It rests on `)).toBe(true);
    expect(s.L3.endsWith('so we quote no detection rate for it.')).toBe(true);
  });

  it('executed-locally line = the approved line, with the number of targets stated', async () => {
    const md = await approved();
    const s = levelStatements(await buildSummaryFromRepo(ROOT));
    const withoutCount = s.local.replace(/ \d+ targets? (?:is|are) of that kind here\./, '');
    expect(withoutCount).toBe(quoted(md, '- **Executed locally:**'));
  });
});
