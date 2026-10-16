import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../commands.js';
import {
  gcCommand,
  planCommand,
  reportCommand,
  validateCommand,
  triggerFor,
} from './pipeline-commands.js';
import {
  CYCLE,
  cycleTool,
  extractionFor,
  fakeApi,
  ir,
  silent,
  target,
} from './probe.test-utils.js';

// The thin layer between GitHub Actions (environment variables, $GITHUB_OUTPUT, $GITHUB_STEP_SUMMARY) and
// the tested pipeline functions.

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) };
  return { handle, out: () => out.join(''), err: () => err.join('') };
}

const yamlFor = (
  slug: string,
  extra = '',
  docsUrl = `https://docs.${slug}.dev/quickstart`,
) => `slug: ${slug}
name: ${slug} (test)
docsUrl: ${docsUrl}
language: node
level: 2
runtime:
  image: ghcr.io/aditya-tec/qsr-node:22
extract:
  root: "main"
${extra}`;

let dir: string;
let targets: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-pipeline-'));
  targets = path.join(dir, 'targets');
  await mkdir(path.join(targets, '_canary'), { recursive: true });
});

const baseEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  API_BASE_URL: 'https://api.test',
  INGEST_HMAC_SECRET: 'test-secret-0123456789abcdef',
  ...over,
});

describe('triggerFor', () => {
  it.each([
    ['schedule', 'cron'],
    ['workflow_dispatch', 'manual'],
    ['pull_request', 'target_pr'],
    [undefined, 'manual'],
    ['push', 'manual'],
  ])('%s -> %s', (event, trigger) => {
    expect(triggerFor(event)).toBe(trigger);
  });
});

describe('qsr plan', () => {
  it('needs the API settings and says which are missing, never their values', async () => {
    const c = io();
    const code = await planCommand(['--out', path.join(dir, 'plans')], silent, c.handle, {});
    expect(code).toBe(2);
    expect(c.err()).toContain('API_BASE_URL');
    expect(c.err()).toContain('INGEST_HMAC_SECRET');
  });

  it('plans, writes the files, and prints shards and cycle to $GITHUB_OUTPUT and the summary file', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    await writeFile(
      path.join(targets, '_canary', 'canary-pass-node.yaml'),
      yamlFor('canary-pass-node', '', 'http://127.0.0.1:4177/canary/pass-node.html'),
    );
    const outputFile = path.join(dir, 'github_output');
    const summaryFile = path.join(dir, 'github_summary');
    const acme = target('acme-node');
    const canary = target('canary-pass-node');
    const fake = fakeApi({ tools: [cycleTool(acme), cycleTool(canary)] });
    const c = io();
    const code = await planCommand(
      ['--out', path.join(dir, 'plans'), '--targets', targets, '--only', 'acme-node'],
      silent,
      c.handle,
      baseEnv({
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_RUN_ID: '777',
        GITHUB_RUN_ATTEMPT: '3',
        GITHUB_SHA: 'deadbeefcafe',
        GITHUB_EVENT_NAME: 'schedule',
      }),
      {
        api: fake.api,
        crawl: async (t) => extractionFor(t),
        goldenPlan: async () => ir('canary'),
      },
    );
    expect(code).toBe(0);
    const output = await readFile(outputFile, 'utf8');
    expect(output).toContain(`cycle=${CYCLE}`);
    expect(output).toMatch(/^shards=\[0\]$/m);
    expect(await readFile(summaryFile, 'utf8')).toContain('Probe plan');
    expect(fake.calls.find((x) => x.path === '/internal/cycles')?.body).toEqual({
      trigger: 'cron',
      gitSha: 'deadbeefcafe',
      ghRunId: 777,
      ghRunAttempt: 3,
    });
    expect(await readFile(path.join(dir, 'plans', 'manifest.json'), 'utf8')).toContain(CYCLE);
  });

  it('an empty --only (what the workflow passes when no input was given) means every tool', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    const acme = target('acme-node');
    const fake = fakeApi({ tools: [cycleTool(acme)] });
    const code = await planCommand(
      ['--out', path.join(dir, 'plans'), '--targets', targets, '--only', ''],
      silent,
      io().handle,
      baseEnv(),
      { api: fake.api, crawl: async (t) => extractionFor(t), goldenPlan: async () => null },
    );
    expect(code).toBe(0);
    expect(fake.calls.filter((x) => x.path === '/internal/compile')).toHaveLength(1);
  });

  it('an invalid target file is a usage error before anything is sent', async () => {
    await writeFile(path.join(targets, 'broken.yaml'), 'slug: broken\n');
    const fake = fakeApi();
    const c = io();
    const code = await planCommand(
      ['--out', path.join(dir, 'p'), '--targets', targets],
      silent,
      c.handle,
      baseEnv(),
      {
        api: fake.api,
        crawl: async (t) => extractionFor(t),
      },
    );
    expect(code).toBe(2);
    expect(fake.calls).toHaveLength(0);
    expect(c.err()).toContain('broken.yaml');
  });

  it('--shards must be a positive whole number', async () => {
    const c = io();
    const code = await planCommand(
      ['--out', path.join(dir, 'p'), '--shards', 'many'],
      silent,
      c.handle,
      baseEnv(),
    );
    expect(code).toBe(2);
    expect(c.err()).toMatch(/--shards/);
  });

  it('prints the outputs to stdout when it is not running in GitHub Actions', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    const fake = fakeApi({ tools: [cycleTool(target('acme-node'))] });
    const c = io();
    await planCommand(
      ['--out', path.join(dir, 'p'), '--targets', targets],
      silent,
      c.handle,
      baseEnv(),
      {
        api: fake.api,
        crawl: async (t) => extractionFor(t),
      },
    );
    expect(c.out()).toContain(`cycle=${CYCLE}`);
  });
});

