import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicStatusSummary } from '@qsr/core';
import { badgeParagraph, l3ProductionSentence, PIPELINE } from '@qsr/core';
import {
  extractBlock,
  readmeCommand,
  renderDetectionBlock,
  renderPromiseBlock,
  renderStatusBlock,
  replaceBlock,
} from './readme-command.js';
import { buildSummaryFromRepo, SUMMARY_FILE } from './detection-summary-command.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const status = (over: Partial<PublicStatusSummary['headline']> = {}): PublicStatusSummary => ({
  schemaVersion: 1,
  asOf: '2026-10-18T12:00:00.000Z',
  headline: {
    passing: 40,
    tested: 45,
    failing: 1,
    verifying: 2,
    needsPerson: 1,
    notTested: 3,
    testedAtL3: 3,
    testedAtL2: 36,
    testedAtL1: 6,
    passingAtL3: 3,
    passingAtL2: 33,
    passingAtL1: 4,
    ...over,
  },
  tiers: [
    { tier: 'L3', total: 3, passing: 3, verifying: 0, failing: 0 },
    { tier: 'L2', total: 36, passing: 33, verifying: 2, failing: 1 },
    { tier: 'L1', total: 6, passing: 4, verifying: 0, failing: 0 },
  ],
});

describe('renderStatusBlock: the table is the site’s counts, and only those', () => {
  it('says X of Y, the cadence from the code, and a row for each level that was tested', () => {
    const t = renderStatusBlock(status());
    expect(t).toContain('**40 of 45**');
    expect(t).toContain(`every ${PIPELINE.cycleHours} hours`);
    expect(t).toMatch(/\| L3 .*\| 3 \| 0 \| 0 \| 3 \|/);
    expect(t).toMatch(/\| L2 .*\| 33 \| 2 \| 1 \| 36 \|/);
    expect(t).toMatch(/\| L1 .*\| 4 \| 0 \| 0 \| 6 \|/);
    expect(t).toContain('1 more needs a person');
    expect(t).toContain('3 have not been tested yet');
    expect(t).toContain('As of 2026-10-18 12:00 UTC');
  });

  it('is generated from the numbers: other numbers give other text, with nothing left over', () => {
    const a = renderStatusBlock(status());
    const b = renderStatusBlock({
      ...status({ passing: 7, tested: 9, needsPerson: 4, notTested: 5 }),
      tiers: [{ tier: 'L2', total: 9, passing: 7, verifying: 1, failing: 1 }],
    });
    expect(b).toContain('**7 of 9**');
    expect(b).not.toContain('40 of 45');
    expect(b).not.toMatch(/\| L3 /);
    expect(a).not.toBe(b);
  });

  it('leaves out the sentence about people and untested ones when there are none', () => {
    const t = renderStatusBlock(status({ needsPerson: 0, notTested: 0 }));
    expect(t).not.toMatch(/need a person|not been tested/);
  });

  it('says so, and shows no table, before the first cycle', () => {
    const empty: PublicStatusSummary = {
      ...status({ passing: 0, tested: 0, failing: 0, verifying: 0, needsPerson: 0, notTested: 0 }),
      asOf: null,
      tiers: [],
    };
    const t = renderStatusBlock(empty);
    expect(t).toMatch(/No quickstart has been tested yet/);
    expect(t).not.toContain('| L');
    expect(t).not.toMatch(/As of/);
  });

  it('shows a failure only as a count: "being verified" is not "failing"', () => {
    const t = renderStatusBlock(status());
    expect(t).toContain('Being verified');
    expect(t).toContain('Confirmed failing');
    expect(t).not.toMatch(/TypeError|stack|log/i);
  });
});

describe('renderDetectionBlock', () => {
  it('is wording B and the per-level lines, from the committed summary', async () => {
    const summary = await buildSummaryFromRepo(ROOT);
    const t = renderDetectionBlock(summary);
    expect(t).toContain(badgeParagraph(summary));
    expect(t).toContain(l3ProductionSentence(summary));
    expect(t).toContain('- **L1:**');
    expect(t).toContain('- **L2:**');
    expect(t).toContain('- **L3:**');
    expect(t).toContain('- **Executed locally (no vendor):**');
    expect(t).not.toMatch(/\d%/);
  });
});

describe('renderPromiseBlock', () => {
  it('states the promise to vendors from the constants: probing stops within a day of an opt-out request, a written reply within three business days', () => {
    expect(renderPromiseBlock()).toBe(
      `Probing stops within ${PIPELINE.optOutHours} hours of an opt-out request, and we reply in writing within ${PIPELINE.vendorReplyBusinessDays} business days.`,
    );
  });
});

describe('replaceBlock and extractBlock', () => {
  const doc = 'before\n<!-- qsr:x:start -->\nold\n<!-- qsr:x:end -->\nafter\n';

  it('replaces what is between the markers and nothing else', () => {
    expect(replaceBlock(doc, 'x', 'new')).toBe(
      'before\n<!-- qsr:x:start -->\nnew\n<!-- qsr:x:end -->\nafter\n',
    );
    expect(extractBlock(doc, 'x')).toBe('old');
  });

  it('refuses a document without the markers, or with them twice', () => {
    expect(() => replaceBlock('nothing', 'x', 'new')).toThrow(/qsr:x/);
    expect(() => replaceBlock(`${doc}${doc}`, 'x', 'new')).toThrow(/more than once/);
    expect(() => extractBlock('nothing', 'x')).toThrow(/qsr:x/);
  });
});

