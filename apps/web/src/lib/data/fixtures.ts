import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  PublicIncidentRow,
  PublicRunHistoryRow,
  PublicRunRow,
  PublicToolRow,
  type RunKind,
} from '@qsr/core/public';
import type { DataSource } from './source';

// The seeded data behind QSR_DATA=fixtures (development, Playwright, screenshots, Lighthouse). It has a fixed
// clock so everything is reproducible, covers every state a page can be in, and deliberately includes
// "poisoned" rows: an unreviewed (PENDING_REVIEW) incident and a FALSE_POSITIVE one that carry a distinctive
// cause string, and a failing run of the unreviewed tool whose row claims its details are published. In
// production the database views never send those; here they let the leak tests prove the app does not show
// them even if a layer below it failed.

export const FIXTURE_NOW = new Date('2026-10-17T12:00:00.000Z');
/** The string no page, badge, image or payload may ever contain. */
export const UNREVIEWED_CAUSE = 'ZZ-UNREVIEWED-CAUSE-4d1e: widget.render() was removed in 9.0';

export const FIXTURE_SLUGS = {
  healthy: 'resend-node',
  l2: 'zod-node',
  pythonHealthy: 'dotenv-python',
  stale: 'loguru-python',
  verifying: 'fastify-node',
  failing: 'chalk-node',
  needsPerson: 'hono-node',
  unknown: 'brand-new-node',
  longName: 'the-extremely-long-named-developer-toolkit-sdk-for-python',
  manyRuns: 'many-runs-node',
} as const;

const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = FIXTURE_NOW.getTime();

/** A deterministic UUID from two small numbers. */
const uuid = (a: number, b: number): string =>
  `${a.toString(16).padStart(8, '0')}-0000-4000-8000-${b.toString(16).padStart(12, '0')}`;

type Behaviour = 'pass' | 'fail' | 'skipped';
interface ToolSpec {
  slug: string;
  name: string;
  language: 'node' | 'python';
  level: number;
  status: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';
  statusSince: string | null;
  runs: number;
  passRate: number | null;
  /** What run number i (0 = newest) did. */
  kindAt: (i: number) => RunKind;
  staleNewest?: boolean;
  truncated?: boolean;
  docsUrl: string;
}

