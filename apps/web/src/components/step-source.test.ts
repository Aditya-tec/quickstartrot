import { describe, expect, it } from 'vitest';
import type { SafeRun } from '@qsr/core/public';
import { sourceText } from './step-timeline';

// A step's source line on the run page. An install command that the docs show only as a code comment says so (`source.commentOnly`,
// recorded in the plan by the compiler), so nobody reads it as a line of the page that could be pasted into a terminal as it stands.

const run = {
  snapshot_blocks: [
    {
      index: 0,
      kind: 'code',
      lang: 'js',
      text: '// npm install x',
      filenameHint: null,
      headingPath: ['Node', 'Install'],
    },
  ],
} as unknown as SafeRun;
const shell = (source: Record<string, unknown>) =>
  ({ kind: 'shell', id: 's1', command: 'npm install x', source, expect: {} }) as never;

describe('sourceText', () => {
  it('names the block, the lines and the heading', () => {
    expect(sourceText(shell({ blockIndex: 0, lineStart: 1, lineEnd: 1 }), run)).toBe(
      'Docs block 1, line 1 under "Install"',
    );
    expect(sourceText(shell({ blockIndex: 0, lineStart: 1, lineEnd: 3 }), run)).toBe(
      'Docs block 1, lines 1-3 under "Install"',
    );
  });

  it('says when the command was taken from a code comment', () => {
    expect(
      sourceText(shell({ blockIndex: 0, lineStart: 1, lineEnd: 1, commentOnly: true }), run),
    ).toBe('Docs block 1, line 1 under "Install" (the docs show this command as a code comment)');
  });

  it('is null for a step with no source', () => {
    expect(sourceText(undefined, run)).toBeNull();
    expect(
      sourceText({ kind: 'set_env', id: 's', name: 'A', value: 'b', source: null } as never, run),
    ).toBeNull();
  });
});
