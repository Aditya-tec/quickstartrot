// A small seeded generator, so a mutation run is repeatable: the same seed and the same inputs give the same mutants,
// in the same order. Not for anything secret.

/** FNV-1a over the text, as an unsigned 32-bit integer. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T | undefined;
  /** A new array in a seeded order (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32. `scope` makes independent streams from one seed (one per target and operator). */
export function createRng(seed: string, scope = ''): Rng {
  let a = hashSeed(`${seed}\u0000${scope}`);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick: (items) => (items.length === 0 ? undefined : items[int(items.length)]),
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
  };
}
