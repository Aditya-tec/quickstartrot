import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Extraction, Logger, Target } from '@qsr/core';
import {
  compile,
  createFileCache,
  createGroqClient,
  LlmError,
  resolveConfig,
  type LlmClient,
  type PlanCache,
} from '@qsr/compiler';
import { CrawlError, extract, launchBrowser } from '@qsr/crawler';
import { formatCompileResult } from './format.js';
import { loadTarget } from './targets.js';

export const USAGE = `qsr - QuickstartRot CLI

Usage:
  qsr crawl   <slug> [--json] [--targets <dir>] [--trace-dir <dir>]
  qsr compile <slug> [--json] [--refresh] [--targets <dir>] [--cache-dir <dir>]
  qsr run     <slug> [--json] [--refresh] [--local-images | --image <ref>] [--out <dir>] [--targets <dir>]
  qsr classify <run-result.json> [--json] [--llm] [--targets <dir>]
  qsr plan     [--out plans] [--shards N] [--only a,b] [--targets <dir>]
  qsr execute  --shard N [--plans plans] [--out results]
  qsr report   --cycle <id> [--results results] [--plans plans]
  qsr gc
  qsr validate [--targets <dir>] [--only a,b] [--crawl]

Commands (phase that implements them):
  crawl     Crawl one target's docs page and print the extraction            (P2)
  compile   Crawl, then compile into a grounded Step IR plan (cached)        (P3)
  run       Crawl + compile + execute in Docker locally, no database         (P4)
  classify  Classify a stored RunResult: class, rule id, signature, evidence  (P5)
  plan      Probe pipeline: sync, crawl, compile, shard (plan job)             (P7)
  execute   Probe pipeline: run one shard in Docker (execute job, no secrets)  (P7)
  report    Probe pipeline: upload logs, post runs, finish the cycle           (P7)
  gc        Ask the API to delete expired logs, diffs and traces               (P7)
  validate  Check every target file; --crawl does a dry-run crawl              (P7)

Environment (a .env file in the working directory is loaded):
  GROQ_API_KEY         needed only when a plan is not already cached
  QSR_COMPILER_MODEL   overrides the model name (default in packages/compiler/src/config.ts)

Exit codes: 0 ok, 1 crawl failed or the plan was rejected, 2 usage or invalid target,
            3 the model was unreachable or refused the request,
            4 harness error or Docker not reachable (qsr run),
            5 the run was skipped: a person has to act (a manual step before the target level).
`;

/** Loads ./.env into process.env without overriding variables that are already set. */
export function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const processIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

export async function crawlCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      targets: { type: 'string', default: 'targets' },
      'trace-dir': { type: 'string' },
    },
  });
  const slug = positionals[0];
  if (!slug) {
    io.stderr(`missing <slug>\n\n${USAGE}`);
    return 2;
  }
  const target = await loadTarget(path.resolve(values.targets), slug);
  const extraction = await crawlOnce(target, log, io, values['trace-dir']);
  if (extraction === null) return 1;

  if (values.json) {
    io.stdout(`${JSON.stringify(extraction, null, 2)}\n`);
    return 0;
  }
  const count = (kind: string) => extraction.blocks.filter((b) => b.kind === kind).length;
  io.stdout(
    [
      `title:        ${extraction.title}`,
      `final url:    ${extraction.finalUrl}${extraction.finalUrl === extraction.url ? '' : '  (redirected)'}`,
      `content hash: ${extraction.contentHash}`,
      `blocks:       ${count('code')} code, ${count('prose')} prose, ${count('heading')} heading`,
      '',
      ...extraction.blocks
        .filter((b) => b.kind === 'code')
        .map((b) => {
          const first = b.text.split('\n')[0] ?? '';
          const head = `#${b.index} [${b.lang ?? '-'}${b.filenameHint ? ` ${b.filenameHint}` : ''}]`;
          return `${head} ${first.length > 90 ? `${first.slice(0, 87)}...` : first}`;
        }),
      '',
    ].join('\n'),
  );
  return 0;
}

/** Crawls with a fresh browser; reports a CrawlError on stderr and returns null. */
export async function crawlOnce(
  target: Target,
  log: Logger,
  io: CliIo,
  traceDir?: string,
): Promise<Extraction | null> {
  const browser = await launchBrowser();
  try {
    return await extract(target, {
      browser,
      log,
      ...(traceDir ? { traceDir: path.resolve(traceDir) } : {}),
    });
  } catch (err) {
    if (!(err instanceof CrawlError)) throw err;
    const status = err.details.httpStatus ? ` ${err.details.httpStatus}` : '';
    io.stderr(`CRAWL_ERROR (${err.reason}${status}): ${err.message}\n`);
    return null;
  } finally {
    await browser.close();
  }
}

export interface CompileOptions {
  llm: LlmClient;
  cache: PlanCache;
  log: Logger;
  json: boolean;
  refresh: boolean;
  model?: string | undefined;
}

/** Compile an already-crawled page and print the result. Separate from crawling so it is testable. */
export async function compileExtraction(
  target: Target,
  extraction: Extraction,
  options: CompileOptions,
  io: CliIo = processIo,
): Promise<number> {
  const config = resolveConfig(options.model ? { model: options.model } : {});
  try {
    const result = await compile(target, extraction, {
      llm: options.llm,
      cache: options.cache,
      log: options.log,
      config,
      refresh: options.refresh,
    });
    io.stdout(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatCompileResult(target.slug, result, target.level),
    );
    return result.plan.accepted ? 0 : 1;
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    io.stderr(`MODEL ERROR (${err.kind}${err.status ? ` ${err.status}` : ''}): ${err.message}\n`);
    return 3;
  }
}

export async function compileCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  overrides: { llm?: LlmClient } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      targets: { type: 'string', default: 'targets' },
      'cache-dir': { type: 'string', default: '.qsr-cache' },
    },
  });
  const slug = positionals[0];
  if (!slug) {
    io.stderr(`missing <slug>\n\n${USAGE}`);
    return 2;
  }
  const target = await loadTarget(path.resolve(values.targets), slug);
  const extraction = await crawlOnce(target, log, io);
  if (extraction === null) return 1;

  const model = process.env['QSR_COMPILER_MODEL'];
  const apiKey = process.env['GROQ_API_KEY'];
  // The key is only needed on a cache miss, so a missing key must not block a cache hit.
  const llm: LlmClient = overrides.llm
    ? overrides.llm
    : apiKey
      ? createGroqClient({ apiKey, config: resolveConfig(model ? { model } : {}) })
      : {
          complete: async () => {
            throw new LlmError(
              'GROQ_API_KEY is not set (put it in .env or the environment)',
              'rejected',
            );
          },
        };

  return compileExtraction(
    target,
    extraction,
    {
      llm,
      cache: createFileCache(path.resolve(values['cache-dir']), log),
      log,
      json: values.json,
      refresh: values.refresh,
      model,
    },
    io,
  );
}