describe('qsr report', () => {
  it('needs --cycle and the API settings', async () => {
    const c = io();
    expect(await reportCommand(['--results', dir], silent, c.handle, baseEnv())).toBe(2);
    expect(c.err()).toMatch(/--cycle/);
    const d = io();
    expect(await reportCommand(['--results', dir, '--cycle', CYCLE], silent, d.handle, {})).toBe(2);
    expect(d.err()).toContain('API_BASE_URL');
  });

  it('exits non-zero when the report itself could not complete (plans missing)', async () => {
    const c = io();
    const code = await reportCommand(
      ['--results', dir, '--plans', path.join(dir, 'nope'), '--cycle', CYCLE],
      silent,
      c.handle,
      baseEnv(),
      { api: fakeApi().api },
    );
    expect(code).toBe(1);
    expect(c.err()).toMatch(/plan manifest/);
  });
});

describe('qsr gc', () => {
  it('posts a signed /admin/gc and prints what was deleted', async () => {
    const calls: string[] = [];
    const api = {
      wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
      post: (async (p: string) => {
        calls.push(p);
        return { deletedLogs: 3, deletedDiffs: 1, deletedTraces: 0 };
      }) as never,
    };
    const c = io();
    expect(await gcCommand([], silent, c.handle, baseEnv(), { api })).toBe(0);
    expect(calls).toEqual(['/admin/gc']);
    expect(c.out()).toContain('3 logs');
  });

  it('needs the API settings', async () => {
    const c = io();
    expect(await gcCommand([], silent, c.handle, {})).toBe(2);
  });

  it('a failing call is a failure of the job', async () => {
    const api = {
      wakeApi: async () => ({ attempts: 1, waitedMs: 0 }),
      post: (async () => {
        throw new Error('503');
      }) as never,
    };
    expect(await gcCommand([], silent, io().handle, baseEnv(), { api })).toBe(1);
  });
});

