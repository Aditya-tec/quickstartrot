import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIPELINE, Target, type TargetInput } from '@qsr/core';
import { CrawlError } from './errors.js';
import { CRAWL_RETRY_DELAY_MS, extract, type ExtractOptions } from './extract.js';
import { startFixtureServer, type FixtureServer } from './testing/fixture-server.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/docs-site', import.meta.url));
const FIXED_NOW = () => new Date('2026-10-16T00:00:00.000Z');

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer(FIXTURES, {
    redirects: { '/old-quickstart': '/quickstart-basic.html' },
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function target(pathname: string, extractCfg: Partial<TargetInput['extract']> = {}): Target {
  return Target.parse({
    slug: 'fixture',
    name: 'Fixture',
    docsUrl: server.url(pathname),
    language: 'node',
    level: 2,
    runtime: { image: 'qsr-node:22' },
    extract: { root: 'main', ...extractCfg },
  } satisfies TargetInput);
}

const run = (t: Target, over: Partial<ExtractOptions> = {}) =>
  extract(t, { browser, now: FIXED_NOW, rootTimeoutMs: 2_000, ...over });

const code = (e: Awaited<ReturnType<typeof run>>) => e.blocks.filter((b) => b.kind === 'code');

describe('fixture: quickstart-basic', () => {
  it('extracts headings, nearby prose and normalized code in document order', async () => {
    const e = await run(
      target('/quickstart-basic.html', { ignoreBlocksMatching: ['^// Output:'] }),
    );
    expect(e.title).toBe('Acme SDK Quickstart');
    expect(e.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['heading', 'Acme SDK Quickstart'],
      ['heading', 'Install'],
      ['prose', 'Install the package from npm.'],
      ['code', 'npm install acme-sdk\nnpm install --save-dev typescript'],
      ['heading', 'Send your first request'],
      ['prose', 'Create a file named index.ts and add the following:'],
      [
        'code',
        "import { Acme } from 'acme-sdk';\n\nconst client = new Acme('YOUR_API_KEY');\nawait client.send({ to: 'dev@example.com' });",
      ],
      ['prose', 'Run the file with tsx:'],
      ['code', 'npx tsx index.ts'],
      ['heading', 'Next steps'],
    ]);
    expect(e.blocks.map((b) => b.index)).toEqual(e.blocks.map((_, i) => i));
  });

  it('drops hidden copy-button labels (innerText, not textContent)', async () => {
    const e = await run(target('/quickstart-basic.html'));
    expect(code(e).some((b) => b.text.includes('Copy code'))).toBe(false);
  });

  it('keeps prose only when it is within 2 blocks before a code block', async () => {
    const e = await run(target('/quickstart-basic.html'));
    const prose = e.blocks.filter((b) => b.kind === 'prose').map((b) => b.text);
    expect(prose).not.toContain('Get started in five minutes.');
    expect(prose).not.toContain('Need help? Join our community chat.');
  });

  it('applies ignoreBlocksMatching and keeps the block when the pattern is absent', async () => {
    const without = await run(target('/quickstart-basic.html'));
    const withIgnore = await run(
      target('/quickstart-basic.html', { ignoreBlocksMatching: ['^// Output:'] }),
    );
    expect(code(without).map((b) => b.text)).toContain('// Output: queued');
    expect(code(withIgnore).map((b) => b.text)).not.toContain('// Output: queued');
  });

  it('builds headingPath from h1 to h4 nesting', async () => {
    const e = await run(target('/quickstart-basic.html'));
    const install = code(e)[0];
    expect(install?.headingPath).toEqual(['Acme SDK Quickstart', 'Install']);
  });

  it('records the filename hint and language of code blocks', async () => {
    const e = await run(target('/quickstart-basic.html'));
    const ts = code(e).find((b) => b.lang === 'ts');
    expect(ts?.filenameHint).toBe('index.ts');
    expect(code(e)[0]?.lang).toBe('bash');
  });
});

describe('fixture: tabs', () => {
  it('without extract.tab only the default (visible) panels are extracted', async () => {
    const e = await run(target('/tabs.html'));
    expect(code(e).map((b) => b.text)).toEqual([
      'npm install tabbed-sdk',
      "import { Client } from 'tabbed-sdk';\nnew Client().ping();",
    ]);
  });

  it('clicks every matching tab so all tab groups show the requested language', async () => {
    const e = await run(target('/tabs.html', { tab: 'Python' }));
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['bash', 'pip install tabbed-sdk'],
      ['python', 'from tabbed_sdk import Client\nClient().ping()'],
    ]);
  });

  it('matches tab labels case-insensitively and ignores labels that do not exist', async () => {
    expect(code(await run(target('/tabs.html', { tab: 'python' })))).toHaveLength(2);
    const none = await run(target('/tabs.html', { tab: 'Go' }));
    expect(code(none)[0]?.text).toBe('npm install tabbed-sdk');
  });
});

