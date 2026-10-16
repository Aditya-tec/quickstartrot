import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@qsr/core';
import { createFileCache, createMemoryCache, type CompiledPlan, type PlanCache } from './cache.js';

const plan = (over: Partial<CompiledPlan> = {}): CompiledPlan => ({
  toolSlug: 'acme-node',
  contentHash: 'f'.repeat(64),
  compilerVersion: '2026-10-16.1',
  model: 'm',
  ir: null,
  groundingReport: { ok: false, violations: [{ stepId: '*', rule: 'schema', detail: 'nope' }] },
  accepted: false,
  truncation: {
    truncated: false,
    totalBlocks: 0,
    includedBlocks: 0,
    omittedBlocks: 0,
    omittedBlockIndexes: [],
    clippedBlockIndexes: [],
  },
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
});
const keyOf = (p: CompiledPlan) => ({
  toolSlug: p.toolSlug,
  contentHash: p.contentHash,
  compilerVersion: p.compilerVersion,
});

function contract(name: string, make: () => Promise<PlanCache>) {
  describe(`${name}: PlanCache contract`, () => {
    let cache: PlanCache;
    beforeEach(async () => {
      cache = await make();
    });

    it('misses, then hits after put', async () => {
      const p = plan();
      expect(await cache.get(keyOf(p))).toBeNull();
      await cache.put(p);
      expect(await cache.get(keyOf(p))).toEqual(p);
    });

    it('keys on tool, content hash and compiler version independently', async () => {
      const p = plan();
      await cache.put(p);
      expect(await cache.get({ ...keyOf(p), toolSlug: 'other' })).toBeNull();
      expect(await cache.get({ ...keyOf(p), contentHash: 'e'.repeat(64) })).toBeNull();
      expect(await cache.get({ ...keyOf(p), compilerVersion: 'v2' })).toBeNull();
    });

    it('overwrites the entry for the same key', async () => {
      await cache.put(plan({ model: 'old' }));
      await cache.put(plan({ model: 'new' }));
      expect((await cache.get(keyOf(plan())))?.model).toBe('new');
    });
  });
}

contract('memory cache', async () => createMemoryCache());
contract('file cache', async () =>
  createFileCache(await mkdtemp(path.join(tmpdir(), 'qsr-cache-'))),
);

describe('file cache', () => {
  const recorder = () => {
    const warnings: Record<string, unknown>[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (f) => void warnings.push(f),
      error: () => undefined,
    };
    return { warnings, log };
  };

  it('stores one readable JSON file per key under <dir>/<slug>/<hash>.<version>.json and leaves no temp files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-cache-'));
    const cache = createFileCache(dir);
    const p = plan();
    await cache.put(p);
    const file = path.join(dir, 'acme-node', `${'f'.repeat(64)}.2026-10-16.1.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(p);
    expect(readdirSync(path.join(dir, 'acme-node'))).toEqual([path.basename(file)]);
  });

  it('survives a new instance over the same directory (it is a real cache across runs)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-cache-'));
    await createFileCache(dir).put(plan());
    expect(await createFileCache(dir).get(keyOf(plan()))).toEqual(plan());
  });

  it('treats unparsable and schema-invalid files as a miss and warns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qsr-cache-'));
    const { warnings, log } = recorder();
    const cache = createFileCache(dir, log);
    await cache.put(plan());
    const file = path.join(dir, 'acme-node', `${'f'.repeat(64)}.2026-10-16.1.json`);

    await writeFile(file, '{ not json');
    expect(await cache.get(keyOf(plan()))).toBeNull();
    await writeFile(file, JSON.stringify({ toolSlug: 'acme-node', accepted: 'maybe' }));
    expect(await cache.get(keyOf(plan()))).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(existsSync(file)).toBe(true); // never deleted behind the user's back
  });

  it('refuses keys that could escape the cache directory', async () => {
    const cache = createFileCache(await mkdtemp(path.join(tmpdir(), 'qsr-cache-')));
    for (const bad of ['../x', 'a/b', '..', '.', '', 'a b', 'a\\b']) {
      await expect(cache.get({ ...keyOf(plan()), toolSlug: bad })).rejects.toThrow(
        /unsafe plan cache key/,
      );
      await expect(cache.put(plan({ contentHash: bad }))).rejects.toThrow(/unsafe plan cache key/);
    }
  });
});