const specs: ToolSpec[] = [
  {
    slug: FIXTURE_SLUGS.healthy,
    name: 'Resend (Node.js SDK)',
    language: 'node',
    level: 3,
    status: 'HEALTHY',
    statusSince: iso(NOW - 14 * 24 * HOUR),
    runs: 60,
    passRate: 0.9667,
    kindAt: (i) => (i === 17 ? 'fail' : 'pass'),
    docsUrl: 'https://resend.com/docs/send-with-nodejs',
  },
  {
    slug: FIXTURE_SLUGS.l2,
    name: 'Zod',
    language: 'node',
    level: 2,
    status: 'HEALTHY',
    statusSince: iso(NOW - 20 * 24 * HOUR),
    runs: 60,
    passRate: 1,
    kindAt: () => 'pass',
    docsUrl: 'https://zod.dev',
  },
  {
    slug: FIXTURE_SLUGS.pythonHealthy,
    name: 'python-dotenv',
    language: 'python',
    level: 3,
    status: 'HEALTHY',
    statusSince: iso(NOW - 9 * 24 * HOUR),
    runs: 40,
    passRate: 1,
    kindAt: (i) => (i === 3 ? 'not_run' : 'pass'),
    docsUrl: 'https://saurabh-kumar.com/python-dotenv/',
  },
  {
    slug: FIXTURE_SLUGS.stale,
    name: 'Loguru',
    language: 'python',
    level: 3,
    status: 'HEALTHY',
    statusSince: iso(NOW - 6 * 24 * HOUR),
    runs: 30,
    passRate: 1,
    kindAt: () => 'pass',
    staleNewest: true,
    truncated: true,
    docsUrl: 'https://loguru.readthedocs.io/en/stable/overview.html',
  },
  {
    slug: FIXTURE_SLUGS.verifying,
    name: 'Fastify',
    language: 'node',
    level: 2,
    status: 'DEGRADED',
    statusSince: iso(NOW - 18 * HOUR),
    runs: 30,
    passRate: 0.9,
    kindAt: (i) => (i < 2 ? 'fail' : 'pass'),
    docsUrl: 'https://fastify.dev/docs/latest/Guides/Getting-Started/',
  },
  {
    slug: FIXTURE_SLUGS.failing,
    name: 'Chalk',
    language: 'node',
    level: 3,
    status: 'BROKEN',
    statusSince: '2026-10-12T07:00:00.000Z',
    runs: 40,
    passRate: 0.7,
    kindAt: (i) => (i < 5 ? 'fail' : 'pass'),
    docsUrl: 'https://github.com/chalk/chalk',
  },
  {
    slug: FIXTURE_SLUGS.needsPerson,
    name: 'Hono',
    language: 'node',
    level: 2,
    status: 'UNKNOWN',
    statusSince: null,
    runs: 8,
    passRate: null,
    kindAt: () => 'skipped',
    docsUrl: 'https://hono.dev/docs/getting-started/basic',
  },
  {
    slug: FIXTURE_SLUGS.unknown,
    name: 'Brand New SDK',
    language: 'node',
    level: 3,
    status: 'UNKNOWN',
    statusSince: null,
    runs: 0,
    passRate: null,
    kindAt: () => 'pass',
    docsUrl: 'https://example.dev/brand-new',
  },
  {
    slug: FIXTURE_SLUGS.longName,
    name: 'The Extremely Long Named Developer Toolkit Software Development Kit for Python Applications',
    language: 'python',
    level: 2,
    status: 'HEALTHY',
    statusSince: iso(NOW - 3 * 24 * HOUR),
    runs: 12,
    passRate: 1,
    kindAt: () => 'pass',
    docsUrl: 'https://example.dev/a/really/quite/long/path/to/the/quickstart/page/of/this/toolkit',
  },
  {
    slug: FIXTURE_SLUGS.manyRuns,
    name: 'Many Runs Library',
    language: 'node',
    level: 3,
    status: 'HEALTHY',
    statusSince: iso(NOW - 25 * 24 * HOUR),
    runs: 100,
    passRate: 0.98,
    kindAt: (i) => (i % 37 === 5 ? 'fail' : 'pass'),
    docsUrl: 'https://example.dev/many-runs',
  },
];

const runId = (toolIndex: number, i: number): string => uuid(toolIndex + 1, i + 1);

function kindOutcome(kind: RunKind): 'PASS' | 'FAIL' | 'SKIPPED' | 'HARNESS_ERROR' {
  return kind === 'pass'
    ? 'PASS'
    : kind === 'skipped'
      ? 'SKIPPED'
      : kind === 'harness'
        ? 'HARNESS_ERROR'
        : 'FAIL';
}

// ---- the docs the plan is built from, and the plan
const BLOCKS = [
  {
    index: 0,
    kind: 'code',
    lang: 'bash',
    text: 'npm install acme-sdk',
    filenameHint: null,
    headingPath: ['Quickstart'],
  },
  {
    index: 1,
    kind: 'code',
    lang: 'js',
    text: "import { Acme } from 'acme-sdk';\n\nconst acme = new Acme('demo-key');\nawait acme.send({ to: 'dev@example.com' });\nconsole.log('sent');",
    filenameHint: 'index.js',
    headingPath: ['Quickstart', 'Send a message'],
  },
  {
    index: 2,
    kind: 'code',
    lang: 'bash',
    text: 'node index.js',
    filenameHint: null,
    headingPath: ['Quickstart', 'Run it'],
  },
];

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const planIr = (level: number) => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'npm_init',
  maxLevelReachable: level,
  notes: 'Install the package, write index.js, run it.',
  steps: [
    {
      kind: 'shell',
      id: 's1',
      command: 'npm install acme-sdk',
      source: { blockIndex: 0, lineStart: 1, lineEnd: 1 },
      expect: EXPECT,
    },
    {
      kind: 'write_file',
      id: 's2',
      path: 'index.js',
      content: BLOCKS[1]?.text,
      source: { blockIndex: 1, lineStart: 1, lineEnd: 5 },
    },
    ...(level >= 3
      ? [
          {
            kind: 'run',
            id: 's3',
            command: 'node index.js',
            source: { blockIndex: 2, lineStart: 1, lineEnd: 1 },
            expect: EXPECT,
          },
        ]
      : []),
  ],
});

