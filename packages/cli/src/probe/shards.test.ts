import { describe, expect, it } from 'vitest';
import { GUARD_CANARY } from '@qsr/core';
import { assignShards, defaultShardCount, type ShardTool } from './shards.js';

// Spec section 12: tools go to shards round-robin, heaviest first by last duration; canary-pass-node is
// in every shard (each runner proves itself), all the other canaries in shard 0.

const real = (slug: string, weightMs: number | null = null): ShardTool => ({
  slug,
  isCanary: false,
  weightMs,
});
const canaries: ShardTool[] = [
  'canary-pass-node',
  'canary-pass-python',
  'canary-fail-drift',
  'canary-fail-dep',
].map((slug) => ({ slug, isCanary: true, weightMs: null }));

describe('defaultShardCount', () => {
  it.each([
    [0, 1],
    [1, 1],
    [4, 1],
    [5, 2],
    [8, 2],
    [14, 4],
    [40, 10],
    [41, 10],
    [500, 10],
  ])('%i tools -> %i shards (min(10, ceil(tools / 4)), at least 1)', (tools, shards) => {
    expect(defaultShardCount(tools)).toBe(shards);
  });
});

describe('assignShards', () => {
  it('deals the heaviest tool first, round-robin', () => {
    const tools = [real('a', 10), real('b', 50), real('c', 30), real('d', 40), real('e', 20)];
    const { primary } = assignShards(tools, 2);
    // order by weight: b(50) d(40) c(30) e(20) a(10) -> shard 0,1,0,1,0
    expect(primary).toMatchObject({ b: 0, d: 1, c: 0, e: 1, a: 0 });
  });

  it('a tool with no known duration counts as a typical one, and ties break by slug', () => {
    const { primary } = assignShards([real('zeta'), real('alpha'), real('mid', 1)], 3);
    expect(primary).toMatchObject({ alpha: 0, zeta: 1, mid: 2 });
  });

  it('is deterministic: the same input in any order gives the same shards', () => {
    const tools = [real('a', 1), real('b', 2), real('c', 3), ...canaries];
    expect(assignShards(tools, 3)).toEqual(assignShards([...tools].reverse(), 3));
  });

  it('puts canary-pass-node in EVERY shard (primary in 0, guards elsewhere) and the other canaries in shard 0', () => {
    const { primary, guards } = assignShards([real('a'), real('b'), ...canaries], 4);
    expect(primary[GUARD_CANARY]).toBe(0);
    expect(guards).toEqual([1, 2, 3]);
    expect(primary['canary-pass-python']).toBe(0);
    expect(primary['canary-fail-drift']).toBe(0);
    expect(primary['canary-fail-dep']).toBe(0);
  });

  it('one shard has no guards: the primary canary is the shard check', () => {
    const { guards } = assignShards([real('a'), ...canaries], 1);
    expect(guards).toEqual([]);
  });

  it('more shards than tools leaves shards that only hold the guard canary', () => {
    const { primary, guards } = assignShards([real('a'), ...canaries], 5);
    expect(primary['a']).toBe(0);
    expect(guards).toEqual([1, 2, 3, 4]);
  });

  it('works with no canary in the list (a validate-only plan)', () => {
    const { primary, guards } = assignShards([real('a'), real('b')], 2);
    expect(Object.keys(primary).sort()).toEqual(['a', 'b']);
    expect(guards).toEqual([]);
  });

  it('rejects fewer than one shard', () => {
    expect(() => assignShards([real('a')], 0)).toThrow(/at least one shard/);
  });
});
