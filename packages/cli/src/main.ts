#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { CrawlError, extract, launchBrowser } from '@qsr/crawler';
import { loadTarget, TargetFileError } from './targets.js';

const USAGE = `qsr - QuickstartRot CLI

Usage:
  qsr crawl <slug> [--json] [--targets <dir>] [--trace-dir <dir>]

Commands (phase that implements them):
  crawl     Crawl one target's docs page and print the extraction   (P2)
  compile   Compile a target's extraction into a Step IR plan       (P3)
  run       Crawl + compile + execute locally, no database          (P4)
  plan | execute | report    Probe pipeline stages                  (P7)
`;

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }, pino.destination(2));

async function crawl(argv: string[]): Promise<number> {
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
    process.stderr.write(`missing <slug>\n\n${USAGE}`);
    return 2;
  }

  const target = await loadTarget(path.resolve(values.targets), slug);
  const browser = await launchBrowser();
  try {
    const extraction = await extract(target, {
      browser,
      log,
      ...(values['trace-dir'] ? { traceDir: path.resolve(values['trace-dir']) } : {}),
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(extraction, null, 2)}\n`);
      return 0;
    }
    const count = (kind: string) => extraction.blocks.filter((b) => b.kind === kind).length;
    process.stdout.write(
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
  } catch (err) {
    if (err instanceof CrawlError) {
      process.stderr.write(
        `CRAWL_ERROR (${err.reason}${err.details.httpStatus ? ` ${err.details.httpStatus}` : ''}): ${err.message}\n`,
      );
      return 1;
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'crawl':
      return crawl(rest);
    case 'compile':
    case 'run':
    case 'plan':
    case 'execute':
    case 'report':
      process.stderr.write(`"${command}" is not implemented yet (see usage)\n\n${USAGE}`);
      return 2;
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof TargetFileError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  } else {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'unexpected error');
    process.exitCode = 1;
  }
}