describe('qsr readme', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
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
  const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as never;
  const fetchOf =
    (body: unknown, ok = true) =>
    async (url: string | URL | Request): Promise<Response> => {
      expect(String(url)).toBe('https://site.test/api/status');
      return new Response(JSON.stringify(body), { status: ok ? 200 : 503 });
    };

  /** A repository with the inputs the command reads, and a README with its markers. */
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-readme-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await cp(
      path.join(ROOT, 'docs', 'detection-power.json'),
      path.join(dir, 'docs', 'detection-power.json'),
    );
    await cp(path.join(ROOT, 'targets'), path.join(dir, 'targets'), { recursive: true });
    await writeFile(
      path.join(dir, 'README.md'),
      '# T\n\nhook\n\n<!-- qsr:status:start -->\nstale\n<!-- qsr:status:end -->\n\n## Levels\n\n<!-- qsr:detection:start -->\nstale\n<!-- qsr:detection:end -->\n\n<!-- qsr:promise:start -->\nstale\n<!-- qsr:promise:end -->\n\nrest of the file\n',
    );
    return dir;
  }
  const args = (dir: string, ...more: string[]) => [
    '--root',
    dir,
    '--site',
    'https://site.test',
    ...more,
  ];

  it('writes the three blocks from the site’s counts, the committed summary and the pipeline constants, and keeps the rest of the file', async () => {
    const dir = await scratch();
    expect(await readmeCommand(args(dir), log, io(), { fetch: fetchOf(status()) })).toBe(0);
    const readme = await readFile(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('# T\n\nhook\n');
    expect(readme).toContain('rest of the file\n');
    expect(extractBlock(readme, 'status')).toBe(
      renderStatusBlock(status(), 'https://site.test').trim(),
    );
    expect(extractBlock(readme, 'detection')).toBe(
      renderDetectionBlock(await buildSummaryFromRepo(dir)).trim(),
    );
    expect(extractBlock(readme, 'promise')).toBe(renderPromiseBlock());
  });

  it('--check passes straight after writing, and ignores only the "As of" time', async () => {
    const dir = await scratch();
    await readmeCommand(args(dir), log, io(), { fetch: fetchOf(status()) });
    const later = { ...status(), asOf: '2026-10-19T00:00:00.000Z' };
    const r = io();
    expect(await readmeCommand(args(dir, '--check'), log, r, { fetch: fetchOf(later) })).toBe(0);
  });

  // The repository formats every markdown file with prettier, which pads table cells to a common width. The check must read that as the
  // same table, and still see a changed number.
  it('--check passes after prettier has aligned the table, and still fails when a number differs', async () => {
    const dir = await scratch();
    await readmeCommand(args(dir), log, io(), { fetch: fetchOf(status()) });
    const file = path.join(dir, 'README.md');
    const aligned = (await readFile(file, 'utf8'))
      .replace('| Tested up to | Passing |', '| Tested up to                           | Passing |')
      .replace('| --- | ---: |', '| -------------------------------------- | ------: |')
      .replace(
        "| L3 (reached the vendor's API) | 3 |",
        "| L3 (reached the vendor's API)          |       3 |",
      );
    expect(aligned).not.toBe(await readFile(file, 'utf8'));
    await writeFile(file, aligned);
    expect(await readmeCommand(args(dir, '--check'), log, io(), { fetch: fetchOf(status()) })).toBe(
      0,
    );
    const moved = io();
    expect(
      await readmeCommand(args(dir, '--check'), log, moved, {
        fetch: fetchOf(status({ passing: 39 })),
      }),
    ).toBe(1);
    expect(moved.err.join('')).toMatch(/status block is out of date/);
  });

  it('--check fails, naming the block, when a count on the site moved', async () => {
    const dir = await scratch();
    await readmeCommand(args(dir), log, io(), { fetch: fetchOf(status()) });
    const r = io();
    const moved = status({ passing: 39 });
    expect(await readmeCommand(args(dir, '--check'), log, r, { fetch: fetchOf(moved) })).toBe(1);
    expect(r.err.join('')).toMatch(/status block is out of date/);
    expect(r.err.join('')).toMatch(/qsr readme/);
  });

  it('--check fails when the detection block no longer matches the committed summary', async () => {
    const dir = await scratch();
    await readmeCommand(args(dir), log, io(), { fetch: fetchOf(status()) });
    const file = path.join(dir, 'README.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('noticed', 'NOTICED'));
    const r = io();
    expect(await readmeCommand(args(dir, '--check'), log, r, { fetch: fetchOf(status()) })).toBe(1);
    expect(r.err.join('')).toMatch(/detection block is out of date/);
  });

  it('does not touch the README with --check', async () => {
    const dir = await scratch();
    const before = await readFile(path.join(dir, 'README.md'), 'utf8');
    await readmeCommand(args(dir, '--check'), log, io(), { fetch: fetchOf(status()) });
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe(before);
  });

  it('leaves the README alone and exits 2 when the site cannot be reached or answers with something else', async () => {
    const dir = await scratch();
    const before = await readFile(path.join(dir, 'README.md'), 'utf8');
    const down = io();
    expect(
      await readmeCommand(args(dir), log, down, {
        fetch: fetchOf({ error: 'unavailable' }, false),
      }),
    ).toBe(2);
    expect(down.err.join('')).toMatch(/503|unavailable|status/i);
    const wrong = io();
    expect(await readmeCommand(args(dir), log, wrong, { fetch: fetchOf({ hello: 'world' }) })).toBe(
      2,
    );
    const throwing = io();
    expect(
      await readmeCommand(args(dir), log, throwing, {
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    ).toBe(2);
    expect(throwing.err.join('')).toMatch(/ENOTFOUND/);
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe(before);
  });

  it('uses the committed summary file name the website reads (the two blocks quote one source)', () => {
    expect(SUMMARY_FILE).toContain('detection-power.json');
  });
});
