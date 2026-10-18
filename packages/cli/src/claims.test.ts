import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { numbersIn, type PublicStatusSummary } from '@qsr/core';
import {
  buildClaims,
  claimsCommand,
  extractMeasurement,
  extractTargetFacts,
  parseActionsEstimate,
  pipelineFacts,
  readCacheMinutes,
  renderClaimsSheet,
  squash,
  type ClaimsInputs,
  type OpsFacts,
} from './claims.js';
import { ConfigError } from './commands.js';
import { buildSummaryFromRepo } from './detection-summary-command.js';
import { loadAllTargets } from './targets.js';

// docs/CLAIMS.md: every figure that could appear in a public post, one row each, with where it comes from, when it was generated, and a safe
// and an unsafe way to say it. The rows are built from the sources the site uses; nothing is typed. A number in the README or on
// /methodology that is not in the sheet fails a test.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const status: PublicStatusSummary = {
  schemaVersion: 1,
  asOf: '2026-10-18T11:23:56.561Z',
  headline: {
    passing: 50,
    tested: 50,
    failing: 0,
    verifying: 0,
    needsPerson: 1,
    notTested: 0,
    testedAtL3: 3,
    testedAtL2: 47,
    testedAtL1: 0,
    passingAtL3: 3,
    passingAtL2: 47,
    passingAtL1: 0,
  },
  tiers: [
    { tier: 'L3', total: 3, passing: 3, verifying: 0, failing: 0 },
    { tier: 'L2', total: 47, passing: 47, verifying: 0, failing: 0 },
  ],
};
const ops: OpsFacts = {
  launchGeneratedAt: '2026-10-18T16:00:00.000Z',
  statsGeneratedAt: '2026-10-18T16:00:01.000Z',
  cycles: {
    valid: 9,
    invalid: 1,
    firstAt: '2026-10-16T12:20:00.000Z',
    lastAt: '2026-10-18T11:20:29.422Z',
  },
  runs: 460,
  harness: { runs: 470, errors: 6, days: 90 },
  db: { bytes: 19_922_944, limitBytes: 524_288_000 },
  actions: { perCycle: 71, perDay: 284 },
};

async function inputs(over: Partial<ClaimsInputs> = {}): Promise<ClaimsInputs> {
  const detection = await buildSummaryFromRepo(ROOT);
  const raw = JSON.parse(
    readFileSync(path.join(ROOT, 'docs', 'detection-power.json'), 'utf8'),
  ) as unknown;
  return {
    generatedAt: '2026-10-18T16:30:00.000Z',
    site: 'https://quickstartrot.vercel.app',
    status,
    detection,
    measurement: extractMeasurement(raw),
    targets: extractTargetFacts(await loadAllTargets(path.join(ROOT, 'targets'))),
    pipeline: pipelineFacts({ dataCacheMinutes: 5, badgeCacheMinutes: 10 }),
    ops,
    ...over,
  };
}

const REQUIRED = [
  // targets by level and status
  'status.tested',
  'status.passing',
  'status.verifying',
  'status.failing',
  'status.needsPerson',
  'status.notTested',
  'status.testedAtL3',
  'status.testedAtL2',
  'status.testedAtL1',
  'status.passingAtL3',
  'status.passingAtL2',
  'status.passingAtL1',
  // shadow targets
  'targets.shadow',
  'targets.l3Production',
  'targets.local',
  // install-level detection: numerator, denominator, number of targets
  'install.L1',
  'install.L2',
  'install.L3',
  'install.local',
  'install.all',
  // code-level L2 under v1, v2 and v2 with the export check, and the rest
  'code.L2.v1',
  'code.L2.v2',
  'code.L2.exportCheck',
  'code.L2.runtimeNames',
  'code.L2.syntaxAndImports',
  'code.local',
  'code.L3',
  // L3 with the caveat
  'l3.restsOn',
  'l3.production',
  // mutants and operators
  'mutants.records',
  'mutants.planted',
  'mutants.operators',
  'mutants.noSite',
  // operations
  'ops.cycles',
  'ops.runs',
  'ops.harnessErrorRate',
  'ops.actionsMinutesPerDay',
  'ops.dbSize',
];

