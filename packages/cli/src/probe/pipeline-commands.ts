import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CrawlError, extract, launchBrowser, startFixtureServer } from '@qsr/crawler';
import {
  redact,
  validateSubmissionUrl,
  type Extraction,
  type Logger,
  type Target,
} from '@qsr/core';
import { ApiError, createApiClient, type ApiClient } from '../api-client.js';
import { botUrlFromEnv, processIo, type CliIo } from '../commands.js';
import { GoldenPlanError, loadGoldenPlan } from '../canary.js';
import { isCanarySlug } from '../canary.js';
import { parseTargetFile, TargetFileError } from '../targets.js';
import { createLimiter, domainOf } from './crawl-pool.js';
import { reportHarnessProblem } from './github.js';
import { runPlan, CRAWL_CONCURRENCY, type PlanDeps } from './plan.js';
import { runReport, ReportError } from './report.js';
import { readdir } from 'node:fs/promises';

// The thin layer between GitHub Actions (environment variables, $GITHUB_OUTPUT, $GITHUB_STEP_SUMMARY) and
// the tested pipeline functions: plan, report, gc and validate. `execute` has its own file because it must
// not be able to see any of this (no API client, no secrets).

type Env = NodeJS.ProcessEnv;
type ApiLike = Pick<ApiClient, 'wakeApi' | 'post'>;

export function triggerFor(event: string | undefined): 'cron' | 'manual' | 'target_pr' {
  if (event === 'schedule') return 'cron';
  if (event === 'pull_request') return 'target_pr';
  return 'manual';
}

/** API_BASE_URL and INGEST_HMAC_SECRET, or the NAMES of the ones that are missing (never a value). */
function apiSettings(env: Env): { baseUrl: string; secret: string } | { missing: string[] } {
  const missing = ['API_BASE_URL', 'INGEST_HMAC_SECRET'].filter((k) => !env[k]);
  return missing.length > 0
    ? { missing }
    : { baseUrl: env['API_BASE_URL'] as string, secret: env['INGEST_HMAC_SECRET'] as string };
}

const missingMessage = (names: string[]): string =>
  `${names.join(' and ')} must be set (the plan and report jobs get them from the repository's variables and secrets)\n`;

/** Appends to a file named by an environment variable ($GITHUB_OUTPUT), else prints. */
function appender(env: Env, variable: string, io: CliIo): (text: string) => Promise<void> {
  const file = env[variable];
  return async (text) => {
    if (file) await appendFile(file, text);
    else io.stdout(text);
  };
}

const splitSlugs = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

// ---- qsr plan

export interface PlanCommandOverrides {
  api?: ApiLike;
  crawl?: PlanDeps['crawl'];
  goldenPlan?: PlanDeps['goldenPlan'];
}