const LOG_PATHS = {
  chalk: 'logs/fixture/chalk-fail-aaaaaaaaaaaaaaaaaaaaaaaa/02-s3.log.gz',
  fastify: 'logs/fixture/fastify-fail-bbbbbbbbbbbbbbbbbbbbbbbb/01-s2.log.gz',
  pass: 'logs/fixture/pass-cccccccccccccccccccccccc/00-s1.log.gz',
};
const DIFF_PATHS = {
  chalk: 'diffs/fixture/chalk-docs.diff',
  fastify: 'diffs/fixture/fastify-docs.diff',
};

const CHALK_CAUSE = 'TypeError: chalk.red is not a function';

const LOGS: Record<string, string> = {
  [LOG_PATHS.chalk]: `$ node index.js\nfile:///work/index.js:3\nconsole.log(chalk.red('hello'));\n            ^\n\n${CHALK_CAUSE}\n    at file:///work/index.js:3:13\n\nNode.js v22.11.0\n`,
  [LOG_PATHS.fastify]: `$ node server.js\n${UNREVIEWED_CAUSE}\n    at start (server.js:7:3)\n`,
  [LOG_PATHS.pass]: '$ npm install acme-sdk\nadded 1 package in 2s\n',
};
const DIFFS: Record<string, string> = {
  [DIFF_PATHS.chalk]: `--- docs/quickstart (last passing run)\n+++ docs/quickstart (first failing run)\n@@ -12,7 +12,7 @@\n import chalk from 'chalk';\n \n-console.log(chalk.red('hello'));\n+console.log(chalk.redBright('hello'));\n`,
  [DIFF_PATHS.fastify]: `--- docs/getting-started (last passing run)\n+++ docs/getting-started (first failing run)\n@@ -4,3 +4,3 @@\n-${'x'} before\n+${UNREVIEWED_CAUSE}\n`,
};

/** The fixture artifacts the test-only artifact route may serve: those of CONFIRMED items. Never the unreviewed ones. */
export const PUBLIC_FIXTURE_PATHS: readonly string[] = [
  LOG_PATHS.chalk,
  LOG_PATHS.pass,
  DIFF_PATHS.chalk,
];

export const fixtureLog = (path: string): Buffer | null =>
  path in LOGS ? gzipSync(Buffer.from(LOGS[path] as string, 'utf8')) : null;
export const fixtureDiff = (path: string): string | null => DIFFS[path] ?? null;

