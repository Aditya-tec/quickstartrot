import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createFileCache } from '@qsr/compiler';
import { extract, launchBrowser } from '@qsr/crawler';
import type { Logger, Target } from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import { extractionFile } from './mutate/inputs.js';
import { botUrlFromEnv, ConfigError, processIo, USAGE, type CliIo } from './commands.js';
import { renderPushResults, runPlansPush } from './plans-push.js';
import { loadAllTargets, loadTarget } from './targets.js';

/** `qsr plans push <slug> | --all`: send locally compiled plans to the API's plan cache (see plans-push.ts). */
export async function plansCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'push') {
    io.stderr(`unknown plans command${sub ? ` "${sub}"` : ''}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'include-disabled': { type: 'boolean', default: false },
      targets: { type: 'string', default: 'targets' },
      'cache-dir': { type: 'string', default: '.qsr-cache' },
    },
  });
  const slug = positionals[0];
  if ((slug === undefined) === !values.all) {
    io.stderr(`give either a <slug> or --all\n\n${USAGE}`);
    return 2;
  }

  const targetsDir = path.resolve(values.targets);
  let targets: Target[];
  if (values.all) {
    const all = await loadAllTargets(targetsDir);
    // a target marked enabled: false is not run in production, so its plan is not wanted there either
    targets = values['include-disabled'] ? all : all.filter((t) => t.enabled !== false);
  } else {
    targets = [await loadTarget(targetsDir, slug as string)];
  }

  let botUrl: string;
  try {
    botUrl = botUrlFromEnv();
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 2;
  }
  let api;
  try {
    api = adminClientFromEnv();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.stderr(`${err.message}\n`);
    return 2;
  }

  const browser = await launchBrowser();
  try {
    const results = await runPlansPush(
      { targets, dryRun: values['dry-run'] },
      {
        api,
        cache: createFileCache(path.resolve(values['cache-dir']), log),
        crawl: (t) => extract(t, { browser, log, botUrl }),
        saveExtraction: async (e, t) => {
          const file = extractionFile(path.resolve(values['cache-dir']), t.slug, e.contentHash);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(e));
        },
        log,
      },
    );
    io.stdout(renderPushResults(results));
    const failed = results.some((r) => r.status === 'rejected' || r.status === 'crawl_failed');
    return failed ? 1 : 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await browser.close();
  }
}
