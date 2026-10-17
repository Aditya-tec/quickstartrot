#!/usr/bin/env node
import pino from 'pino';
import { classifyCommand } from './classify.js';
import { compileCommand, ConfigError, crawlCommand, loadDotEnv, USAGE } from './commands.js';
import { executeCommand } from './probe/execute-command.js';
import {
  gcCommand,
  planCommand,
  reportCommand,
  validateCommand,
} from './probe/pipeline-commands.js';
import { calibrationCommand } from './calibration.js';
import { exportCommand } from './launch-export.js';
import { plansCommand } from './plans-command.js';
import { runCommand } from './run.js';
import { TargetFileError } from './targets.js';

// Structured JSON logs go to stderr; stdout is reserved for results (and --json output).
const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }, pino.destination(2));

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const [command, ...rest] = argv;
  switch (command) {
    case 'crawl':
      return crawlCommand(rest, log);
    case 'compile':
      return compileCommand(rest, log);
    case 'run':
      return runCommand(rest, log);
    case 'classify':
      return classifyCommand(rest, log);
    case 'plan':
      return planCommand(rest, log);
    case 'execute':
      return executeCommand(rest, log);
    case 'report':
      return reportCommand(rest, log);
    case 'gc':
      return gcCommand(rest, log);
    case 'calibration-report':
      return calibrationCommand(rest, log);
    case 'export':
      return exportCommand(rest, log);
    case 'plans':
      return plansCommand(rest, log);
    case 'validate':
      return validateCommand(rest, log);
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof TargetFileError || err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  } else {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'unexpected error');
    process.exitCode = 1;
  }
}
