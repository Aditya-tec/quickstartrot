// pnpm probe:local - the whole probe pipeline on this machine, before anything is deployed:
//   plan -> execute (N shards, real Docker) -> report
// against a LOCAL API (apps/api/dist/server.js) and a LOCAL Postgres (docker-compose.test.yml), with a stand-in
// for Supabase Storage so the log uploads really happen. Nothing here touches Supabase or Render.
//
//   pnpm probe:local                                  4 canaries + 4 real tools, 2 shards, fresh database
//   pnpm probe:local --keep-db                        reuse the database (plans already cached, idempotency)
//   pnpm probe:local --only chalk-node,zod-node       choose the real tools
//   pnpm probe:local --lose-shard 1                   drop shard 1's results before the report
//   pnpm probe:local --budget 1                       a token budget of 1: every compile cache miss is deferred
//   pnpm probe:local --report-twice                   run the report job twice (idempotency)
//   pnpm probe:local --targets <dir>                  use another targets directory
//   pnpm probe:local --seed-plans                     push the plans cached by `qsr run` (.qsr-cache) to the local API with
//                                                     `qsr plans push` first, so the plan job compiles nothing (no model tokens)
//   pnpm probe:local --report-concurrency 1           tools reported at once by `qsr report` (default 4); the time is printed
//
// Run with Node >= 22.6 type stripping (the pnpm script passes the flag).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const run = promisify(execFile);

// ---- options
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, '.probe-local');
const API_PORT = 8787;
const STORAGE_PORT = 54330;
const DB_URL = 'postgres://postgres:postgres@127.0.0.1:54329/qsr_test';
const HMAC_SECRET = 'probe-local-hmac-secret-0123456789abcdef';
const SHARDS = Number(value('shards') ?? '2');
const ONLY = value('only') ?? 'chalk-node,dotenv-python,zod-node,resend-node';
const TARGETS = path.resolve(value('targets') ?? path.join(ROOT, 'targets'));
const LOSE_SHARD = value('lose-shard');
const BUDGET = value('budget');
const REPORT_CONCURRENCY = value('report-concurrency');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');

const say = (text: string): void => console.log(text);
const banner = (text: string): void => say(`\n===== ${text} =====`);

// ---- .env: only the Groq key is taken from it, and only for the API process
async function groqKey(): Promise<string | undefined> {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return undefined;
  const line = (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .find((l) => l.startsWith('GROQ_API_KEY='));
  return (
    line
      ?.slice('GROQ_API_KEY='.length)
      .trim()
      .replace(/^["']|["']$/g, '') || undefined
  );
}

// ---- Postgres (docker compose), through psql so this script needs no dependencies
const compose = (...a: string[]) =>
  run('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.test.yml'), ...a], {
    cwd: ROOT,
    maxBuffer: 1 << 26,
  });
async function psql(sql: string): Promise<string> {
  const child = spawn(
    'docker',
    [
      'compose',
      '-f',
      path.join(ROOT, 'docker-compose.test.yml'),
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'postgres',
      '-d',
      'qsr_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-X',
      '-q',
    ],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  child.stdin.end(sql);
  const code: number = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`psql failed: ${err}`);
  return out;
}

async function resetDatabase(): Promise<void> {
  await compose('up', '-d', '--wait');
  await psql(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;' +
      'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;' +
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;' +
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;',
  );
  const dir = path.join(ROOT, 'packages', 'db', 'drizzle');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await psql(await readFile(path.join(dir, file), 'utf8'));
  }
  say('database: schema rebuilt from every migration');
}

// ---- a stand-in for Supabase Storage (signed uploads), same REST shape the API's client speaks
interface Stored {
  bytes: number;
  text: string;
}
function startStorage(): { server: Server; objects: Map<string, Stored>; signed: string[] } {
  const objects = new Map<string, Stored>();
  const signed: string[] = [];
  const read = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${STORAGE_PORT}`);
      const body = await read(req);
      const sign = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && sign) {
        const [, bucket, objectPath] = sign;
        signed.push(`${bucket}/${decodeURIComponent(objectPath ?? '')}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            url: `/object/upload/sign/${bucket}/${objectPath}?token=T`,
            token: 'T',
          }),
        );
        return;
      }
      if (req.method === 'PUT' && sign && url.searchParams.get('token') === 'T') {
        const [, bucket, objectPath] = sign;
        const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type'] ?? ''))?.[1];
        let payload = body;
        if (boundary) {
          // the file is the multipart part whose field name is empty
          const text = body.toString('latin1');
          const start = text.indexOf('name=""');
          const dataStart = text.indexOf('\r\n\r\n', start) + 4;
          const dataEnd = text.indexOf(`\r\n--${boundary}`, dataStart);
          payload = body.subarray(dataStart, dataEnd);
        }
        let textOut = '';
        try {
          textOut = gunzipSync(payload).toString('utf8');
        } catch {
          textOut = '(not gzip)';
        }
        objects.set(`${bucket}/${decodeURIComponent(objectPath ?? '')}`, {
          bytes: payload.length,
          text: textOut,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Key: `${bucket}/${objectPath}` }));
        return;
      }
      res.writeHead(404).end();
    })();
  });
  return { server, objects, signed };
}