describe('fixture: collapsed sections', () => {
  it('expands closed details (including nested) and leaves open ones open', async () => {
    const e = await run(target('/collapsed.html'));
    expect(code(e).map((b) => b.text)).toEqual([
      'npm install collapsed-sdk',
      'npm run advanced-setup',
      'npm cache clean --force',
      'npm run already-open',
    ]);
  });
});

describe('fixture: languages and filenames', () => {
  it('reads lang from language-*, lang-*, data-language and normalizes untagged prompts', async () => {
    const e = await run(target('/languages.html'));
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['ts', 'const x: number = 1;'],
      ['py', 'x = 1\nprint(x)'],
      ['bash', 'echo done'],
      ['javascript', 'console.log(1);'],
      [null, '{ "plain": true }'],
      [null, 'cd project\nls'],
    ]);
  });

  it('reads filename hints from data-title, figcaption, sibling and prefixed title elements', async () => {
    const e = await run(target('/filenames.html'));
    expect(code(e).map((b) => b.filenameHint)).toEqual([
      'src/app.ts',
      'package.json',
      'main.py',
      'config.yaml',
      null, // "Example output" is a caption, not a filename
      null,
    ]);
  });
});

describe('fixture: documentation generators', () => {
  it('Sphinx: custom codeBlocks selector, highlight-<lang> classes, console prompts stripped', async () => {
    const e = await run(
      target('/sphinx.html', { root: '[role=main]', codeBlocks: 'div.highlight pre' }),
    );
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['console', 'pip install flask'],
      ['python', ['from flask import Flask', 'app = Flask(__name__)'].join('\n')],
      [null, 'plain text, no language'],
    ]);
  });

  it('mkdocs-material: finds a language class many levels above the code, without leaking containers', async () => {
    const e = await run(target('/mkdocs-linenums.html'));
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['python', ['from fastapi import FastAPI', 'app = FastAPI()'].join('\n')],
      [null, 'let a = 1;'], // wrapper holds two code blocks, so its class is not trusted
      [null, 'let b = 2;'],
    ]);
  });
});

describe('fixture: code that legitimately starts with a dollar sign', () => {
  it('keeps shell variables, expansions, template literals, jQuery, PowerShell and PHP intact', async () => {
    const e = await run(target('/dollar-prefix.html'));
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['bash', '$HOME/.local/bin/acme --init'],
      [null, '${PORT:-3000}'],
      ['js', '`${greeting}, ${name}!`;'],
      ['js', '$ (document).ready(init);'],
      ['powershell', '$env:ACME_KEY = "x"'],
      ['php', ['$user = new User();', '$user->save();'].join('\n')],
      ['text', ['acme --version', 'acme 1.2.3'].join('\n')],
    ]);
  });
});