describe('buildClaims', () => {
  it('has a row for every figure the owner asked for', async () => {
    const ids = buildClaims(await inputs()).map((c) => c.id);
    for (const id of REQUIRED) expect(ids, id).toContain(id);
  });

  it('has one row for each figure the pipeline constants and the site quote about how it works', async () => {
    const ids = buildClaims(await inputs()).map((c) => c.id);
    for (const key of [
      'cycleHours',
      'failuresToOpenIncident',
      'passesToRecover',
      'transientStreakToOpenIncident',
      'transientRetries',
      'transientRetryDelaySeconds',
      'crawlRetries',
      'crawlRetryDelaySeconds',
      'groundingRetries',
      'recurrenceWindowDays',
      'canaryCount',
      'optOutHours',
      'vendorReplyBusinessDays',
      'disclosureWaitHours',
      'dataCacheMinutes',
      'badgeCacheMinutes',
      'targetTotal',
      'librariesPercent',
      'vendorsPercent',
      'vendorRequestsPerCycle',
      'vendorRequestsPerDay',
    ])
      expect(ids, key).toContain(`pipeline.${key}`);
  });

  it('gives every row a claim, a value, a source, a date, and a safe and an unsafe wording that differ', async () => {
    const claims = buildClaims(await inputs());
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
    for (const c of claims) {
      for (const field of ['claim', 'value', 'source', 'generated', 'safe', 'unsafe'] as const)
        expect(c[field].trim(), `${c.id}.${field}`).not.toBe('');
      expect(c.safe, c.id).not.toBe(c.unsafe);
      expect(c.generated, c.id).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('puts the number it is about in the safe wording', async () => {
    for (const c of buildClaims(await inputs())) {
      const first = /\d+(?:\.\d+)?/.exec(c.value)?.[0];
      expect(first, `${c.id} has a number in its value`).toBeDefined();
      expect(numbersIn(c.safe), `${c.id}: the safe wording quotes ${first}`).toContain(first);
    }
  });

  it('keeps level 3 to counts and a caveat: no percentage in an L3 row, and "rests on N" where it is quoted', async () => {
    const claims = buildClaims(await inputs());
    for (const id of ['install.L3', 'code.L3', 'l3.restsOn']) {
      const c = claims.find((x) => x.id === id);
      expect(c?.value, id).not.toMatch(/%/);
      expect(c?.safe, id).not.toMatch(/%/);
    }
    expect(claims.find((c) => c.id === 'l3.restsOn')?.safe).toMatch(/rests on \d+ quickstarts/);
    expect(claims.find((c) => c.id === 'code.L3')?.unsafe).toMatch(/rate|%|catches/i);
  });

  it('never adds install-level and code-level results together', async () => {
    const claims = buildClaims(await inputs());
    const d = (await inputs()).detection;
    const all = claims.find((c) => c.id === 'install.all');
    const sum = (k: 'detected' | 'tested') =>
      (['L1', 'L2', 'L3', 'local'] as const).reduce((n, l) => n + d.install[l][k], 0);
    expect(all?.value).toContain(`${sum('detected')} of ${sum('tested')}`);
    expect(all?.claim).toMatch(/install/i);
    // no row is a blended figure: nothing says overall, combined or blended, and no value is a sum over both kinds
    for (const c of claims) {
      expect(c.claim, c.id).not.toMatch(/\b(?:overall|combined|blended|all mutants)\b/i);
      expect(c.value, c.id).not.toMatch(/\b(?:overall|combined|blended)\b/i);
    }
  });

  it('contains no blended figure anywhere: not even the sum of what the install-level and the code-level mutants noticed', async () => {
    const i = await inputs();
    const d = i.detection;
    const levels = ['L1', 'L2', 'L3', 'local'] as const;
    const blended = levels.reduce((n, l) => n + d.install[l].detected + d.code[l].detected, 0);
    const blendedTested = levels.reduce((n, l) => n + d.install[l].tested + d.code[l].tested, 0);
    for (const c of buildClaims(i)) {
      const nums = numbersIn(`${c.value} ${c.safe} ${c.unsafe}`);
      expect(
        nums.has(String(blended)),
        `${c.id} carries ${blended}, install and code added together`,
      ).toBe(false);
      // the number of mutants that gave a verdict is given per kind, never as one total
      expect(
        nums.has(String(blendedTested)),
        `${c.id} carries ${blendedTested}, install and code added together`,
      ).toBe(false);
    }
  });

  it('only says most quickstarts are tested only as far as L2 when that is what the counts say', async () => {
    const claims = buildClaims(await inputs());
    const text = (s: PublicStatusSummary) =>
      buildClaims({ ...await_inputs, status: s }).find((c) => c.id === 'status.tested')?.safe ?? '';
    const await_inputs = await inputs();
    expect(claims.find((c) => c.id === 'status.tested')?.safe).toMatch(
      /most are tested only as far as L2/,
    );
    const deep: PublicStatusSummary = {
      ...status,
      headline: {
        ...status.headline,
        testedAtL3: 40,
        testedAtL2: 10,
        passingAtL3: 40,
        passingAtL2: 10,
      },
    };
    expect(text(deep)).not.toMatch(/most are tested only as far as L2/);
  });

  it('says plainly that the export check is an experiment and not in production', async () => {
    const c = buildClaims(await inputs()).find((x) => x.id === 'code.L2.exportCheck');
    expect(c?.value).toMatch(/experiment/i);
    expect(c?.value).toMatch(/not in production/i);
    expect(c?.unsafe).toMatch(/catches|detects|production/i);
    expect(c?.safe).toMatch(/not in production/i);
  });

  it('reads the three code-level L2 results from the measurement: v1, v2, and v2 with the export check', async () => {
    const claims = buildClaims(await inputs());
    const m = (await inputs()).measurement;
    expect(claims.find((c) => c.id === 'code.L2.v1')?.value).toContain(
      `${m.v1.detected} of ${m.v1.tested}`,
    );
    expect(claims.find((c) => c.id === 'code.L2.v2')?.value).toContain(
      `${m.v2.detected} of ${m.v2.tested}`,
    );
    expect(claims.find((c) => c.id === 'code.L2.exportCheck')?.value).toContain(
      `${m.exportCheck.detected} of ${m.exportCheck.tested}`,
    );
    expect(m.v2.detected).toBeGreaterThan(m.v1.detected);
  });

  it('marks the figures that change when a shadow target is promoted, and not the constants', async () => {
    const claims = buildClaims(await inputs());
    const flagged = new Set(claims.filter((c) => c.changesOnPromotion).map((c) => c.id));
    for (const id of [
      'status.testedAtL3',
      'status.testedAtL2',
      'status.passingAtL3',
      'status.passingAtL2',
      'targets.shadow',
      'targets.l3Production',
      'l3.production',
      'l3.restsOn',
    ])
      expect(flagged, id).toContain(id);
    for (const c of claims)
      if (c.id.startsWith('pipeline.')) expect(flagged, c.id).not.toContain(c.id);
    expect(flagged.has('ops.dbSize')).toBe(false);
  });

  it('reports the operations figures as measured: cycles, runs, harness error rate, Actions minutes, database size', async () => {
    const claims = buildClaims(await inputs());
    const v = (id: string) => claims.find((c) => c.id === id)?.value ?? '';
    expect(v('ops.cycles')).toContain('9 valid');
    expect(v('ops.cycles')).toContain('1 invalid');
    expect(v('ops.runs')).toContain('460');
    expect(v('ops.harnessErrorRate')).toContain('6 of 470');
    expect(v('ops.harnessErrorRate')).toContain('1.3%');
    expect(v('ops.actionsMinutesPerDay')).toContain('284');
    expect(v('ops.dbSize')).toMatch(/19\.0 MB of 500\.0 MB/);
    expect(claims.find((c) => c.id === 'ops.actionsMinutesPerDay')?.value).toMatch(/estimate/i);
  });

  it('marks the operations rows as unavailable, not zero, when there is no admin access', async () => {
    const claims = buildClaims(await inputs({ ops: null }));
    for (const id of [
      'ops.cycles',
      'ops.runs',
      'ops.harnessErrorRate',
      'ops.actionsMinutesPerDay',
      'ops.dbSize',
    ])
      expect(claims.find((c) => c.id === id)?.value, id).toMatch(/not generated/i);
  });

  it('reads the date of each row from its source, not from the clock', async () => {
    const claims = buildClaims(await inputs());
    const date = (id: string) => claims.find((c) => c.id === id)?.generated;
    expect(date('status.passing')).toBe('2026-10-18 11:23 UTC');
    expect(date('ops.dbSize')).toBe('2026-10-18 16:00 UTC');
    expect(date('code.L2.v2')).toBe('2026-10-18 04:35 UTC');
  });
});

describe('renderClaimsSheet', () => {
  it('is a Markdown document with a table for each group, every row in it once, and the rules for using it', async () => {
    const claims = buildClaims(await inputs());
    const md = renderClaimsSheet(claims, {
      generatedAt: '2026-10-18T16:30:00.000Z',
      site: 'https://quickstartrot.vercel.app',
    });
    expect(md).toMatch(/^# Claims/m);
    expect(md).toContain('2026-10-18 16:30 UTC');
    expect(md).toContain(
      '| Id | Claim | Value | Comes from | Generated | Changes when shadow targets are promoted | Safe wording | Unsafe wording |',
    );
    for (const c of claims) expect(md.split(`\`${c.id}\``).length - 1, c.id).toBe(1);
    expect(md).toMatch(/say only what is in the safe wording/i);
    expect(md).toMatch(/pnpm qsr claims/);
    expect(md).toMatch(/not in production/i);
  });

  it('keeps every cell on one line, with no pipe inside a cell', async () => {
    const md = renderClaimsSheet(buildClaims(await inputs()), {
      generatedAt: '2026-10-18T16:30:00.000Z',
      site: 'https://s.test',
    });
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect(r.split(' | ').length, r.slice(0, 60)).toBe(8);
  });
});

describe('squash', () => {
  it('ignores table padding, dash length and the Generated column, but not a number', () => {
    const a =
      '| Id | Generated | Value |\n| --- | --- | --- |\n| `x` | 2026-10-18 11:23 UTC | 50 of 50 |';
    const b =
      '| Id  | Generated            | Value    |\n| --- | -------------------- | -------- |\n| `x` | 2031-01-01 00:00 UTC | 50 of 50 |';
    expect(squash(a)).toBe(squash(b));
    expect(squash(a)).not.toBe(squash(a.replace('50 of 50', '49 of 50')));
  });
});

describe('parseActionsEstimate', () => {
  it('reads the billed minutes per cycle and per day from scripts/scale-estimate.mjs', () => {
    const out =
      '- Billed Actions minutes: **71 min per cycle**, **284 per day**, 8520 per 30 days (10800 at p90 speed). The repository is public.';
    expect(parseActionsEstimate(out)).toEqual({ perCycle: 71, perDay: 284 });
    expect(parseActionsEstimate('nothing here')).toBeNull();
  });
});

describe('the committed sheet', () => {
  // read inside each test, so a missing sheet fails these tests and not the collection of the whole file
  const read = (): string => readFileSync(path.join(ROOT, 'docs', 'CLAIMS.md'), 'utf8');

  it('has a number for every figure the README states', () => {
    const sheetNumbers = numbersIn(read());
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
      .replaceAll(/```[\s\S]*?```/g, ' ')
      .replaceAll(/<!--[\s\S]*?-->/g, ' ')
      .replaceAll(/`[^`\n]*`/g, ' ')
      .replaceAll(/\]\([^)]*\)/g, ']')
      .replaceAll(/https?:\/\/\S+/g, ' ');
    const missing = [...numbersIn(readme)].filter((n) => !sheetNumbers.has(n));
    expect(
      missing,
      `numbers in the README that are not in docs/CLAIMS.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('is up to date with what the measurement and the target files say', async () => {
    const i = await inputs();
    const fresh = squash(
      renderClaimsSheet(buildClaims(i), { generatedAt: i.generatedAt, site: i.site }),
    );
    const committed = squash(read());
    // the rows that come from committed files must be the sheet's rows; the live ones (the site, the admin API) are checked by `qsr claims --check`
    // squash writes a row as |`id`|...| with no space after the first pipe
    const rows = (md: string, prefixes: string[]) =>
      md.split('\n').filter((l) => prefixes.some((p) => l.startsWith(`|\`${p}`)));
    const offline = ['install.', 'code.', 'l3.', 'mutants.', 'measure.', 'targets.', 'pipeline.'];
    const have = rows(committed, offline);
    expect(have.length, 'the comparison must compare something').toBeGreaterThan(40);
    expect(have.sort()).toEqual(rows(fresh, offline).sort());
  });
});

describe('qsr claims', () => {
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

  /** A repository with the files the command reads. */
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-claims-'));
    dirs.push(dir);
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await mkdir(path.join(dir, 'apps', 'web', 'src', 'lib'), { recursive: true });
    await cp(
      path.join(ROOT, 'docs', 'detection-power.json'),
      path.join(dir, 'docs', 'detection-power.json'),
    );
    await cp(path.join(ROOT, 'targets'), path.join(dir, 'targets'), { recursive: true });
    for (const f of ['cache-constants.ts', 'badge.ts'])
      await cp(
        path.join(ROOT, 'apps', 'web', 'src', 'lib', f),
        path.join(dir, 'apps', 'web', 'src', 'lib', f),
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
  const read = (dir: string) => readFile(path.join(dir, 'docs', 'CLAIMS.md'), 'utf8');

  it('writes docs/CLAIMS.md from the site, the committed files and the operations figures', async () => {
    const dir = await scratch();
    const code = await claimsCommand(args(dir), log, io(), {
      fetch: fetchOf(status),
      ops: async () => ops,
    });
    expect(code).toBe(0);
    const sheet = await read(dir);
    expect(sheet).toContain('`status.passing` |');
    expect(sheet).toContain('50 of 50');
    expect(sheet).toContain('284 minutes a day');
    expect(sheet).toContain('`pipeline.cycleHours`');
  });

  it('reads the cache times from the web app’s own files', async () => {
    expect(await readCacheMinutes(ROOT)).toEqual({ dataCacheMinutes: 5, badgeCacheMinutes: 10 });
  });

  it('--check passes straight after writing, whatever the clock says, and does not write', async () => {
    const dir = await scratch();
    await claimsCommand(args(dir), log, io(), {
      fetch: fetchOf(status),
      ops: async () => ops,
      now: () => new Date('2026-10-18T16:30:00Z'),
    });
    const before = await read(dir);
    const r = io();
    expect(
      await claimsCommand(args(dir, '--check'), log, r, {
        fetch: fetchOf(status),
        ops: async () => ops,
        now: () => new Date('2027-01-01T00:00:00Z'),
      }),
    ).toBe(0);
    expect(await read(dir)).toBe(before);
  });

  it('--check fails when a count on the site, or a figure from the admin API, has moved', async () => {
    const dir = await scratch();
    await claimsCommand(args(dir), log, io(), { fetch: fetchOf(status), ops: async () => ops });
    const moved = { ...status, headline: { ...status.headline, passing: 49 } };
    const a = io();
    expect(
      await claimsCommand(args(dir, '--check'), log, a, {
        fetch: fetchOf(moved),
        ops: async () => ops,
      }),
    ).toBe(1);
    expect(a.err.join('')).toMatch(/out of date/);
    expect(a.err.join('')).toMatch(/qsr claims/);
    const b = io();
    expect(
      await claimsCommand(args(dir, '--check'), log, b, {
        fetch: fetchOf(status),
        ops: async () => ({ ...ops, runs: ops.runs + 1 }),
      }),
    ).toBe(1);
  });

  it('--check fails when the sheet is missing', async () => {
    const dir = await scratch();
    const r = io();
    expect(
      await claimsCommand(args(dir, '--check'), log, r, {
        fetch: fetchOf(status),
        ops: async () => ops,
      }),
    ).toBe(1);
    expect(r.err.join('')).toMatch(/missing/);
  });

  it('--no-admin writes the operations rows as "not generated" and never asks for them', async () => {
    const dir = await scratch();
    let asked = 0;
    const code = await claimsCommand(args(dir, '--no-admin'), log, io(), {
      fetch: fetchOf(status),
      ops: async () => {
        asked += 1;
        return ops;
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe(0);
    expect(await read(dir)).toMatch(/not generated/);
  });

  it('without admin access it stops, says which flag leaves the figures out, and writes nothing', async () => {
    const dir = await scratch();
    const r = io();
    const code = await claimsCommand(args(dir), log, r, {
      fetch: fetchOf(status),
      ops: async () => {
        throw new ConfigError('API_BASE_URL and ADMIN_TOKEN must be set');
      },
    });
    expect(code).toBe(2);
    expect(r.err.join('')).toMatch(/--no-admin/);
    await expect(read(dir)).rejects.toThrow();
  });

  it('leaves the sheet alone and exits 2 when the site cannot be reached', async () => {
    const dir = await scratch();
    await claimsCommand(args(dir), log, io(), { fetch: fetchOf(status), ops: async () => ops });
    const before = await read(dir);
    const r = io();
    expect(
      await claimsCommand(args(dir), log, r, {
        fetch: fetchOf({ error: 'x' }, false),
        ops: async () => ops,
      }),
    ).toBe(2);
    expect(r.err.join('')).toMatch(/503|did not touch|not touched/i);
    expect(await read(dir)).toBe(before);
  });
});