export async function planCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  env: Env = process.env,
  overrides: PlanCommandOverrides = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      out: { type: 'string', default: 'plans' },
      shards: { type: 'string' },
      only: { type: 'string', default: '' },
      targets: { type: 'string', default: 'targets' },
    },
  });
  const shards = values.shards === undefined ? undefined : Number(values.shards);
  if (shards !== undefined && (!Number.isInteger(shards) || shards < 1)) {
    io.stderr('--shards must be a positive whole number\n');
    return 2;
  }
  const settings = apiSettings(env);
  if ('missing' in settings && !overrides.api) {
    io.stderr(missingMessage(settings.missing));
    return 2;
  }

  let botUrl: string;
  try {
    botUrl = botUrlFromEnv(env);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 2;
  }

  const targetsDir = path.resolve(values.targets);
  let all: Target[];
  try {
    all = await loadEveryTarget(targetsDir);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const real = all.filter((t) => !isCanarySlug(t.slug));
  const canaries = all.filter((t) => isCanarySlug(t.slug));

  const api: ApiLike =
    overrides.api ??
    createApiClient({
      baseUrl: (settings as { baseUrl: string }).baseUrl,
      secret: (settings as { secret: string }).secret,
    });

  // The fixture server and the browser exist only when the real crawler is used.
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  let fixtures: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
  try {
    let crawl = overrides.crawl;
    if (!crawl) {
      const port = canaries
        .map((c) => /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(c.docsUrl)?.[1])
        .find((p) => p !== undefined);
      if (port)
        fixtures = await startFixtureServer(path.resolve('fixtures', 'docs-site'), {
          port: Number(port),
        });
      browser = await launchBrowser();
      const b = browser;
      crawl = (t) => extract(t, { browser: b, log, botUrl });
    }
    const writeOutput = appender(env, 'GITHUB_OUTPUT', io);
    const writeSummary = appender(env, 'GITHUB_STEP_SUMMARY', io);
    const result = await runPlan(
      {
        out: path.resolve(values.out),
        only: splitSlugs(values.only),
        ...(shards === undefined ? {} : { shards }),
        trigger: triggerFor(env['GITHUB_EVENT_NAME']),
        gitSha: env['GITHUB_SHA'] ?? 'local-dev',
        ...(env['GITHUB_RUN_ID'] ? { ghRunId: Number(env['GITHUB_RUN_ID']) } : {}),
        ghRunAttempt: Number(env['GITHUB_RUN_ATTEMPT'] ?? '1') || 1,
      },
      {
        api,
        targets: { real, canaries },
        crawl,
        goldenPlan:
          overrides.goldenPlan ?? ((t, extraction) => loadGoldenPlan(targetsDir, t, extraction)),
        log,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        writeOutput: (name, value) => writeOutput(`${name}=${value}\n`),
        writeSummary: (md) => writeSummary(`${md}\n`),
      },
    );
    io.stdout(`planned cycle ${result.cycleId} in ${result.shards} shard(s)\n`);
    return 0;
  } catch (err) {
    io.stderr(`plan failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await browser?.close();
    await fixtures?.close();
  }
}

async function loadEveryTarget(targetsDir: string): Promise<Target[]> {
  const { targets, errors } = await parseTargetsDir(targetsDir);
  if (errors.length > 0) throw new TargetFileError(errors.join('\n'));
  return targets;
}

/** Parses every YAML in targets/ and targets/_canary/, collecting every error instead of stopping at the first. */
async function parseTargetsDir(
  targetsDir: string,
): Promise<{ targets: Target[]; errors: string[] }> {
  const targets: Target[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const dir of [targetsDir, path.join(targetsDir, '_canary')]) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.yaml'))
      .sort();
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const t = await parseTargetFile(file);
        const earlier = seen.get(t.slug);
        if (earlier) {
          errors.push(`${file}: slug "${t.slug}" is already used by ${earlier}`);
          continue;
        }
        // A canary is served from the local fixture server; any other page must be a public https URL, so a
        // pull request cannot point the crawler at an address inside the runner's network.
        const url = dir === targetsDir ? validateSubmissionUrl(t.docsUrl) : { ok: true as const };
        if (!url.ok) {
          errors.push(`${file}: docsUrl is not allowed: ${url.reason}`);
          continue;
        }
        const keyLike = Object.entries(t.placeholders).find(([, v]) => redact(v) !== v);
        if (keyLike) {
          errors.push(
            `${file}: placeholder ${keyLike[0]} looks like a real credential or an IP address; use an obvious dummy value`,
          );
          continue;
        }
        seen.set(t.slug, file);
        targets.push(t);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { targets, errors };
}

// ---- qsr report

export interface ReportCommandOverrides {
  api?: ApiLike;
  fetch?: typeof fetch;
}

export async function reportCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  env: Env = process.env,
  overrides: ReportCommandOverrides = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      results: { type: 'string', default: 'results' },
      plans: { type: 'string', default: 'plans' },
      cycle: { type: 'string' },
    },
  });
  if (!values.cycle) {
    io.stderr('missing --cycle <id>\n');
    return 2;
  }
  const settings = apiSettings(env);
  if ('missing' in settings && !overrides.api) {
    io.stderr(missingMessage(settings.missing));
    return 2;
  }
  const api: ApiLike =
    overrides.api ??
    createApiClient({
      baseUrl: (settings as { baseUrl: string }).baseUrl,
      secret: (settings as { secret: string }).secret,
    });
  const doFetch = overrides.fetch ?? fetch;
  const token = env['GITHUB_TOKEN'];
  const repository = env['GITHUB_REPOSITORY'];
  const runUrl =
    env['GITHUB_SERVER_URL'] && repository && env['GITHUB_RUN_ID']
      ? `${env['GITHUB_SERVER_URL']}/${repository}/actions/runs/${env['GITHUB_RUN_ID']}`
      : null;
  const writeSummary = appender(env, 'GITHUB_STEP_SUMMARY', io);
  try {
    const outcome = await runReport(
      {
        results: path.resolve(values.results),
        plans: path.resolve(values.plans),
        cycleId: values.cycle,
        webBaseUrl: env['WEB_BASE_URL'] || null,
        anonKey: env['SUPABASE_ANON_KEY'] || null,
        runUrl,
      },
      {
        api,
        fetch: doFetch,
        github:
          token && repository
            ? (problem) => reportHarnessProblem({ fetch: doFetch, token, repository, ...problem })
            : null,
        writeSummary: (md) => writeSummary(`${md}\n`),
        log,
      },
    );
    io.stdout(
      `cycle ${values.cycle}: ${outcome.finish.valid ? 'valid' : 'INVALID'}, ${outcome.rows.length} tools reported\n`,
    );
    return 0;
  } catch (err) {
    io.stderr(
      `report failed: ${err instanceof ReportError || err instanceof ApiError || err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

// ---- qsr gc

export async function gcCommand(
  argv: string[],
  _log: Logger,
  io: CliIo = processIo,
  env: Env = process.env,
  overrides: { api?: ApiLike } = {},
): Promise<number> {
  parseArgs({ args: argv, allowPositionals: false, options: {} });
  const settings = apiSettings(env);
  if ('missing' in settings && !overrides.api) {
    io.stderr(missingMessage(settings.missing));
    return 2;
  }
  const api: ApiLike =
    overrides.api ??
    createApiClient({
      baseUrl: (settings as { baseUrl: string }).baseUrl,
      secret: (settings as { secret: string }).secret,
    });
  try {
    await api.wakeApi();
    const r = (await api.post('/admin/gc', {})) as {
      deletedLogs: number;
      deletedDiffs: number;
      deletedTraces: number;
    };
    io.stdout(
      `deleted ${r.deletedLogs} logs, ${r.deletedDiffs} docs diffs, ${r.deletedTraces} traces\n`,
    );
    return 0;
  } catch (err) {
    io.stderr(`gc failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- qsr validate

export async function validateCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  overrides: { crawl?: (t: Target) => Promise<Extraction> } = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      targets: { type: 'string', default: 'targets' },
      crawl: { type: 'boolean', default: false },
      only: { type: 'string', default: '' },
    },
  });
  let botUrl: string | null = null;
  if (values.crawl) {
    try {
      botUrl = botUrlFromEnv();
    } catch (err) {
      io.stderr(`${(err as Error).message}\n`);
      return 2;
    }
  }
  const { targets, errors } = await parseTargetsDir(path.resolve(values.targets));
  if (errors.length > 0) {
    for (const e of errors) io.stderr(`${e}\n`);
    io.stderr(`${errors.length} invalid target file(s)\n`);
    return 1;
  }
  const only = splitSlugs(values.only);
  const unknown = only.filter((s) => !targets.some((t) => t.slug === s));
  if (unknown.length > 0) {
    io.stderr(`no target file for: ${unknown.join(', ')}\n`);
    return 1;
  }
  io.stdout(`${targets.length} targets valid\n`);
  if (!values.crawl) return 0;

  // Dry run: crawl each page once (robots.txt respected, one request per domain at a time), compile nothing.
  const selected = targets.filter((t) =>
    only.length > 0 ? only.includes(t.slug) : !isCanarySlug(t.slug),
  );
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    let crawl = overrides.crawl;
    if (!crawl) {
      browser = await launchBrowser();
      const b = browser;
      crawl = (t) => extract(t, { browser: b, log, ...(botUrl ? { botUrl } : {}) });
    }
    const run = createLimiter(CRAWL_CONCURRENCY);
    const doCrawl = crawl;
    const outcomes = await Promise.all(
      selected.map((t) =>
        run(domainOf(t.docsUrl), async () => {
          try {
            const e = await doCrawl(t);
            const codeBlocks = e.blocks.filter((b) => b.kind === 'code').length;
            return {
              slug: t.slug,
              ok: true as const,
              text: `${t.slug}: ${codeBlocks} code blocks (hash ${e.contentHash.slice(0, 12)})`,
            };
          } catch (err) {
            const why = err instanceof CrawlError ? `${err.reason}: ${err.message}` : String(err);
            return { slug: t.slug, ok: false as const, text: `${t.slug}: CRAWL_ERROR ${why}` };
          }
        }),
      ),
    );
    for (const o of outcomes) (o.ok ? io.stdout : io.stderr)(`${o.text}\n`);
    return outcomes.every((o) => o.ok) ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

export { GoldenPlanError };
