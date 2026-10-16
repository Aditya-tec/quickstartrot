import path from 'node:path';
import { parseArgs } from 'node:util';
import { startFixtureServer } from '@qsr/crawler';
import type { Logger } from '@qsr/core';
import { createDockerCli, executePlan } from '@qsr/executor';
import { processIo, type CliIo } from '../commands.js';
import { HarnessCrash, localClassify, runExecute, type ExecuteDeps } from './execute.js';

// `qsr execute --plans plans/ --shard N --out results/`. This is the command of the job that runs docs
// code, so it is kept apart: it imports nothing that talks to the API and reads no setting of it.

/** The port the canary fixture pages are served on (their target files name it). */
const FIXTURE_PORT = 4177;

export async function executeCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  overrides: Partial<ExecuteDeps> = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      plans: { type: 'string', default: 'plans' },
      shard: { type: 'string' },
      out: { type: 'string', default: 'results' },
    },
  });
  const shard = values.shard === undefined ? NaN : Number(values.shard);
  if (!Number.isInteger(shard) || shard < 0) {
    io.stderr('--shard <n> is required and must be a whole number\n');
    return 2;
  }
  try {
    const outcome = await runExecute(
      { plans: path.resolve(values.plans), shard, out: path.resolve(values.out) },
      {
        docker: createDockerCli(),
        log,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        executePlan,
        classify: localClassify,
        startFixtures: () =>
          startFixtureServer(path.resolve('fixtures', 'docs-site'), { port: FIXTURE_PORT }),
        ...overrides,
      },
    );
    io.stdout(
      `shard ${shard}: ${outcome.ran} tools run, ${outcome.harnessErrors} harness errors\n`,
    );
    return 0;
  } catch (err) {
    // A vendor failure is a result and never reaches here; this is the harness itself failing.
    io.stderr(`execute failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof HarnessCrash ? 4 : 1;
  }
}
