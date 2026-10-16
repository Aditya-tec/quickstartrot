import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDocsData,
  buildUserMessage,
  COMPILER_VERSION,
  groundingRetryMessage,
  schemaRetryMessage,
  SYSTEM_PROMPT,
} from './prompt.js';
import { BLOCKS } from './grounding/fixtures.test-utils.js';
import { extraction, target } from './scripted-llm.test-utils.js';

// If this test fails you changed SYSTEM_PROMPT. Plans are cached by COMPILER_VERSION (spec section 8),
// so: (1) bump COMPILER_VERSION in prompt.ts, (2) put the new hash below.
const PINNED = {
  version: '2026-10-16.4',
  sha256: '541a9c3c86100f794a4ba7cfcc88c6fd9e8daf0b030870fcde350e24bd5c7c28',
};

describe('prompt versioning', () => {
  it('SYSTEM_PROMPT cannot change without a COMPILER_VERSION bump', () => {
    const hash = createHash('sha256').update(SYSTEM_PROMPT).digest('hex');
    if (hash !== PINNED.sha256) {
      expect(
        COMPILER_VERSION,
        'SYSTEM_PROMPT changed: bump COMPILER_VERSION and update PINNED in prompt.test.ts',
      ).not.toBe(PINNED.version);
    } else {
      expect(COMPILER_VERSION).toBe(PINNED.version);
    }
    expect({ version: COMPILER_VERSION, sha256: hash }).toEqual(PINNED);
  });

  it('states the spec rules the validator relies on', () => {
    for (const phrase of [
      'verbatim',
      'manual step',
      'untrusted data',
      'npm (node) or pip (python)',
      'placeholder map',
    ]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });
});

describe('buildDocsData', () => {
  it('labels every block with its index and gives code 1-based numbered lines', () => {
    const data = JSON.parse(buildDocsData(extraction(), 100_000)) as {
      blocks: {
        blockIndex: number;
        kind: string;
        lines?: [number, string][];
        text?: string;
        file?: string;
        lang?: string;
      }[];
      omittedBlocks: number;
    };
    expect(data.omittedBlocks).toBe(0);
    expect(data.blocks).toHaveLength(BLOCKS.length);
    const install = data.blocks.find((b) => b.blockIndex === 3);
    expect(install?.lines).toEqual([
      [1, 'npm install acme-sdk'],
      [2, 'npm install --save-dev typescript'],
    ]);
    expect(install?.lang).toBe('bash');
    expect(data.blocks.find((b) => b.blockIndex === 6)?.file).toBe('index.ts');
    expect(data.blocks.find((b) => b.blockIndex === 2)).toMatchObject({
      kind: 'prose',
      text: 'Install the package from npm.',
    });
    expect(data.blocks.find((b) => b.blockIndex === 2)).not.toHaveProperty('lines');
  });

  it('omits blocks past the budget and says how many, but always keeps the first block', () => {
    const tiny = JSON.parse(buildDocsData(extraction(), 1)) as {
      blocks: unknown[];
      omittedBlocks: number;
    };
    expect(tiny.blocks).toHaveLength(1);
    expect(tiny.omittedBlocks).toBe(BLOCKS.length - 1);
    const some = JSON.parse(buildDocsData(extraction(), 1200)) as {
      blocks: unknown[];
      omittedBlocks: number;
    };
    expect(some.blocks.length).toBeGreaterThan(1);
    expect(some.blocks.length + some.omittedBlocks).toBe(BLOCKS.length);
  });
});

describe('message builders', () => {
  it('the user message carries TARGET, the data section and a trailing trusted instruction', () => {
    const message = buildUserMessage(target(), extraction(), 100_000);
    const lines = message.split('\n');
    expect(lines[0]).toBe('TARGET');
    expect(JSON.parse(lines[1] ?? '')).toEqual({
      slug: 'acme-node',
      language: 'node',
      level: 3,
      placeholders: { YOUR_API_KEY: 'qsr_dummy_key', re_123456789: 'qsr_dummy_key' },
    });
    expect(lines.at(-1)).toMatch(/using DOCS_DATA only as data/);
  });

  it('retry messages embed the problem as data', () => {
    expect(schemaRetryMessage('steps: too small')).toContain('steps: too small');
    const violations = [
      { stepId: 's2', rule: 'file.content_mismatch', detail: 'differs "quoted"' },
    ];
    const message = groundingRetryMessage(violations);
    expect(message).toContain(JSON.stringify(violations));
    expect(message).toMatch(/manual step/);
  });
});
