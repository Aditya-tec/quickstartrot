import { describe, expect, it } from 'vitest';
import type { ExtractionBlock } from '@qsr/core';
import { createMemoryCache } from './cache.js';
import { compile } from './compile.js';
import { buildUserMessage } from './prompt.js';
import { extraction, ScriptedLlm, target } from './scripted-llm.test-utils.js';

// A page whose install command is only a comment (the Firecrawl SDK pages): a target that declares `grounding.installFromComment` gets a
// plan whose install step is grounded in that comment and says so (`source.commentOnly`); any other target is refused the same plan.

const block = (index: number, lang: string | null, text: string): ExtractionBlock => ({
  index,
  kind: 'code',
  lang,
  text,
  filenameHint: null,
  headingPath: ['Quickstart'],
});
const BLOCKS: ExtractionBlock[] = [
  {
    index: 0,
    kind: 'heading',
    lang: null,
    text: 'Node SDK',
    filenameHint: null,
    headingPath: ['Node SDK'],
  },
  block(
    1,
    'js',
    "// npm install acme-sdk\n\nimport { Acme } from 'acme-sdk';\nconst client = new Acme();",
  ),
  block(2, 'bash', 'npm install acme-sdk'),
];
const page = () => extraction(BLOCKS, 'c'.repeat(64));

const FLAGGED = {
  grounding: {
    installFromComment: true,
    reason: 'The page shows its install command only as a comment in the first code block.',
  },
} as const;

const reply = (install: { blockIndex: number; lineStart: number; lineEnd: number }, extra = {}) =>
  JSON.stringify({
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install acme-sdk',
        source: { ...install, ...extra },
        expect: {},
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.js',
        content: '',
        source: { blockIndex: 1, lineStart: 3, lineEnd: 4 },
      },
    ],
    maxLevelReachable: 2,
    notes: 'Installs the package from the comment, then writes index.js.',
  });

const flaggedTarget = () => target({ level: 2, ...FLAGGED });
const plainTarget = () => target({ level: 2 });

describe('a target that declares installFromComment', () => {
  it('compiles a plan whose install step is grounded in the comment, and the plan records it', async () => {
    const llm = new ScriptedLlm([reply({ blockIndex: 1, lineStart: 1, lineEnd: 1 })]);
    const result = await compile(flaggedTarget(), page(), { llm, cache: createMemoryCache() });
    expect(result.plan.accepted).toBe(true);
    expect(llm.calls).toBe(1);
    const install = result.plan.ir?.steps[0];
    expect(install).toMatchObject({
      kind: 'shell',
      command: 'npm install acme-sdk',
      source: { blockIndex: 1, lineStart: 1, lineEnd: 1, commentOnly: true },
    });
    // the other steps are not marked
    expect(JSON.stringify(result.plan.ir?.steps[1])).not.toContain('commentOnly');
  });

  it('the compiler sets the flag, not the model: a model that forgets it, or claims it for a real command, makes no difference', async () => {
    const forgot = await compile(flaggedTarget(), page(), {
      llm: new ScriptedLlm([reply({ blockIndex: 1, lineStart: 1, lineEnd: 1 })]),
      cache: createMemoryCache(),
    });
    expect(forgot.plan.ir?.steps[0]).toMatchObject({ source: { commentOnly: true } });

    const claimed = await compile(flaggedTarget(), page(), {
      llm: new ScriptedLlm([
        reply({ blockIndex: 2, lineStart: 1, lineEnd: 1 }, { commentOnly: true }),
      ]),
      cache: createMemoryCache(),
    });
    expect(claimed.plan.accepted).toBe(true);
    expect(JSON.stringify(claimed.plan.ir?.steps[0])).not.toContain('commentOnly');
  });

  it('a comment cited together with the code under it is refused with a hint, and the one retry fixes it', async () => {
    const llm = new ScriptedLlm([
      reply({ blockIndex: 1, lineStart: 1, lineEnd: 3 }),
      reply({ blockIndex: 1, lineStart: 1, lineEnd: 1 }),
    ]);
    const result = await compile(flaggedTarget(), page(), { llm, cache: createMemoryCache() });
    expect(llm.calls).toBe(2);
    const retry = llm.requests[1]?.at(-1)?.content ?? '';
    expect(retry).toContain('is written as a comment on line 1 of block 1');
    expect(result.plan.accepted).toBe(true);
    expect(result.plan.ir?.steps[0]).toMatchObject({ source: { commentOnly: true } });
  });

  it('tells the model about it, in the user message and nowhere else', () => {
    const message = buildUserMessage(flaggedTarget(), page(), 10_000);
    expect(message).toContain('only as a code comment');
    expect(message).toContain('without the comment marker');
  });
});

describe('every other target', () => {
  it('is refused a plan that takes its install from a comment, exactly as before', async () => {
    const llm = new ScriptedLlm([
      reply({ blockIndex: 1, lineStart: 1, lineEnd: 1 }),
      reply({ blockIndex: 1, lineStart: 1, lineEnd: 1 }),
    ]);
    const result = await compile(plainTarget(), page(), { llm, cache: createMemoryCache() });
    expect(result.plan.accepted).toBe(false);
    expect(result.plan.groundingReport.violations.map((v) => v.rule)).toContain(
      'command.source_not_shell',
    );
    expect(JSON.stringify(result.plan.groundingReport)).not.toContain('is written as a comment');
  });

  it('gets the same user message as before: no note, no new key', () => {
    const message = buildUserMessage(plainTarget(), page(), 10_000);
    expect(message).not.toContain('code comment');
    expect(message).not.toContain('installFromComment');
  });
});
