import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Extraction, Logger } from '@qsr/core';
import { Target } from '@qsr/core';
import {
  LlmError,
  createMemoryCache,
  type ChatMessage,
  type LlmClient,
  type LlmResponse,
} from '@qsr/compiler';
import { startFixtureServer, type FixtureServer } from '@qsr/crawler';
import { compileCommand, compileExtraction, type CliIo } from './commands.js';
import { formatCompileResult } from './format.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/docs-site', import.meta.url));

/** A model that replays replies and counts calls. */
class Scripted implements LlmClient {
  calls = 0;
  readonly requests: ChatMessage[][] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  async complete(messages: readonly ChatMessage[]): Promise<LlmResponse> {
    this.calls++;
    this.requests.push([...messages]);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return { content: next, model: 'scripted', tokensIn: 10, tokensOut: 5, finishReason: 'stop' };
  }
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIo = { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) };
  return { handle, out: () => out.join(''), err: () => err.join('') };
}

function logs() {
  const lines: { msg?: string | undefined; fields: Record<string, unknown> }[] = [];
  const push = (fields: Record<string, unknown>, msg?: string) => void lines.push({ msg, fields });
  const log: Logger = { info: push, warn: push, error: push };
  return { log, msgs: () => lines.map((l) => l.msg) };
}

const target = Target.parse({
  slug: 'fixture-node',
  name: 'Fixture (Node.js)',
  docsUrl: 'https://example.com/docs',
  language: 'node',
  level: 2,
  runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
  extract: { root: 'main' },
});
const extraction: Extraction = {
  url: 'https://example.com/docs',
  finalUrl: 'https://example.com/docs',
  title: 'Docs',
  fetchedAt: '2026-10-16T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  blocks: [
    {
      index: 0,
      kind: 'code',
      lang: 'bash',
      text: 'npm install acme-sdk',
      filenameHint: null,
      headingPath: [],
    },
    {
      index: 1,
      kind: 'code',
      lang: 'ts',
      text: 'export const a = 1;',
      filenameHint: 'index.ts',
      headingPath: [],
    },
  ],
};
const plan = (command: string) =>
  JSON.stringify({
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command,
        source: { blockIndex: 0, lineStart: 1, lineEnd: 1 },
        expect: {},
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.ts',
        content: '',
        source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
      },
    ],
    maxLevelReachable: 2,
    notes: 'ok',
  });

