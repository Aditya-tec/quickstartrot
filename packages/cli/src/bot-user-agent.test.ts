import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crawlCommand, type CliIo } from './commands.js';
import { validateCommand } from './probe/pipeline-commands.js';
import { silent } from './probe/probe.test-utils.js';

// The crawler identifies itself as `QuickstartRotBot/1.0 (+<bot page>)` (spec sections 7 and 14). The bot page
// comes from configuration (BOT_INFO_URL). This drives the real commands through a real browser at a local
// server that records the User-Agent of every request it gets, robots.txt included.

const PAGE =
  '<html><body><main><h1>Start</h1><pre><code class="language-bash">npm install acme</code></pre></main></body></html>';

let server: Server;
let port: number;
let seen: { path: string; ua: string }[];
let dir: string;
const saved = process.env['BOT_INFO_URL'];

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') });
    if (req.url === '/robots.txt') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  dir = await mkdtemp(path.join(tmpdir(), 'qsr-ua-'));
  await mkdir(path.join(dir, 'targets'), { recursive: true });
  await writeFile(
    path.join(dir, 'targets', 'acme-node.yaml'),
    `slug: acme-node
name: Acme
docsUrl: http://127.0.0.1:${port}/docs
language: node
level: 2
runtime:
  image: ghcr.io/aditya-tec/qsr-node:22
extract:
  root: main
`,
  );
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  if (saved === undefined) delete process.env['BOT_INFO_URL'];
  else process.env['BOT_INFO_URL'] = saved;
});

function io() {
  const err: string[] = [];
  const handle: CliIo = { stdout: () => undefined, stderr: (t) => void err.push(t) };
  return { handle, err: () => err.join('') };
}

describe('qsr crawl', () => {
  it('sends the default bot page in the User-Agent of every request, robots.txt and the page alike', async () => {
    delete process.env['BOT_INFO_URL'];
    const code = await crawlCommand(
      ['acme-node', '--targets', path.join(dir, 'targets')],
      silent,
      io().handle,
    );
    expect(code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(expect.arrayContaining(['/robots.txt', '/docs']));
    for (const s of seen)
      expect(s.ua, s.path).toBe('QuickstartRotBot/1.0 (+https://quickstartrot.vercel.app/bot)');
  });

  it('uses BOT_INFO_URL from the environment when it is set', async () => {
    process.env['BOT_INFO_URL'] = 'https://bots.example.org/qsr';
    const code = await crawlCommand(
      ['acme-node', '--targets', path.join(dir, 'targets')],
      silent,
      io().handle,
    );
    expect(code).toBe(0);
    for (const s of seen)
      expect(s.ua, s.path).toBe('QuickstartRotBot/1.0 (+https://bots.example.org/qsr)');
  });

  it('refuses to crawl at all with an invalid BOT_INFO_URL, and says which variable', async () => {
    process.env['BOT_INFO_URL'] = 'http://not-https.example.org/bot';
    const c = io();
    const code = await crawlCommand(
      ['acme-node', '--targets', path.join(dir, 'targets')],
      silent,
      c.handle,
    );
    expect(code).toBe(2);
    expect(c.err()).toContain('BOT_INFO_URL');
    expect(seen).toEqual([]);
  });
});

describe('qsr validate --crawl (the dry run on pull requests)', () => {
  it('identifies itself the same way', async () => {
    process.env['BOT_INFO_URL'] = 'https://bots.example.org/qsr';
    const c = io();
    // loopback is allowed only for a canary: drop the shared non-canary target and use one in _canary
    await rm(path.join(dir, 'targets', 'acme-node.yaml'));
    await mkdir(path.join(dir, 'targets', '_canary'), { recursive: true });
    await writeFile(
      path.join(dir, 'targets', '_canary', 'canary-ua.yaml'),
      `slug: canary-ua
name: UA canary
docsUrl: http://127.0.0.1:${port}/docs
language: node
level: 1
runtime:
  image: ghcr.io/aditya-tec/qsr-node:22
extract:
  root: main
`,
    );
    const code = await validateCommand(
      ['--targets', path.join(dir, 'targets'), '--crawl', '--only', 'canary-ua'],
      silent,
      c.handle,
    );
    expect(code, c.err()).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen)
      expect(s.ua, s.path).toBe('QuickstartRotBot/1.0 (+https://bots.example.org/qsr)');
  });

  it('refuses an invalid BOT_INFO_URL before crawling', async () => {
    process.env['BOT_INFO_URL'] = 'nonsense';
    const c = io();
    const code = await validateCommand(
      ['--targets', path.join(dir, 'targets'), '--crawl'],
      silent,
      c.handle,
    );
    expect(code).toBe(2);
    expect(c.err()).toContain('BOT_INFO_URL');
  });
});
