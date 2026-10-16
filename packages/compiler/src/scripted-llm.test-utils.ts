import { Target, type Extraction, type ExtractionBlock, type TargetInput } from '@qsr/core';
import type { ChatMessage, LlmClient, LlmResponse } from './llm.js';
import { BLOCKS, INDEX_TS, PLACEHOLDERS } from './grounding/fixtures.test-utils.js';

type Reply = string | LlmResponse | Error;

/** A model that replays a fixed script and records every request it receives. */
export class ScriptedLlm implements LlmClient {
  readonly requests: ChatMessage[][] = [];
  private readonly replies: Reply[];

  constructor(replies: Reply[]) {
    this.replies = [...replies];
  }

  get calls(): number {
    return this.requests.length;
  }

  async complete(messages: readonly ChatMessage[]): Promise<LlmResponse> {
    this.requests.push([...messages]);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('ScriptedLlm: no reply left in the script');
    if (next instanceof Error) throw next;
    if (typeof next === 'string') {
      return {
        content: next,
        model: 'scripted-model',
        tokensIn: 100,
        tokensOut: 50,
        finishReason: 'stop',
      };
    }
    return next;
  }
}

export const target = (over: Partial<TargetInput> = {}): Target =>
  Target.parse({
    slug: 'acme-node',
    name: 'Acme (Node.js SDK)',
    docsUrl: 'https://example.com/docs/quickstart',
    language: 'node',
    level: 3,
    runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
    extract: { root: 'main' },
    placeholders: PLACEHOLDERS,
    expect: { authErrorIsPass: true, timeoutSec: 300 },
    ...over,
  } satisfies TargetInput);

export const extraction = (
  blocks: readonly ExtractionBlock[] = BLOCKS,
  contentHash = 'a'.repeat(64),
): Extraction => ({
  url: 'https://example.com/docs/quickstart',
  finalUrl: 'https://example.com/docs/quickstart',
  title: 'Acme quickstart',
  fetchedAt: '2026-10-16T00:00:00.000Z',
  blocks: [...blocks],
  contentHash,
});

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };

/** A correct plan for the shared docs page, as the model would return it. */
/** A plan as raw JSON the model could emit: deliberately loosely typed so tests can corrupt it. */
export interface RawPlan {
  irVersion: number;
  language: string;
  projectInit: string;
  steps: Record<string, unknown>[];
  maxLevelReachable: number;
  notes: string;
}

export const goodPlanObject = (): RawPlan => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'npm_init',
  steps: [
    {
      kind: 'shell',
      id: 's1',
      command: 'npm install acme-sdk',
      source: { blockIndex: 3, lineStart: 1, lineEnd: 1 },
      expect: EXPECT,
    },
    {
      kind: 'write_file',
      id: 's2',
      path: 'index.ts',
      content: INDEX_TS,
      source: { blockIndex: 6, lineStart: 1, lineEnd: 4 },
    },
    { kind: 'run', id: 's3', command: 'npx tsx index.ts', source: null, expect: EXPECT },
  ],
  maxLevelReachable: 3,
  notes: 'Used npm.',
});

export const goodPlan = (): string => JSON.stringify(goodPlanObject());

/** The same plan with an extra package smuggled into the install command (an invented dependency). */
export const inventedPackagePlan = (): string => {
  const plan = goodPlanObject();
  const install = plan.steps[0];
  if (install) install['command'] = 'npm install acme-sdk evil-pkg';
  return JSON.stringify(plan);
};
