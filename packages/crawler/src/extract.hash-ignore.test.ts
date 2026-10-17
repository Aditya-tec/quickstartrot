import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Target, type TargetInput } from '@qsr/core';
import { extract } from './extract.js';
import { startFixtureServer, type FixtureServer } from './testing/fixture-server.js';

// extract.hashIgnore (go-live after P9a): two visits to a page that prints a rotating demo key must give one content
// hash, while the extraction itself keeps the text exactly as the page showed it.

const FIXTURES = fileURLToPath(new URL('../../../fixtures/docs-site', import.meta.url));
const NOW = () => new Date('2026-10-17T00:00:00.000Z');
const RULE = {
  pattern: String.raw`\b([A-Za-z0-9_-]{5,8})\.[A-Za-z0-9_-]{5,8}:(?=\*{3,})`,
  replaceWith: '$1.KEYID:',
};

let browser: Browser;
let server: FixtureServer;
beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer(FIXTURES, {});
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const target = (page: 'a' | 'b', hashIgnore?: TargetInput['extract']['hashIgnore']): Target =>
  Target.parse({
    slug: 'fixture',
    name: 'Fixture',
    docsUrl: server.url(`/demo-key-${page}.html`),
    language: 'python',
    level: 2,
    runtime: { image: 'qsr-python:3.12' },
    extract: { root: 'main', ...(hashIgnore ? { hashIgnore } : {}) },
  } satisfies TargetInput);
const run = (t: Target) => extract(t, { browser, now: NOW, rootTimeoutMs: 2_000 });

describe('extract with hashIgnore', () => {
  it('gives the same hash for two visits that differ only in the demo key id, and keeps the verbatim text', async () => {
    const a = await run(target('a', [RULE]));
    const b = await run(target('b', [RULE]));
    expect(a.contentHash).toBe(b.contentHash);
    const codeA = a.blocks.find((x) => x.lang === 'python')?.text ?? '';
    const codeB = b.blocks.find((x) => x.lang === 'python')?.text ?? '';
    expect(codeA).toContain('xVLyHw.ztp85A:*****');
    expect(codeB).toContain('xVLyHw.-gbZ_g:*****');
  });

  it('without the rule the same two visits are two different pages (the behaviour without the rule is unchanged)', async () => {
    const a = await run(target('a'));
    const b = await run(target('b'));
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('the hash with the rule differs from the hash without it, so the rule is really applied', async () => {
    const withRule = await run(target('a', [RULE]));
    const without = await run(target('a'));
    expect(withRule.contentHash).not.toBe(without.contentHash);
  });
});