describe('fixture: GitHub README markup', () => {
  it('strips the source-/text- prefix from highlight classes and ignores the copy button', async () => {
    const e = await run(
      target('/github-readme.html', {
        root: 'article.markdown-body',
        codeBlocks: 'div.highlight pre',
      }),
    );
    expect(code(e).map((b) => [b.lang, b.text])).toEqual([
      ['shell', 'npm install chalk-like'],
      [
        'js',
        ["import chalk from 'chalk-like';", '', "console.log(chalk.blue('Hello world!'));"].join(
          '\n',
        ),
      ],
      ['shell-session', ['node example.mjs', 'Hello world!'].join('\n')],
    ]);
  });
});

describe('fixture: per-line spans', () => {
  it('rebuilds code from line spans so blank lines survive, and still drops hidden labels', async () => {
    const e = await run(target('/line-spans.html'));
    expect(code(e).map((b) => b.text)).toEqual([
      ['from datetime import datetime', '', 'class User:', '    id: int', '', 'print(User)'].join(
        '\n',
      ),
      ['npm install x', 'npm run y'].join('\n'),
    ]);
  });
});

describe('determinism and snapshots', () => {
  it.each([
    'quickstart-basic',
    'tabs',
    'collapsed',
    'languages',
    'filenames',
    'mkdocs-linenums',
    'line-spans',
  ])('%s: hash is stable across two runs and the extraction matches its snapshot', async (name) => {
    const t = target(`/${name}.html`, name === 'tabs' ? { tab: 'Python' } : {});
    const first = await run(t);
    const second = await run(t);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.blocks).toEqual(first.blocks);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const stable = JSON.parse(
      JSON.stringify(first).replaceAll(server.origin, 'http://fixture.test'),
    ) as unknown;
    expect(stable).toMatchSnapshot();
  });
});

describe('failure handling', () => {
  const failure = async (t: Target, over: Partial<ExtractOptions> = {}): Promise<CrawlError> => {
    const err = await run(t, over).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlError);
    return err as CrawlError;
  };

  it('zero code blocks is CRAWL_ERROR no_code_blocks', async () => {
    expect((await failure(target('/no-code.html'))).reason).toBe('no_code_blocks');
  });

  it('a missing root selector is CRAWL_ERROR missing_root', async () => {
    expect((await failure(target('/missing-root.html'))).reason).toBe('missing_root');
  });

  it('4xx/5xx is CRAWL_ERROR http_status with the status code, and is not retried', async () => {
    let slept = 0;
    const err = await failure(target('/nope.html'), { sleep: async () => void slept++ });
    expect(err.reason).toBe('http_status');
    expect(err.details.httpStatus).toBe(404);
    expect(slept).toBe(0);
  });

  it('robots.txt disallow is CRAWL_ERROR robots and never opens the page', async () => {
    const err = await failure(target('/private/page.html'));
    expect(err.reason).toBe('robots');
  });

  it('records the redirect target in finalUrl', async () => {
    const e = await run(target('/old-quickstart'));
    expect(e.url).toBe(server.url('/old-quickstart'));
    expect(e.finalUrl).toBe(server.url('/quickstart-basic.html'));
  });

  it('retries network errors exactly once after 10 s, then gives up', async () => {
    const sleeps: number[] = [];
    let fetches = 0;
    const err = await failure(target('/quickstart-basic.html'), {
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async () => {
        fetches++;
        throw new Error('ECONNRESET');
      },
    });
    expect(err.reason).toBe('network');
    expect(sleeps).toEqual([CRAWL_RETRY_DELAY_MS]);
    expect(CRAWL_RETRY_DELAY_MS).toBe(PIPELINE.crawlRetryDelaySeconds * 1000);
    expect(fetches).toBe(1 + PIPELINE.crawlRetries);
  });

  it('succeeds when the single retry works', async () => {
    let fetches = 0;
    const e = await run(target('/quickstart-basic.html'), {
      sleep: async () => undefined,
      fetch: async (url, init) => {
        fetches++;
        if (fetches === 1) throw new Error('ECONNRESET');
        const res = await fetch(url, init);
        return { status: res.status, text: () => res.text() };
      },
    });
    expect(fetches).toBe(2);
    expect(e.blocks.length).toBeGreaterThan(0);
  });

  it('writes a Playwright trace when a crawl fails and traceDir is set', async () => {
    const traceDir = await mkdtemp(path.join(tmpdir(), 'qsr-trace-'));
    const err = await failure(target('/no-code.html'), { traceDir });
    expect(err.details.tracePath).toBeDefined();
    expect(existsSync(err.details.tracePath ?? '')).toBe(true);
  });

  it('does not leave trace files behind on success', async () => {
    const traceDir = await mkdtemp(path.join(tmpdir(), 'qsr-trace-'));
    await run(target('/quickstart-basic.html'), { traceDir });
    expect(existsSync(path.join(traceDir, 'fixture-0.zip'))).toBe(false);
  });
});