describe('qsr validate', () => {
  it('accepts a directory of valid targets, canaries included', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    await writeFile(
      path.join(targets, '_canary', 'canary-pass-node.yaml'),
      yamlFor('canary-pass-node'),
    );
    const c = io();
    expect(await validateCommand(['--targets', targets], silent, c.handle)).toBe(0);
    expect(c.out()).toMatch(/2 targets valid/);
  });

  it('reports EVERY invalid file, not just the first, and exits 1', async () => {
    await writeFile(path.join(targets, 'good-node.yaml'), yamlFor('good-node'));
    await writeFile(path.join(targets, 'bad-one.yaml'), 'slug: bad-one\n');
    await writeFile(path.join(targets, 'wrong-name.yaml'), yamlFor('other-name'));
    const c = io();
    expect(await validateCommand(['--targets', targets], silent, c.handle)).toBe(1);
    expect(c.err()).toContain('bad-one.yaml');
    expect(c.err()).toContain('wrong-name.yaml');
    expect(c.err()).not.toContain('good-node.yaml');
  });

  it('refuses a placeholder that looks like a real key', async () => {
    const real = ['ghp', '_', 'a'.repeat(36)].join('');
    await writeFile(
      path.join(targets, 'keyed-node.yaml'),
      yamlFor('keyed-node', `placeholders:\n  API_KEY: ${real}\n`),
    );
    const c = io();
    expect(await validateCommand(['--targets', targets], silent, c.handle)).toBe(1);
    expect(c.err()).toMatch(/placeholder/i);
    expect(c.err()).not.toContain(real);
  });

  it.each([
    'http://docs.acme.dev/quickstart',
    'https://127.0.0.1/docs',
    'https://localhost/docs',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/docs',
    'https://printer.local/docs',
  ])('refuses a docs URL the crawler must never visit: %s', async (docsUrl) => {
    await writeFile(path.join(targets, 'evil-node.yaml'), yamlFor('evil-node', '', docsUrl));
    const c = io();
    expect(await validateCommand(['--targets', targets], silent, c.handle)).toBe(1);
    expect(c.err()).toMatch(/evil-node.*docsUrl/);
  });

  it('a canary may point at the local fixture server, and only a canary', async () => {
    await writeFile(
      path.join(targets, '_canary', 'canary-pass-node.yaml'),
      yamlFor('canary-pass-node', '', 'http://127.0.0.1:4177/canary/pass-node.html'),
    );
    expect(await validateCommand(['--targets', targets], silent, io().handle)).toBe(0);
    await writeFile(
      path.join(targets, 'sneaky-node.yaml'),
      yamlFor('sneaky-node', '', 'http://127.0.0.1:4177/canary/pass-node.html'),
    );
    expect(await validateCommand(['--targets', targets], silent, io().handle)).toBe(1);
  });

  it('--crawl does a dry run: crawls each target once and compiles nothing', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    await writeFile(path.join(targets, 'bolt-node.yaml'), yamlFor('bolt-node'));
    const crawled: string[] = [];
    const c = io();
    const code = await validateCommand(['--targets', targets, '--crawl'], silent, c.handle, {
      crawl: async (t) => {
        crawled.push(t.slug);
        return extractionFor(t);
      },
    });
    expect(code).toBe(0);
    expect(crawled.sort()).toEqual(['acme-node', 'bolt-node']);
    expect(c.out()).toMatch(/acme-node.*1 code block/);
  });

  it('--crawl exits 1 when a page cannot be crawled, and says why', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    const { CrawlError } = await import('@qsr/crawler');
    const c = io();
    const code = await validateCommand(['--targets', targets, '--crawl'], silent, c.handle, {
      crawl: async () => {
        throw new CrawlError('missing_root', 'main never appeared');
      },
    });
    expect(code).toBe(1);
    expect(c.err()).toMatch(/acme-node.*missing_root/);
  });

  it('--only limits both the validation report and the crawl to those slugs', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    await writeFile(path.join(targets, 'bolt-node.yaml'), yamlFor('bolt-node'));
    const crawled: string[] = [];
    await validateCommand(
      ['--targets', targets, '--crawl', '--only', 'bolt-node'],
      silent,
      io().handle,
      {
        crawl: async (t) => {
          crawled.push(t.slug);
          return extractionFor(t);
        },
      },
    );
    expect(crawled).toEqual(['bolt-node']);
  });

  it('--only naming a slug that has no file is an error (a typo must not pass silently)', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    const c = io();
    expect(
      await validateCommand(['--targets', targets, '--only', 'nope-node'], silent, c.handle),
    ).toBe(1);
    expect(c.err()).toContain('nope-node');
  });

  it('the targets committed in this repository all validate', async () => {
    const repoTargets = fileURLToPath(new URL('../../../../targets', import.meta.url));
    const c = io();
    expect(await validateCommand(['--targets', repoTargets], silent, c.handle), c.err()).toBe(0);
  });

  it('never needs the API settings or any secret', async () => {
    await writeFile(path.join(targets, 'acme-node.yaml'), yamlFor('acme-node'));
    expect(await validateCommand(['--targets', targets], silent, io().handle)).toBe(0);
  });
});
