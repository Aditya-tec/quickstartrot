import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract, startFixtureServer, type FixtureServer } from '@qsr/crawler';
import { Target, type Extraction } from '@qsr/core';
import { createFileCache, createMemoryCache } from './cache.js';
import { compile } from './compile.js';
import { ScriptedLlm } from './scripted-llm.test-utils.js';

// Golden path: fixture docs page -> real crawler (Chromium) -> compile with a MOCKED model reply ->
// IR snapshot. Everything except the model is the production code path.

const FIXTURES = fileURLToPath(new URL('../../../fixtures/docs-site', import.meta.url));
const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const src = (blockIndex: number, lineStart: number, lineEnd = lineStart) => ({
  blockIndex,
  lineStart,
  lineEnd,
});

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer(FIXTURES);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const targetFor = (page: string, extra: Record<string, unknown> = {}) =>
  Target.parse({
    slug: 'fixture-node',
    name: 'Fixture (Node.js)',
    docsUrl: server.url(page),
    language: 'node',
    level: 3,
    runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
    extract: { root: 'main', ignoreBlocksMatching: ['^// Output:'] },
    placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
    expect: { authErrorIsPass: true, timeoutSec: 300 },
    ...extra,
  });

const crawl = (t: Target): Promise<Extraction> =>
  extract(t, { browser, now: () => new Date('2026-10-16T00:00:00Z') });

describe('golden: quickstart-basic.html', () => {
  const reply = JSON.stringify({
    irVersion: 1,
    language: 'node',
    projectInit: 'none',
    steps: [
      { kind: 'shell', id: 's1', command: 'npm install acme-sdk', source: src(3, 1), expect: {} },
      {
        kind: 'shell',
        id: 's2',
        command: 'npm install --save-dev typescript',
        source: src(3, 2),
        expect: EXPECT,
      },
      {
        kind: 'write_file',
        id: 's3',
        path: 'index.ts',
        content: [
          "import { Acme } from 'acme-sdk';",
          '',
          "const client = new Acme('qsr_dummy_key');",
          "await client.send({ to: 'dev@example.com' });",
        ].join('\n'),
        source: src(6, 1, 4),
      },
      { kind: 'run', id: 's4', command: 'npx tsx index.ts', source: src(8, 1), expect: EXPECT },
    ],
    maxLevelReachable: 4,
    notes: 'Used npm; file name from the docs title bar.',
  });

  it('crawls the fixture, compiles with the mocked reply and matches the IR snapshot', async () => {
    const t = targetFor('/quickstart-basic.html');
    const extraction = await crawl(t);
    const llm = new ScriptedLlm([reply]);
    const result = await compile(t, extraction, {
      llm,
      cache: createMemoryCache(),
      clock: () => new Date('2026-10-16T12:00:00Z'),
    });

    expect(result.plan.accepted).toBe(true);
    expect(result.plan.groundingReport).toEqual({ ok: true, violations: [] });
    expect(result.plan.ir).toMatchSnapshot();

    // The page was handed to the model as data, with the blocks the validator will check against.
    const user = llm.requests[0]?.[1]?.content ?? '';
    expect(user).toContain('"blockIndex":6');
    expect(user).toContain('"file":"index.ts"');
  });

  it('a second compile of the unchanged page (fresh crawl, file cache) makes zero model calls', async () => {
    const t = targetFor('/quickstart-basic.html');
    const cache = createFileCache(await mkdtemp(path.join(tmpdir(), 'qsr-golden-')));
    const first = await compile(t, await crawl(t), { llm: new ScriptedLlm([reply]), cache });
    expect(first.fromCache).toBe(false);

    const silent = new ScriptedLlm([]);
    const second = await compile(t, await crawl(t), { llm: silent, cache });
    expect(second.fromCache).toBe(true);
    expect(second.llmCalls).toEqual([]);
    expect(silent.calls).toBe(0);
    expect(second.plan).toEqual(first.plan);
  });
});

describe('golden: code that legitimately starts with a dollar sign', () => {
  it('reaches the model unmangled and a plan that copies it verbatim is accepted', async () => {
    const t = targetFor('/dollar-prefix.html');
    const extraction = await crawl(t);
    const indexOf = (text: string) => {
      const block = extraction.blocks.find((b) => b.kind === 'code' && b.text === text);
      if (!block) throw new Error(`no code block with text ${JSON.stringify(text)}`);
      return block.index;
    };
    const home = indexOf('$HOME/.local/bin/acme --init');
    const jquery = indexOf('$ (document).ready(init);');
    const session = indexOf(['acme --version', 'acme 1.2.3'].join('\n'));

    const reply = JSON.stringify({
      irVersion: 1,
      language: 'node',
      projectInit: 'npm_init',
      steps: [
        {
          kind: 'shell',
          id: 's1',
          command: '$HOME/.local/bin/acme --init',
          source: src(home, 1),
          expect: {},
        },
        { kind: 'shell', id: 's2', command: 'acme --version', source: src(session, 1), expect: {} },
        {
          kind: 'write_file',
          id: 's3',
          path: 'index.js',
          content: '$ (document).ready(init);',
          source: src(jquery, 1),
        },
      ],
      maxLevelReachable: 2,
      notes: 'Default file name index.js.',
    });
    const llm = new ScriptedLlm([reply]);
    const result = await compile(t, extraction, { llm, cache: createMemoryCache() });

    expect(result.plan.accepted).toBe(true);
    expect(llm.calls).toBe(1);
    const steps = result.plan.ir?.steps ?? [];
    expect(steps[0]).toMatchObject({ command: '$HOME/.local/bin/acme --init' });
    expect(steps[2]).toMatchObject({ content: '$ (document).ready(init);' });
    // ... and the model was shown exactly that text, not a prompt-stripped version of it.
    const sent = llm.requests[0]?.[1]?.content ?? '';
    expect(sent).toContain('"$HOME/.local/bin/acme --init"');
    expect(sent).toContain('"$ (document).ready(init);"');
  });
});