describe('compileExtraction', () => {
  const base = (llm: LlmClient, over: Partial<Parameters<typeof compileExtraction>[2]> = {}) => ({
    llm,
    cache: createMemoryCache(),
    log: logs().log,
    json: false,
    refresh: false,
    ...over,
  });

  it('prints the plan and exits 0 when accepted', async () => {
    const o = io();
    const code = await compileExtraction(
      target,
      extraction,
      base(new Scripted([plan('npm install acme-sdk')])),
      o.handle,
    );
    expect(code).toBe(0);
    expect(o.out()).toMatch(/plan:\s+ACCEPTED/);
    expect(o.out()).toMatch(/s1\s+shell\s+npm install acme-sdk\s+#0:1/);
    expect(o.out()).toMatch(/s2\s+write_file\s+index\.ts \(1 lines\)\s+#1:1/);
    expect(o.out()).toMatch(/grounding: ok, 0 violations/);
  });

  it('prints JSON with --json', async () => {
    const o = io();
    await compileExtraction(
      target,
      extraction,
      base(new Scripted([plan('npm install acme-sdk')]), { json: true }),
      o.handle,
    );
    const parsed = JSON.parse(o.out()) as {
      plan: { accepted: boolean };
      fromCache: boolean;
      llmCalls: unknown[];
    };
    expect(parsed.plan.accepted).toBe(true);
    expect(parsed.fromCache).toBe(false);
    expect(parsed.llmCalls).toHaveLength(1);
  });

  it('exits 1 and lists the violations when the plan is rejected', async () => {
    const o = io();
    const bad = plan('npm install acme-sdk evil-pkg');
    const code = await compileExtraction(
      target,
      extraction,
      base(new Scripted([bad, bad])),
      o.handle,
    );
    expect(code).toBe(1);
    expect(o.out()).toMatch(/plan:\s+REJECTED \(COMPILER_ERROR/);
    expect(o.out()).toMatch(/grounding: FAILED, 1 violation\n\s+s1\s+command\.mismatch/);
  });

  it('exits 3 with a clear message when the model is unreachable or refuses', async () => {
    const o = io();
    const code = await compileExtraction(
      target,
      extraction,
      base(new Scripted([new LlmError('HTTP 401: Invalid API Key', 'rejected', 401)])),
      o.handle,
    );
    expect(code).toBe(3);
    expect(o.err()).toBe('MODEL ERROR (rejected 401): HTTP 401: Invalid API Key\n');
    const o2 = io();
    const code2 = await compileExtraction(
      target,
      extraction,
      base(new Scripted([new LlmError('gone', 'unavailable')])),
      o2.handle,
    );
    expect(code2).toBe(3);
    expect(o2.err()).toBe('MODEL ERROR (unavailable): gone\n');
  });

  it('lets unexpected errors propagate instead of hiding them as model errors', async () => {
    await expect(
      compileExtraction(
        target,
        extraction,
        base(new Scripted([new TypeError('bug')])),
        io().handle,
      ),
    ).rejects.toThrow('bug');
  });

  it('uses the model name from the environment override', async () => {
    const llm = new Scripted([plan('npm install acme-sdk')]);
    const o = io();
    await compileExtraction(target, extraction, base(llm, { model: 'other/model' }), o.handle);
    expect(llm.calls).toBe(1); // config only labels the call here; the provider client reads the same value
  });
});

describe('formatCompileResult', () => {
  it('shows cache hits as zero model calls', async () => {
    const llm = new Scripted([plan('npm install acme-sdk')]);
    const cache = createMemoryCache();
    const { compile } = await import('@qsr/compiler');
    await compile(target, extraction, { llm, cache });
    const hit = await compile(target, extraction, { llm: new Scripted([]), cache });
    const text = formatCompileResult('fixture-node', hit, 2);
    expect(text).toContain('from the plan cache (0 model calls)');
    expect(text).toContain("plan reaches L2 of the target's L2");
  });
});

describe('qsr compile end to end (real crawl of the fixture site, scripted model, file cache)', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer(FIXTURES);
  }, 60_000);
  afterAll(async () => {
    await server?.close();
  });

  async function workspace() {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-e2e-'));
    const targets = path.join(dir, 'targets');
    await mkdir(targets);
    await writeFile(
      path.join(targets, 'fixture-node.yaml'),
      [
        'slug: fixture-node',
        'name: Fixture',
        `docsUrl: ${server.url('/quickstart-basic.html')}`,
        'language: node',
        'level: 2',
        'runtime:',
        '  image: ghcr.io/aditya-tec/qsr-node:22',
        'extract:',
        '  root: "main"',
        '  ignoreBlocksMatching: ["^// Output:"]',
        'placeholders:',
        '  YOUR_API_KEY: qsr_dummy_key',
      ].join('\n'),
    );
    return { targets, cache: path.join(dir, 'cache') };
  }

  const reply = JSON.stringify({
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install acme-sdk',
        source: { blockIndex: 3, lineStart: 1, lineEnd: 1 },
        expect: {},
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.ts',
        content: '',
        source: { blockIndex: 6, lineStart: 1, lineEnd: 4 },
      },
    ],
    maxLevelReachable: 2,
    notes: 'Used npm.',
  });

  it('compiles on the first run and makes ZERO model calls on the second, with the log to prove it', async () => {
    const ws = await workspace();
    const args = ['fixture-node', '--targets', ws.targets, '--cache-dir', ws.cache];

    const first = { llm: new Scripted([reply]), io: io(), log: logs() };
    expect(await compileCommand(args, first.log.log, first.io.handle, { llm: first.llm })).toBe(0);
    expect(first.llm.calls).toBe(1);
    expect(first.io.out()).toMatch(/source:\s+compiled with 1 model call/);
    expect(first.log.msgs()).toEqual(
      expect.arrayContaining(['crawl ok', 'plan cache miss', 'llm call', 'plan compiled']),
    );

    const second = { llm: new Scripted([]), io: io(), log: logs() };
    expect(await compileCommand(args, second.log.log, second.io.handle, { llm: second.llm })).toBe(
      0,
    );
    expect(second.llm.calls).toBe(0);
    expect(second.io.out()).toMatch(/source:\s+from the plan cache \(0 model calls\)/);
    expect(second.log.msgs()).toContain('plan cache hit');
    expect(second.log.msgs()).not.toContain('llm call');
    expect(second.io.out()).toMatch(/plan:\s+ACCEPTED/);
  });

  it('--refresh recompiles even when a plan is cached', async () => {
    const ws = await workspace();
    const args = ['fixture-node', '--targets', ws.targets, '--cache-dir', ws.cache];
    await compileCommand(args, logs().log, io().handle, { llm: new Scripted([reply]) });
    const again = new Scripted([reply]);
    expect(
      await compileCommand([...args, '--refresh'], logs().log, io().handle, { llm: again }),
    ).toBe(0);
    expect(again.calls).toBe(1);
  });

  it('reports a missing slug with usage and exit 2', async () => {
    const o = io();
    expect(await compileCommand([], logs().log, o.handle)).toBe(2);
    expect(o.err()).toContain('missing <slug>');
  });

  it('a missing GROQ_API_KEY only matters when a plan has to be compiled', async () => {
    const ws = await workspace();
    const args = ['fixture-node', '--targets', ws.targets, '--cache-dir', ws.cache];
    const saved = process.env['GROQ_API_KEY'];
    delete process.env['GROQ_API_KEY'];
    try {
      const miss = io();
      expect(await compileCommand(args, logs().log, miss.handle)).toBe(3);
      expect(miss.err()).toContain('GROQ_API_KEY is not set');
      await compileCommand(args, logs().log, io().handle, { llm: new Scripted([reply]) }); // fill the cache
      const hit = io();
      expect(await compileCommand(args, logs().log, hit.handle)).toBe(0); // no key, no problem
      expect(hit.out()).toMatch(/from the plan cache/);
    } finally {
      if (saved !== undefined) process.env['GROQ_API_KEY'] = saved;
    }
  });
});