// ---- processes
function startApi(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'api', 'dist', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  child.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
  (child as ChildProcess & { log: string[] }).log = log;
  return child;
}

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up within ${ms / 1000} s`);
}

/** Runs `qsr <args>` and streams its output. `env` is the ONLY environment the child gets besides the basics. */
async function qsr(label: string, cliArgs: string[], env: Record<string, string>): Promise<number> {
  const base: Record<string, string> = {};
  for (const k of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'DOCKER_HOST',
    'ProgramData',
    'ProgramFiles',
    'windir',
    'COMSPEC',
    'PROGRAMFILES(X86)',
    'ProgramW6432',
  ])
    if (process.env[k]) base[k] = process.env[k] as string;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...cliArgs], {
      cwd: ROOT,
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prefix = (d: Buffer): string =>
      d
        .toString()
        .split('\n')
        .filter((l) => l.trim() !== '')
        .filter((l) => !l.startsWith('{"level":30'))
        .map((l) => `  [${label}] ${l}`)
        .join('\n');
    child.stdout.on('data', (d: Buffer) => {
      const t = prefix(d);
      if (t) say(t);
    });
    child.stderr.on('data', (d: Buffer) => {
      const t = prefix(d);
      if (t) say(t);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function show(title: string, sql: string): Promise<void> {
  say(`\n-- ${title}`);
  say(
    (await psql(sql))
      .trimEnd()
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n'),
  );
}

async function main(): Promise<void> {
  say(
    `probe:local  shards=${SHARDS}  only=${ONLY}  targets=${TARGETS}${BUDGET ? `  budget=${BUDGET}` : ''}${LOSE_SHARD ? `  lose-shard=${LOSE_SHARD}` : ''}`,
  );
  await compose('up', '-d', '--wait');
  if (!flag('keep-db')) await resetDatabase();

  const plans = path.join(WORK, 'plans');
  const results = path.join(WORK, 'results');
  await rm(plans, { recursive: true, force: true });
  await rm(results, { recursive: true, force: true });
  await rm(path.join(WORK, 'shards'), { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  const outputFile = path.join(WORK, 'github_output');
  const summaryFile = path.join(WORK, 'github_step_summary');
  await rm(outputFile, { force: true });
  await rm(summaryFile, { force: true });

  const storage = startStorage();
  await new Promise<void>((resolve) => storage.server.listen(STORAGE_PORT, '127.0.0.1', resolve));

  const key = await groqKey();
  const api = startApi({
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    DATABASE_URL: DB_URL,
    INGEST_HMAC_SECRET: HMAC_SECRET,
    ADMIN_TOKEN: 'probe-local-admin-token-0123456789',
    SUBMISSION_IP_SECRET: 'probe-local-ip-secret-0123456789ab',
    SUPABASE_URL: `http://127.0.0.1:${STORAGE_PORT}`,
    SUPABASE_SERVICE_ROLE_KEY: 'local-fake-service-role-key',
    LOG_LEVEL: 'warn',
    ...(key ? { GROQ_API_KEY: key } : {}),
    ...(BUDGET ? { GROQ_DAILY_TOKEN_BUDGET: BUDGET } : {}),
  });
  try {
    await waitFor(`http://127.0.0.1:${API_PORT}/health`, 30_000);
    say(
      `api: up on :${API_PORT}${key ? ' (Groq key present)' : ' (NO Groq key: compile misses will be deferred)'}`,
    );

    const runId = String(Math.floor(Date.now() / 1000));
    const github = {
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a1b2c3d4e5f6a7b8',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    };
    const apiEnv = {
      API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
      INGEST_HMAC_SECRET: HMAC_SECRET,
    };

    // ---- optional: the plans verified with `qsr run` go into the API's plan cache the way production will do it
    if (flag('seed-plans')) {
      banner('plans push (qsr plans push, Bearer ADMIN_TOKEN)');
      for (const slug of ONLY.split(',')) {
        const code = await qsr('push', ['plans', 'push', slug, '--targets', TARGETS], {
          API_BASE_URL: apiEnv.API_BASE_URL,
          ADMIN_TOKEN: 'probe-local-admin-token-0123456789',
        });
        if (code !== 0) say(`  [push] ${slug} exited ${code}`);
      }
    }

    // ---- plan job (has the API settings)
    banner('plan');
    const planCode = await qsr(
      'plan',
      ['plan', '--out', plans, '--shards', String(SHARDS), '--only', ONLY, '--targets', TARGETS],
      { ...apiEnv, ...github },
    );
    if (planCode !== 0) throw new Error(`plan exited ${planCode}`);
    const output = await readFile(outputFile, 'utf8');
    const cycle = /^cycle=(.+)$/m.exec(output)?.[1];
    const shards = JSON.parse(/^shards=(.+)$/m.exec(output)?.[1] ?? '[]') as number[];
    say(`outputs: cycle=${cycle} shards=${JSON.stringify(shards)}`);
    say(await readFile(summaryFile, 'utf8'));

    // ---- execute jobs (NO API settings, NO secrets: the child environment has neither)
    banner(`execute (${shards.length} shards in parallel, each with an empty environment)`);
    await Promise.all(
      shards.map(async (shard) => {
        const out = path.join(WORK, 'shards', `results-${shard}`);
        const code = await qsr(
          `shard ${shard}`,
          ['execute', '--plans', plans, '--shard', String(shard), '--out', out],
          {},
        );
        if (code !== 0) say(`  [shard ${shard}] exited ${code}`);
      }),
    );
    // what actions/download-artifact with merge-multiple does
    await mkdir(results, { recursive: true });
    for (const shard of shards) {
      if (String(shard) === LOSE_SHARD) {
        say(`(--lose-shard: the results of shard ${shard} are dropped before the report)`);
        continue;
      }
      const from = path.join(WORK, 'shards', `results-${shard}`);
      if (existsSync(from)) await cp(from, results, { recursive: true });
    }
    say(
      `results/ now holds ${(await readdir(results)).filter((f) => f.endsWith('.json')).length} result files`,
    );

    // ---- report job (has the API settings)
    for (let pass = 1; pass <= (flag('report-twice') ? 2 : 1); pass++) {
      banner(`report${flag('report-twice') ? ` (pass ${pass} of 2)` : ''}`);
      await rm(summaryFile, { force: true });
      const started = Date.now();
      const code = await qsr(
        'report',
        [
          'report',
          '--results',
          results,
          '--plans',
          plans,
          '--cycle',
          cycle ?? '',
          ...(REPORT_CONCURRENCY ? ['--concurrency', REPORT_CONCURRENCY] : []),
        ],
        { ...apiEnv, ...github },
      );
      if (code !== 0) throw new Error(`report exited ${code}`);
      say(
        `report took ${((Date.now() - started) / 1000).toFixed(1)} s (concurrency ${REPORT_CONCURRENCY ?? '4, the default'})`,
      );
      say(await readFile(summaryFile, 'utf8'));
    }

    // ---- what the database holds
    banner('database');
    const id = cycle ?? '';
    await show(
      'probe_cycles',
      `select id, trigger, valid, canary_ok, (finished_at is not null) as finished from probe_cycles where id = '${id}';`,
    );
    await show(
      'runs of this cycle',
      `select t.slug, r.attempt, r.outcome, coalesce(r.failure_class::text,'') as class, r.reached_level as lvl, r.duration_ms as ms, coalesce(r.runner_env->>'plan_stale','') as stale, coalesce(r.runner_env->>'shard','') as shard from runs r join tools t on t.id = r.tool_id where r.cycle_id = '${id}' order by t.slug, r.attempt;`,
    );
    await show(
      'step_results',
      `select count(*) as steps, count(sr.log_path) as with_log_path from step_results sr join runs r on r.id = sr.run_id where r.cycle_id = '${id}';`,
    );
    await show(
      'duplicates (must be none)',
      `select tool_id, attempt, count(*) from runs where cycle_id = '${id}' group by 1,2 having count(*) > 1;`,
    );
    await show(
      'tool states (real tools)',
      `select slug, status, consecutive_failures as fails, consecutive_passes as passes, last_run_at is not null as ran from tools where not is_canary order by slug;`,
    );
    await show(
      'admin queue',
      `select reason, (select slug from tools where id = tool_id) as tool, state from admin_queue_items where cycle_id = '${id}' order by reason;`,
    );

    banner('log uploads (stand-in for Supabase Storage)');
    say(
      `signed upload URLs requested: ${storage.signed.length} (distinct paths: ${new Set(storage.signed).size})`,
    );
    say(`objects stored: ${storage.objects.size}`);
    const sample = [...storage.objects.entries()].find(([, o]) => o.text.length > 40);
    if (sample)
      say(
        `sample  ${sample[0]}\n        ${sample[1].bytes} bytes gzipped, begins: ${JSON.stringify(sample[1].text.slice(0, 90))}`,
      );
    await mkdir(path.join(WORK, 'storage'), { recursive: true });
    await writeFile(
      path.join(WORK, 'storage', 'objects.json'),
      JSON.stringify([...storage.objects.keys()], null, 2),
    );
  } finally {
    api.kill();
    storage.server.close();
  }
}

main().catch((err: unknown) => {
  console.error(`probe:local failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
