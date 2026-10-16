import { GUARD_CANARY } from '@qsr/core';

// Spec section 12: "assign tools to shards (round-robin, heaviest first by last duration); put
// canary-pass-node in every shard and all other canaries in shard 0". Pure: the same tools give the same
// shards in any order.

export interface ShardTool {
  slug: string;
  isCanary: boolean;
  /** The tool's last duration, when the API knows it. */
  weightMs: number | null;
}

export const MAX_DEFAULT_SHARDS = 10;
export const TOOLS_PER_SHARD = 4;
/** What a tool with no history weighs: about a typical install-and-run. */
export const DEFAULT_WEIGHT_MS = 60_000;

/** min(10, ceil(tools / 4)), and never less than one shard. */
export function defaultShardCount(toolCount: number): number {
  return Math.max(1, Math.min(MAX_DEFAULT_SHARDS, Math.ceil(toolCount / TOOLS_PER_SHARD)));
}

export interface ShardAssignment {
  /** The shard that runs each tool and reports its result. */
  primary: Record<string, number>;
  /** Other shards that also run the guard canary, as a check on their own runner (never shard 0). */
  guards: number[];
}

export function assignShards(tools: readonly ShardTool[], shards: number): ShardAssignment {
  if (!Number.isInteger(shards) || shards < 1) throw new Error('at least one shard is required');
  const primary: Record<string, number> = {};

  const real = tools
    .filter((t) => !t.isCanary)
    .sort(
      (a, b) =>
        (b.weightMs ?? DEFAULT_WEIGHT_MS) - (a.weightMs ?? DEFAULT_WEIGHT_MS) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    );
  real.forEach((t, i) => {
    primary[t.slug] = i % shards;
  });

  for (const t of tools) if (t.isCanary) primary[t.slug] = 0;

  const hasGuard = tools.some((t) => t.slug === GUARD_CANARY);
  const guards = hasGuard ? Array.from({ length: shards - 1 }, (_, i) => i + 1) : [];
  return { primary, guards };
}
