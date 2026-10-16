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
  version: '2026-10-16.5',
  sha256: '88ae1cf099529a6b2e4d9cb9bc8af469f90bbb75f0b57b973cd23be714504049',
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
      'omittedBlockIndexes',
      'never invent',
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
      truncation: { omittedBlocks: number };
    };
    expect(data.truncation.omittedBlocks).toBe(0);
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

  it('carries the truncation record inside the data, and none of the old bare count', () => {
    const full = JSON.parse(buildDocsData(extraction(), 100_000)) as Record<string, unknown>;
    expect(full['omittedBlocks']).toBeUndefined();
    expect(full['truncation']).toMatchObject({
      truncated: false,
      totalBlocks: BLOCKS.length,
      includedBlocks: BLOCKS.length,
      omittedBlocks: 0,
      omittedBlockIndexes: [],
    });
    const some = JSON.parse(buildDocsData(extraction(), 1200)) as {
      blocks: { blockIndex: number }[];
      truncation: {
        truncated: boolean;
        includedBlocks: number;
        omittedBlocks: number;
        omittedBlockIndexes: number[];
      };
    };
    expect(some.truncation.truncated).toBe(true);
    expect(some.truncation.includedBlocks).toBe(some.blocks.length);
    expect(some.truncation.includedBlocks + some.truncation.omittedBlocks).toBe(BLOCKS.length);
    const shown = new Set(some.blocks.map((x) => x.blockIndex));
    for (const i of some.truncation.omittedBlockIndexes) expect(shown.has(i)).toBe(false);
  });

  it('keeps blocks in document order whichever ones the budget allows', () => {
    const some = JSON.parse(buildDocsData(extraction(), 1200)) as {
      blocks: { blockIndex: number }[];
    };
    const ids = some.blocks.map((x) => x.blockIndex);
    expect(ids).toEqual([...ids].sort((p, q) => p - q));
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