// ---- build every row once
function runRow(spec: ToolSpec, toolIndex: number, i: number, kind: RunKind): PublicRunRow {
  const startedAt = NOW - (i * 6 + 1) * HOUR;
  const stale = spec.staleNewest === true && i === 0;
  const outcome = kindOutcome(kind);
  const isChalkFail = spec.slug === FIXTURE_SLUGS.failing && kind === 'fail';
  const isFastifyFail = spec.slug === FIXTURE_SLUGS.verifying && kind === 'fail';
  const failedStepStderr = isChalkFail
    ? CHALK_CAUSE
    : isFastifyFail
      ? UNREVIEWED_CAUSE
      : 'Error: request failed';
  const failIndex = spec.level >= 3 ? 2 : 1;
  const steps =
    kind === 'skipped'
      ? [
          {
            step_id: 's1',
            ordinal: 0,
            kind: 'manual',
            outcome: 'SKIPPED',
            exit_code: null,
            duration_ms: 0,
            stdout_tail: null,
            stderr_tail: null,
            log_path: null,
          },
        ]
      : kind === 'not_run'
        ? []
        : [
            {
              step_id: 's1',
              ordinal: 0,
              kind: 'shell',
              outcome: 'PASS',
              exit_code: 0,
              duration_ms: 2400,
              stdout_tail: 'added 1 package in 2s',
              stderr_tail: null,
              log_path: kind === 'pass' && i === 0 ? LOG_PATHS.pass : null,
            },
            {
              step_id: 's2',
              ordinal: 1,
              kind: 'write_file',
              outcome: isFastifyFail ? 'FAIL' : 'PASS',
              exit_code: isFastifyFail ? 1 : 0,
              duration_ms: 12,
              stdout_tail: null,
              stderr_tail: isFastifyFail ? failedStepStderr : null,
              log_path: isFastifyFail ? LOG_PATHS.fastify : null,
            },
            ...(spec.level >= 3
              ? [
                  {
                    step_id: 's3',
                    ordinal: 2,
                    kind: 'run',
                    outcome:
                      kind === 'fail' && !isFastifyFail
                        ? 'FAIL'
                        : kind === 'fail'
                          ? 'SKIPPED'
                          : 'PASS',
                    exit_code: kind === 'fail' && !isFastifyFail ? 1 : kind === 'fail' ? null : 0,
                    duration_ms: 480,
                    stdout_tail: kind === 'pass' ? 'sent' : null,
                    stderr_tail: kind === 'fail' && !isFastifyFail ? failedStepStderr : null,
                    log_path: isChalkFail ? LOG_PATHS.chalk : null,
                  },
                ]
              : []),
          ];
  const failed = kind === 'fail';
  const env: Record<string, string> = {
    node: 'v22.11.0',
    npm: '10.9.0',
    os: 'linux',
    shard: String(i % 3),
    resolved: JSON.stringify({
      'acme-sdk': isChalkFail ? '4.0.0' : '3.4.1',
      'left-pad-ish': '1.3.0',
    }),
    ...(stale ? { plan_stale: 'true' } : {}),
  };
  return PublicRunRow.parse({
    id: runId(toolIndex, i),
    tool_slug: spec.slug,
    cycle_id: uuid(0xc0de, i + 1),
    attempt: 1,
    outcome,
    // POISON for the unreviewed tool: class, signature and steps are filled and the row claims it is published
    failure_class: failed ? 'API_DRIFT' : null,
    failure_signature: failed ? (isFastifyFail ? UNREVIEWED_CAUSE : 'sig-chalk-red') : null,
    failed_step_id: failed ? (isFastifyFail ? 's2' : (steps.at(failIndex)?.step_id ?? 's3')) : null,
    image_digest: `sha256:${(toolIndex + 1).toString(16).repeat(64).slice(0, 64)}`,
    runner_env: env,
    duration_ms: 4200 + i * 11,
    started_at: iso(startedAt),
    finished_at: iso(startedAt + 4200),
    snapshot_hash: 'ab'.repeat(32),
    plan_ir: kind === 'not_run' ? null : planIr(spec.level),
    grounding_report: { ok: true, violations: [] },
    steps,
    details_published: true,
    reached_level: kind === 'pass' ? spec.level : kind === 'fail' ? Math.max(0, spec.level - 1) : 0,
    skip_reason: kind === 'skipped' ? 'manual_step' : null,
    plan_compiler_version: '2026-10-16.5',
    plan_truncation:
      spec.truncated === true
        ? {
            truncated: true,
            totalBlocks: 62,
            includedBlocks: 29,
            omittedBlocks: 33,
            omittedBlockIndexes: [30, 31, 32],
            clippedBlockIndexes: [],
          }
        : {
            truncated: false,
            totalBlocks: 3,
            includedBlocks: 3,
            omittedBlocks: 0,
            omittedBlockIndexes: [],
            clippedBlockIndexes: [],
          },
    plan_stale: stale,
    harness_version: stale ? 1 : 2,
    snapshot_blocks: BLOCKS,
    snapshot_title: `${spec.name} quickstart`,
    snapshot_url: spec.docsUrl,
  });
}

interface Built {
  tools: PublicToolRow[];
  history: PublicRunHistoryRow[];
  runs: Map<string, PublicRunRow>;
  incidents: PublicIncidentRow[];
}