describe('fixture: variants (extract.variants)', () => {
  const variants = { splitOn: ['//\\s*ESM', '//\\s*(?:CommonJs|CJS)'], prefer: 'ESM' };
  const t = (extra: Partial<TargetInput['extract']> = {}, page = '/variants.html') =>
    target(page, { variants, ...extra });
  const failure = async (tt: Target): Promise<CrawlError> => {
    const err = await run(tt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlError);
    return err as CrawlError;
  };

  it("keeps the preferred variant plus the shared tail, drops the other variant's blocks, and records it", async () => {
    const e = await run(t());
    const text = code(e).map((b) => b.text);
    expect(text).toHaveLength(3); // install, the first server, the ESM plugin block (the CommonJs block is gone)
    expect(text[1]).toContain("import Acme from 'acme'");
    expect(text[1]).toContain('acme.listen({ port: 3000 })');
    expect(text[1]).not.toContain('require(');
    expect(text[1]).not.toMatch(/^\/\/ (ESM|CommonJs)$/m);
    expect(text[2]).toBe(
      "import Acme from 'acme'\nimport routes from './routes.js'\nconst acme = Acme()\nacme.register(routes)",
    );
    expect(e.blocks.map((b) => b.index)).toEqual(e.blocks.map((_, i) => i));
    expect(e.variants).toMatchObject({ prefer: 'ESM' });
    expect(e.variants?.blocks.map((b) => [b.action, b.keptMarker, b.markers])).toEqual([
      ['kept_variant', '// ESM', ['// ESM', '// CommonJs']],
      ['kept_variant', '// ESM', ['// ESM']],
      ['dropped_block', null, ['// CommonJs']],
    ]);
  });

  it('prefer CommonJs gives the other variant', async () => {
    const e = await run(t({ variants: { ...variants, prefer: 'CommonJs' } }));
    const text = code(e).map((b) => b.text);
    expect(text[1]).toContain("require('acme')({");
    expect(text[1]).not.toContain('import Acme');
  });

  it('the content hash reflects the variant that was kept, and is stable', async () => {
    const esm = await run(t());
    const again = await run(t());
    const cjs = await run(t({ variants: { ...variants, prefer: 'CommonJs' } }));
    expect(again.contentHash).toBe(esm.contentHash);
    expect(cjs.contentHash).not.toBe(esm.contentHash);
    // without variants configured the page is extracted as written, with both alternatives
    const raw = await run(target('/variants.html'));
    expect(raw.variants).toBeUndefined();
    expect(code(raw)[1]?.text).toContain('// CommonJs');
    expect(raw.contentHash).not.toBe(esm.contentHash);
  });

  it('variant_not_found when variants are configured but the page has no marker', async () => {
    const err = await failure(t({}, '/quickstart-basic.html'));
    expect(err.reason).toBe('variant_not_found');
    expect(err.retriable).toBe(false);
  });

  it('variant_not_found when a block has markers but not the preferred one', async () => {
    const err = await failure(t({}, '/variants-missing-preferred.html'));
    expect(err.reason).toBe('variant_not_found');
    expect(err.message).toMatch(/none matches "ESM"/);
  });
});
