import { parseArgs } from 'node:util';
import { OPT_OUT, optOutSentences, OptOutResponse, type Logger } from '@qsr/core';
import { adminClientFromEnv } from './admin-client.js';
import type { ApiClient } from './api-client.js';
import { ConfigError, processIo, type CliIo } from './commands.js';

// `qsr opt-out <slug> [--hide-history]` and `qsr hide-history <slug>`: how a person applies a vendor's request (admin token). Probing of the
// tool stops (the API switches it off and a target sync never switches it back on), its page stays up labelled as no longer monitored at the
// vendor's request, and the past results stay visible unless the vendor asked for them to be hidden. What these commands say is
// `optOutSentences()` in @qsr/core, the same words as the site, the vendor form and the docs. Nothing here contacts a vendor.

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
type Api = Pick<ApiClient, 'wakeApi' | 'post'>;

function slugOf(
  argv: string[],
  extra: Record<string, { type: 'boolean' }>,
): { slug: string; hide: boolean } | string {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: extra });
  const slug = positionals[0];
  if (positionals.length !== 1 || slug === undefined || slug.length > 64 || !SLUG.test(slug))
    return 'give exactly one tool slug, for example: qsr opt-out acme-node';
  return { slug, hide: Boolean((values as { 'hide-history'?: boolean })['hide-history']) };
}

function render(r: OptOutResponse): string {
  const s = optOutSentences();
  return [
    `${r.slug}: probing has stopped (opt-out recorded ${r.optedOutAt}).`,
    `Its page now carries the label "${OPT_OUT.pageLabel}".`,
    r.historyHidden
      ? 'Its past results are hidden, at the vendor’s request.'
      : `Its past results stay visible. ${s.history}`,
    '',
  ].join('\n');
}

async function send(
  path: string,
  body: unknown,
  log: Logger,
  io: CliIo,
  api: Api | undefined,
): Promise<number> {
  let client: Api | undefined = api;
  if (!client) {
    try {
      client = adminClientFromEnv();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      io.stderr(`${err.message}\n`);
      return 2;
    }
  }
  try {
    await client.wakeApi();
    io.stdout(render(OptOutResponse.parse(await client.post(path, body))));
    return 0;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'opt-out failed');
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function optOutCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  api?: Api,
): Promise<number> {
  const parsed = slugOf(argv, { 'hide-history': { type: 'boolean' } });
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n`);
    return 2;
  }
  return send(`/admin/tools/${parsed.slug}/opt-out`, { hideHistory: parsed.hide }, log, io, api);
}

export async function hideHistoryCommand(
  argv: string[],
  log: Logger,
  io: CliIo = processIo,
  api?: Api,
): Promise<number> {
  const parsed = slugOf(argv, {});
  if (typeof parsed === 'string') {
    io.stderr(`${parsed.replace('qsr opt-out', 'qsr hide-history')}\n`);
    return 2;
  }
  return send(`/admin/tools/${parsed.slug}/hide-history`, {}, log, io, api);
}