function build(): Built {
  const tools: PublicToolRow[] = [];
  const history: PublicRunHistoryRow[] = [];
  const runs = new Map<string, PublicRunRow>();

  specs.forEach((spec, toolIndex) => {
    const shown = Math.min(spec.runs, 60);
    for (let i = 0; i < spec.runs; i += 1) {
      const kind = spec.kindAt(i);
      const row = runRow(spec, toolIndex, i, kind);
      runs.set(row.id, row);
      if (i < shown)
        history.push(
          PublicRunHistoryRow.parse({
            run_id: row.id,
            tool_slug: spec.slug,
            started_at: row.started_at,
            outcome: row.outcome,
            kind,
            reached_level: row.reached_level,
            target_level: spec.level,
            stale: row.plan_stale,
            duration_ms: row.duration_ms,
            rn: i + 1,
          }),
        );
    }
    const newest = spec.runs > 0 ? runs.get(runId(toolIndex, 0)) : undefined;
    const lastKind = spec.runs > 0 ? spec.kindAt(0) : null;
    const failing = spec.kindAt(0) === 'fail';
    const streakCount =
      spec.runs === 0
        ? 0
        : (() => {
            let n = 0;
            while (n < spec.runs && spec.kindAt(n) === spec.kindAt(0)) n += 1;
            return n;
          })();
    tools.push(
      PublicToolRow.parse({
        slug: spec.slug,
        name: spec.name,
        docs_url: spec.docsUrl,
        language: spec.language,
        level: spec.level,
        status: spec.status,
        status_since: spec.statusSince,
        last_run_at: newest?.started_at ?? null,
        pass_rate_30d: spec.passRate,
        current_streak: streakCount,
        streak_kind: failing ? 'fail' : 'pass',
        last_run_id: newest?.id ?? null,
        last_outcome: lastKind === null ? null : kindOutcome(lastKind),
        last_reached_level: newest?.reached_level ?? null,
        last_skip_reason: lastKind === 'skipped' ? 'manual_step' : null,
        decided_30d:
          spec.runs === 0 || spec.passRate === null
            ? 0
            : Math.min(spec.runs, spec.slug === FIXTURE_SLUGS.manyRuns ? 100 : spec.runs),
      }),
    );
  });

  const chalkIndex = specs.findIndex((s) => s.slug === FIXTURE_SLUGS.failing);
  const fastifyIndex = specs.findIndex((s) => s.slug === FIXTURE_SLUGS.verifying);
  const resendIndex = specs.findIndex((s) => s.slug === FIXTURE_SLUGS.healthy);
  const incident = (over: Record<string, unknown>) =>
    PublicIncidentRow.parse({
      id: uuid(0x1c1d, 1),
      tool_slug: FIXTURE_SLUGS.failing,
      tool_name: 'Chalk',
      signature: 'sig-chalk-red',
      failure_class: 'API_DRIFT',
      state: 'OPEN',
      review: 'CONFIRMED',
      first_failing_run_id: runId(chalkIndex, 4),
      last_passing_run_id: runId(chalkIndex, 5),
      docs_changed: true,
      docs_diff_path: DIFF_PATHS.chalk,
      summary:
        'Chalk 6.0 removed the chained colour helpers the quickstart still uses. The snippet calls chalk.red(), which no longer exists, so it throws before printing anything.',
      suggested_fix:
        "Import the helper by name (`import { red } from 'chalk'`) or use `chalk.redBright()`, as the updated README does.",
      opened_at: '2026-10-12T08:00:00.000Z',
      confirmed_at: '2026-10-12T10:00:00.000Z',
      resolved_at: null,
      events: [
        { type: 'opened', payload: {}, at: '2026-10-12T08:00:00.000Z' },
        { type: 'confirmed', payload: {}, at: '2026-10-12T10:00:00.000Z' },
      ],
      version_diff: {
        changed: [{ name: 'chalk', from: '5.3.0', to: '6.0.0' }],
        added: [{ name: 'supports-color', version: '9.4.0' }],
        removed: [],
      },
      ...over,
    });
  const incidents: PublicIncidentRow[] = [
    incident({}),
    // an older, resolved, confirmed incident for the incidents page ("time to resolve")
    incident({
      id: uuid(0x1c1d, 2),
      tool_slug: FIXTURE_SLUGS.healthy,
      tool_name: 'Resend (Node.js SDK)',
      signature: 'sig-resend-old',
      failure_class: 'DEPENDENCY_RESOLUTION',
      state: 'RESOLVED',
      first_failing_run_id: runId(resendIndex, 17),
      last_passing_run_id: null,
      docs_changed: false,
      docs_diff_path: null,
      summary:
        'The quickstart pinned a version of the SDK that was yanked from the registry. Installing it failed with a 404.',
      suggested_fix: 'Install the latest version.',
      opened_at: '2026-10-03T06:00:00.000Z',
      confirmed_at: '2026-10-03T09:00:00.000Z',
      resolved_at: '2026-10-03T18:00:00.000Z',
      version_diff: null,
      events: [],
    }),
    // POISON: unreviewed, as if the view had leaked it
    incident({
      id: uuid(0x1c1d, 3),
      tool_slug: FIXTURE_SLUGS.verifying,
      tool_name: 'Fastify',
      signature: UNREVIEWED_CAUSE,
      review: 'PENDING_REVIEW',
      confirmed_at: null,
      first_failing_run_id: runId(fastifyIndex, 1),
      last_passing_run_id: runId(fastifyIndex, 2),
      docs_diff_path: DIFF_PATHS.fastify,
      summary: UNREVIEWED_CAUSE,
      suggested_fix: `Fix: ${UNREVIEWED_CAUSE}`,
      opened_at: '2026-10-16T18:00:00.000Z',
      version_diff: {
        changed: [{ name: 'widget', from: '8.9.0', to: '9.0.0' }],
        added: [],
        removed: [],
      },
      events: [],
    }),
    // POISON: a false positive
    incident({
      id: uuid(0x1c1d, 4),
      tool_slug: FIXTURE_SLUGS.l2,
      tool_name: 'Zod',
      signature: 'sig-zod-fp',
      review: 'FALSE_POSITIVE',
      state: 'RESOLVED',
      resolved_at: '2026-10-08T12:00:00.000Z',
      confirmed_at: null,
      summary: UNREVIEWED_CAUSE,
      suggested_fix: UNREVIEWED_CAUSE,
      opened_at: '2026-10-08T08:00:00.000Z',
      docs_diff_path: null,
      version_diff: null,
      events: [],
    }),
  ];
  return { tools, history, runs, incidents };
}

