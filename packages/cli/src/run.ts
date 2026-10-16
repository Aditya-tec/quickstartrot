import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  compile,
  createFileCache,
  createGroqClient,
  LlmError,
  resolveConfig,
  type LlmClient,
} from '@qsr/compiler';
import { startFixtureServer, type FixtureServer } from '@qsr/crawler';
import type { Extraction, Logger, RunResult, StepIR, Target } from '@qsr/core';
import {
  createDockerCli,
  executePlan,
  persistRunResult,
  scrubbedEnv,
  type DockerClient,
} from '@qsr/executor';
import {
  checkCanary,
  GoldenPlanError,
  isCanarySlug,
  loadCanaryExpectation,
  loadGoldenPlan,
} from './canary.js';
import { crawlOnce, processIo, USAGE, type CliIo } from './commands.js';
import { formatRunResult } from './format-run.js';
import { loadTarget } from './targets.js';

const run = promisify(execFile);
const LOCAL_TAG = { node: 'qsr-node:local', python: 'qsr-python:local' } as const;
const FIXTURE_URL = /^http:\/\/127\.0\.0\.1:(\d+)\//;

export interface RunOverrides {
  llm?: LlmClient;
  docker?: DockerClient;
}

/** Builds docker/<language>.Dockerfile as qsr-<language>:local unless that image already exists. */
async function ensureLocalImage(
  language: Target['language'],
  repoRoot: string,
  docker: DockerClient,
  log: Logger,
): Promise<string> {
  const tag = LOCAL_TAG[language];
  if (await docker.inspectImage(tag)) return tag;
  log.info({ tag }, 'building sandbox image locally');
  await run(
    'docker',
    [
      'build',
      '-q',
      '-f',
      path.join(repoRoot, 'docker', `${language}.Dockerfile`),
      '-t',
      tag,
      path.join(repoRoot, 'docker'),
    ],
    {
      env: scrubbedEnv(process.env),
      timeout: 900_000,
    },
  );
  return tag;
}

/** Everything the executor wrote for this run, as one string, for the canary output check. */
async function collectOutput(result: RunResult, outDir: string): Promise<string> {
  const parts = result.steps.flatMap((s) => [s.stdoutTail ?? '', s.stderrTail ?? '']);
  for (const s of result.steps) {
    if (s.logFile) parts.push(await readFile(path.join(outDir, s.logFile), 'utf8').catch(() => ''));
  }
  return parts.join('\n');
}

/**
 * `qsr run <slug>`: crawl, compile (or load the canary's golden plan), execute in Docker, print the
 * timeline. No database, no API. Exit codes: 0 pass (or a canary that gave its expected answer),
 * 1 fail / rejected plan / canary mismatch, 2 usage, 3 model error, 4 harness error or no Docker.
 */
export async function runCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  overrides: RunOverrides = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'local-images': { type: 'boolean', default: false },
      image: { type: 'string' },
      targets: { type: 'string', default: 'targets' },
      'cache-dir': { type: 'string', default: '.qsr-cache' },
      out: { type: 'string', default: '.qsr-runs' },
    },
  });
  const slug = positionals[0];
  if (!slug) {
    io.stderr(`missing <slug>\n\n${USAGE}`);
    return 2;
  }

  const targetsDir = path.resolve(values.targets);
  const repoRoot = path.resolve(targetsDir, '..');
  const target = await loadTarget(targetsDir, slug);

  const docker = overrides.docker ?? createDockerCli();
  if ((await docker.serverVersion()) === 'unknown') {
    io.stderr(
      'Docker is not reachable. Start Docker Desktop (or the docker daemon) and try again.\n',
    );
    return 4;
  }

  // Canaries are served from fixtures/docs-site on the port named in their docsUrl.
  let fixtures: FixtureServer | undefined;
  const fixturePort = isCanarySlug(slug) ? FIXTURE_URL.exec(target.docsUrl)?.[1] : undefined;
  if (fixturePort) {
    try {
      fixtures = await startFixtureServer(path.join(repoRoot, 'fixtures', 'docs-site'), {
        port: Number(fixturePort),
      });
    } catch (err) {
      io.stderr(
        `Cannot serve the canary fixtures: port ${fixturePort} is already in use (${err instanceof Error ? err.message : String(err)}). Stop whatever is using it and retry.\n`,
      );
      return 4;
    }
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const extraction: Extraction | null = await crawlOnce(target, log, io);
    if (extraction === null) return 1;

    let ir: StepIR | null = null;
    let planId: string | null = null;
    let golden: StepIR | null = null;
    try {
      golden = await loadGoldenPlan(targetsDir, target, extraction);
    } catch (err) {
      if (!(err instanceof GoldenPlanError)) throw err;
      io.stderr(`${err.message}\n`);
      return 4;
    }

    if (golden) {
      ir = golden;
      log.info({ toolSlug: slug }, 'using the committed golden plan');
    } else {
      const model = process.env['QSR_COMPILER_MODEL'];
      const apiKey = process.env['GROQ_API_KEY'];
      const llm: LlmClient =
        overrides.llm ??
        (apiKey
          ? createGroqClient({ apiKey, config: resolveConfig(model ? { model } : {}) })
          : {
              complete: async () => {
                throw new LlmError(
                  'GROQ_API_KEY is not set (put it in .env or the environment)',
                  'rejected',
                );
              },
            });
      try {
        const compiled = await compile(target, extraction, {
          llm,
          cache: createFileCache(path.resolve(values['cache-dir']), log),
          config: resolveConfig(model ? { model } : {}),
          log,
          refresh: values.refresh,
        });
        if (!compiled.plan.accepted || compiled.plan.ir === null) {
          io.stderr(
            `COMPILER_ERROR: the plan was rejected (${compiled.plan.groundingReport.violations.map((v) => `${v.stepId} ${v.rule}`).join(', ')}). Nothing was executed.\n`,
          );
          return 1;
        }
        ir = compiled.plan.ir;
        planId = null; // the database id arrives with phase P6
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        io.stderr(
          `MODEL ERROR (${err.kind}${err.status ? ` ${err.status}` : ''}): ${err.message}\n`,
        );
        return 3;
      }
    }

    const image =
      values.image ??
      (values['local-images']
        ? await ensureLocalImage(target.language, repoRoot, docker, log)
        : target.runtime.image);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const outDir = path.resolve(values.out, `${slug}-${stamp}`);

    const result = await executePlan(
      {
        target,
        ir,
        image,
        outDir,
        cycleId: randomUUID(),
        attempt: 1,
        planId,
        snapshotHash: extraction.contentHash,
      },
      { docker, log, signal: controller.signal },
    );
    const resultFile = await persistRunResult(outDir, result);

    const expected = isCanarySlug(slug) ? await loadCanaryExpectation(targetsDir, slug) : null;
    const canary = expected
      ? {
          expectedOutcome: expected.outcome,
          verdict: checkCanary(result, expected, await collectOutput(result, outDir)),
        }
      : undefined;

    io.stdout(
      values.json
        ? `${JSON.stringify({ result, canary: canary?.verdict ?? null }, null, 2)}\n`
        : formatRunResult({ result, ir, targetLevel: target.level, resultFile, canary }),
    );

    if (result.outcome === 'HARNESS_ERROR') return 4; // ours, even for a canary: not a verdict on anything
    if (canary) return canary.verdict.ok ? 0 : 1;
    return result.outcome === 'PASS' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
    await fixtures?.close();
  }
}
