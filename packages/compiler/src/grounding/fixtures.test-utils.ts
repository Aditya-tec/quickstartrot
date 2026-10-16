import type { ExtractionBlock, Language, Step, StepIR } from '@qsr/core';
import type { GroundingContext } from './index.js';

/** A small, realistic docs page. Block indexes are referenced throughout the tests. */
const code = (
  index: number,
  lang: string | null,
  text: string,
  filenameHint: string | null = null,
): ExtractionBlock => ({
  index,
  kind: 'code',
  lang,
  text,
  filenameHint,
  headingPath: ['Quickstart'],
});
const prose = (index: number, text: string): ExtractionBlock => ({
  index,
  kind: 'prose',
  lang: null,
  text,
  filenameHint: null,
  headingPath: ['Quickstart'],
});
const heading = (index: number, text: string): ExtractionBlock => ({
  index,
  kind: 'heading',
  lang: null,
  text,
  filenameHint: null,
  headingPath: [text],
});

export const BLOCKS: readonly ExtractionBlock[] = [
  heading(0, 'Acme SDK Quickstart'), // 0
  heading(1, 'Install'), // 1
  prose(2, 'Install the package from npm.'), // 2
  code(3, 'bash', 'npm install acme-sdk\nnpm install --save-dev typescript'), // 3
  heading(4, 'Send your first request'), // 4
  prose(5, 'Create a file named index.ts and add the following:'), // 5
  code(
    6,
    'ts',
    "import { Acme } from 'acme-sdk';\n\nconst client = new Acme('YOUR_API_KEY');\nawait client.send({ to: 'dev@example.com' });",
    'index.ts',
  ), // 6
  prose(7, 'Run the file with tsx:'), // 7
  code(8, 'bash', 'npx tsx index.ts'), // 8
  code(9, 'bash', 'cd my-app && npm install && npm run dev'), // 9
  code(10, 'bash', 'sudo npm install -g acme-cli'), // 10
  code(11, 'bash', 'rm -rf /'), // 11
  code(12, 'bash', 'rm -rf node_modules && npm install'), // 12
  code(13, 'bash', 'export ACME_API_KEY=re_123456789\nexport PORT=3000'), // 13
  code(14, 'python', 'import acme\nacme.send()', 'main.py'), // 14
  code(15, 'bash', 'echo "done; rm -rf /tmp/x"'), // 15
  code(16, 'bash', 'npm install \\\n  acme-sdk'), // 16
  code(17, 'json', '{ "name": "demo" }', 'package.json'), // 17
  code(18, 'ts', 'export const a = 1;'), // 18 (no filename hint)
  code(19, 'text', 'queued'), // 19
  code(20, 'python', 'def f():\n    return 1\n\nprint(f())'), // 20
  code(21, null, 'node -e "console.log(1)"'), // 21
  prose(22, 'Save the second file as helper.ts.'), // 22
  code(23, 'ts', 'export const helper = 2;'), // 23
];

export const PLACEHOLDERS = { YOUR_API_KEY: 'qsr_dummy_key', re_123456789: 'qsr_dummy_key' };

export const ctx = (over: Partial<GroundingContext> = {}): GroundingContext => ({
  blocks: BLOCKS,
  placeholders: PLACEHOLDERS,
  language: 'node' satisfies Language,
  ...over,
});

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
export const src = (blockIndex: number, lineStart: number, lineEnd: number = lineStart) => ({
  blockIndex,
  lineStart,
  lineEnd,
});

export const sh = (
  id: string,
  command: string,
  blockIndex: number,
  lineStart: number,
  lineEnd: number = lineStart,
): Step => ({
  kind: 'shell',
  id,
  command,
  source: src(blockIndex, lineStart, lineEnd),
  expect: EXPECT,
});

export const run = (
  id: string,
  command: string,
  source: ReturnType<typeof src> | null = null,
): Step => ({ kind: 'run', id, command, source, expect: EXPECT });

export const write = (
  id: string,
  path: string,
  content: string,
  blockIndex: number,
  lineStart: number,
  lineEnd: number,
): Step => ({ kind: 'write_file', id, path, content, source: src(blockIndex, lineStart, lineEnd) });

export const append = (
  id: string,
  path: string,
  content: string,
  blockIndex: number,
  lineStart: number,
  lineEnd: number,
): Step => ({
  kind: 'append_file',
  id,
  path,
  content,
  source: src(blockIndex, lineStart, lineEnd),
});

export const env = (
  id: string,
  name: string,
  value: string,
  source: ReturnType<typeof src> | null = null,
): Step => ({ kind: 'set_env', id, name, value, source });

export const manual = (id: string, reason: string, blockIndex: number, line: number): Step => ({
  kind: 'manual',
  id,
  reason,
  source: src(blockIndex, line),
});

export const plan = (steps: Step[], over: Partial<StepIR> = {}): StepIR => ({
  irVersion: 1,
  language: 'node',
  projectInit: 'npm_init',
  steps,
  maxLevelReachable: 3,
  notes: '',
  ...over,
});

/** The correct content of block 6 after the placeholder map is applied. */
export const INDEX_TS = [
  "import { Acme } from 'acme-sdk';",
  '',
  "const client = new Acme('qsr_dummy_key');",
  "await client.send({ to: 'dev@example.com' });",
].join('\n');