let cache: Built | null = null;
const data = (): Built => (cache ??= build());

/**
 * Tests can change what the "database" says between requests: QSR_FIXTURE_OVERRIDE names a JSON file
 * `{ "tools": { "<slug>": { ...partial public_tools row } } }` that is read on every call. (Used to prove that
 * /api/revalidate really refreshes a cached page.) Never set in production.
 */
function overrides(): Record<string, Record<string, unknown>> {
  const file = process.env['QSR_FIXTURE_OVERRIDE'];
  if (!file) return {};
  try {
    return (
      (
        JSON.parse(readFileSync(file, 'utf8')) as {
          tools?: Record<string, Record<string, unknown>>;
        }
      ).tools ?? {}
    );
  } catch {
    return {};
  }
}

export class FixtureDataSource implements DataSource {
  async listTools(): Promise<PublicToolRow[]> {
    const over = overrides();
    return data().tools.map((t) =>
      over[t.slug] ? PublicToolRow.parse({ ...t, ...over[t.slug] }) : t,
    );
  }

  async listHistory(limit: number): Promise<PublicRunHistoryRow[]> {
    return data().history.filter((h) => h.rn <= limit);
  }

  async listToolHistory(slug: string, limit: number): Promise<PublicRunHistoryRow[]> {
    return data().history.filter((h) => h.tool_slug === slug && h.rn <= limit);
  }

  async listIncidents(): Promise<PublicIncidentRow[]> {
    return data().incidents;
  }

  async getRun(id: string): Promise<PublicRunRow | null> {
    return data().runs.get(id) ?? null;
  }
}

export type { Behaviour };
