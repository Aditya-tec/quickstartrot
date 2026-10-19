import { describe, expect, it } from 'vitest';
import { compileConfigHash } from './canary.js';
import { SourceRef, Step } from './step-ir.js';
import { countsPublicly, Target } from './target.js';

// Two things a new target can carry (2026-10-19):
//  * `grounding.installFromComment`: the docs show the install command ONLY inside a code comment (`// npm install x`, `# pip install x`).
//    The grounding validator accepts such a command for a target that declares it, nowhere else, and the plan records that the command was
//    taken from a comment. The flag is part of the plan cache key, so no existing plan is invalidated and none is silently reused.
//  * `probation`: the target is enabled and probed every cycle, but it is not in any public count, in the headline or in the numbers a
//    post could quote until it has two valid cycles.

const base = {
  slug: 'acme-node',
  name: 'Acme',
  docsUrl: 'https://docs.acme.dev/quickstart',
  language: 'node',
  level: 2,
  runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22', nodeVersion: '22' },
  extract: { root: 'main' },
} as const;
const parse = (over: Record<string, unknown> = {}): Target => Target.parse({ ...base, ...over });

describe('Target.grounding.installFromComment', () => {
  const grounding = {
    installFromComment: true,
    reason: 'The page shows its install command only as a comment in the first code block.',
  };

  it('is accepted with a reason, and absent stays absent after parsing', () => {
    expect(parse({ grounding }).grounding).toEqual(grounding);
    expect('grounding' in parse()).toBe(false);
  });

  it('needs a reason of at least ten characters, only the value true, and no other key', () => {
    expect(Target.safeParse({ ...base, grounding: { installFromComment: true } }).success).toBe(
      false,
    );
    expect(
      Target.safeParse({ ...base, grounding: { installFromComment: true, reason: 'short' } })
        .success,
    ).toBe(false);
    expect(
      Target.safeParse({
        ...base,
        grounding: { installFromComment: false, reason: grounding.reason },
      }).success,
    ).toBe(false);
    expect(Target.safeParse({ ...base, grounding: { ...grounding, extra: 1 } }).success).toBe(
      false,
    );
  });

  it('is part of the plan cache key: a target that sets it compiles under another config hash', () => {
    expect(compileConfigHash(parse({ grounding }))).not.toBe(compileConfigHash(parse()));
  });

  it('and the reason is not: rewording it does not recompile', () => {
    const reworded = { ...grounding, reason: 'A different sentence, long enough to be accepted.' };
    expect(compileConfigHash(parse({ grounding: reworded }))).toBe(
      compileConfigHash(parse({ grounding })),
    );
  });
});

describe('Target.probation', () => {
  const probation = { reason: 'New target: public after two valid cycles.' };

  it('is accepted with a reason, and absent stays absent', () => {
    expect(parse({ probation }).probation).toEqual(probation);
    expect('probation' in parse()).toBe(false);
  });

  it('needs a reason of at least ten characters and no other key', () => {
    expect(Target.safeParse({ ...base, probation: {} }).success).toBe(false);
    expect(Target.safeParse({ ...base, probation: { reason: 'short' } }).success).toBe(false);
    expect(Target.safeParse({ ...base, probation: { ...probation, extra: 1 } }).success).toBe(
      false,
    );
  });

  it('never changes a plan: it is not in the cache key, so leaving probation recompiles nothing', () => {
    expect(compileConfigHash(parse({ probation }))).toBe(compileConfigHash(parse()));
  });

  it('countsPublicly: enabled and not on probation', () => {
    expect(countsPublicly(parse())).toBe(true);
    expect(countsPublicly(parse({ probation }))).toBe(false);
    expect(countsPublicly(parse({ enabled: false }))).toBe(false);
    expect(countsPublicly(parse({ enabled: true }))).toBe(true);
  });
});

describe('SourceRef.commentOnly', () => {
  it('is optional, and absent stays absent, so every stored plan still parses and hashes the same', () => {
    const ref = SourceRef.parse({ blockIndex: 0, lineStart: 1, lineEnd: 1 });
    expect('commentOnly' in ref).toBe(false);
  });

  it('records that the cited lines are a code comment', () => {
    const ref = SourceRef.parse({ blockIndex: 0, lineStart: 1, lineEnd: 1, commentOnly: true });
    expect(ref.commentOnly).toBe(true);
    expect(
      SourceRef.safeParse({ blockIndex: 0, lineStart: 1, lineEnd: 1, commentOnly: false }).success,
    ).toBe(false);
  });

  it('a shell step carries it, and the step schema keeps it', () => {
    const step = Step.parse({
      kind: 'shell',
      id: 's1',
      command: 'npm install firecrawl',
      source: { blockIndex: 0, lineStart: 1, lineEnd: 1, commentOnly: true },
      expect: {},
    });
    expect(step.kind === 'shell' && step.source.commentOnly).toBe(true);
  });
});
