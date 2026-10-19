import { describe, expect, it } from 'vitest';
import { Target } from '@qsr/core';
import { extractTargetFacts } from './claims.js';

// A target on probation is enabled and probed, but it is in no count made from the target files until it leaves probation: not as
// enabled, not as disabled, not as L3 or local or shadow. The site holds the same targets back by itself (migration 0010).

const make = (slug: string, over: Record<string, unknown> = {}): Target =>
  Target.parse({
    slug,
    name: slug,
    docsUrl: `https://docs.example.com/${slug}`,
    language: 'node',
    level: 2,
    runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
    extract: { root: 'main' },
    ...over,
  });
const probation = { reason: 'New target: public after two valid cycles.' };

describe('extractTargetFacts', () => {
  it('counts a target on probation nowhere', () => {
    const facts = extractTargetFacts([
      make('a-node'),
      make('b-node', { enabled: false }),
      make('new-node', { probation }),
      make('new-l3-node', { level: 3, probation }),
      make('new-local-node', { expect: { localOnly: true }, probation }),
    ]);
    expect(facts.enabled).toBe(1);
    expect(facts.disabled).toBe(1);
    expect(facts.l3Production).toEqual([]);
    expect(facts.local).toEqual([]);
    expect(facts.shadow).toEqual([]);
  });

  it('counts it as enabled once the flag is removed', () => {
    expect(extractTargetFacts([make('a-node'), make('new-node')]).enabled).toBe(2);
  });
});
