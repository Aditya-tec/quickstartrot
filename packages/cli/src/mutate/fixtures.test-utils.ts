import {
  Target,
  type Extraction,
  type ExtractionBlock,
  type StepIR,
  type TargetInput,
} from '@qsr/core';
import type { MutationInput } from './inputs.js';

// Small, realistic (extraction, plan) pairs for the mutation tests. The plans quote the docs exactly, so the real grounding
// validator accepts them; every test starts from that.

const block = (
  index: number,
  kind: ExtractionBlock['kind'],
  text: string,
  lang: string | null = null,
  filenameHint: string | null = null,
): ExtractionBlock => ({
  index,
  kind,
  lang,
  text,
  filenameHint,
  headingPath: ['Quickstart'],
});

const extraction = (blocks: ExtractionBlock[]): Extraction => ({
  url: 'https://docs.example.com/quickstart',
  finalUrl: 'https://docs.example.com/quickstart',
  title: 'Quickstart',
  fetchedAt: '2026-10-18T00:00:00.000Z',
  blocks,
  contentHash: 'a'.repeat(64),
});

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const targetFor = (
  slug: string,
  language: 'node' | 'python',
  over: Partial<TargetInput> = {},
): Target =>
  Target.parse({
    slug,
    name: slug,
    docsUrl: 'https://docs.example.com/quickstart',
    language,
    level: 2,
    runtime: { image: `ghcr.io/aditya-tec/qsr-${language}:${language === 'node' ? '22' : '3.12'}` },
    extract: { root: 'main' },
    placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
    ...over,
  } satisfies TargetInput);

const ESM_CODE = [
  "import { Acme, Mailer as Sender } from 'acme-sdk';",
  "import { readFile } from 'node:fs/promises';",
  '',
  "const client = new Acme('YOUR_API_KEY');",
  'const res = await client.send({',
  "  to: 'dev@example.com',",
  "  subject: 'hello',",
  '});',
  'console.log(res);',
].join('\n');

/** Node, ES module, level 2: an install and a file, no run step. */
export function esmInput(): MutationInput {
  const ir: StepIR = {
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    maxLevelReachable: 2,
    notes: 'install and write',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install acme-sdk',
        source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
        expect: EXPECT,
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.mjs',
        content: ESM_CODE.replace('YOUR_API_KEY', 'qsr_dummy_key'),
        source: { blockIndex: 3, lineStart: 1, lineEnd: 9 },
      },
    ],
  };
  const ex = extraction([
    block(0, 'heading', 'Quickstart'),
    block(1, 'code', 'npm install acme-sdk', 'bash'),
    block(2, 'prose', 'Create a file named index.mjs and add the following:'),
    block(3, 'code', ESM_CODE, 'js', 'index.mjs'),
  ]);
  return { target: targetFor('esm-node', 'node'), extraction: ex, plan: planOf(ir), ir };
}

const CJS_CODE = [
  "const { Acme } = require('acme-sdk');",
  "const acme = new Acme({ apiKey: 'YOUR_API_KEY', region: 'eu' });",
  "acme.send({ to: 'a@b.c' });",
].join('\n');

/** Node, CommonJS, level 3: the plan also runs the snippet. */
export function cjsInput(): MutationInput {
  const ir: StepIR = {
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    maxLevelReachable: 3,
    notes: 'install, write, run',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install acme-sdk',
        source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
        expect: EXPECT,
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.js',
        content: CJS_CODE.replace('YOUR_API_KEY', 'qsr_dummy_key'),
        source: { blockIndex: 3, lineStart: 1, lineEnd: 3 },
      },
      { kind: 'run', id: 's3', command: 'node index.js', source: null, expect: EXPECT },
    ],
  };
  const ex = extraction([
    block(0, 'heading', 'Quickstart'),
    block(1, 'code', 'npm install acme-sdk', 'bash'),
    block(2, 'prose', 'Create a file named index.js and add the following:'),
    block(3, 'code', CJS_CODE, 'js', 'index.js'),
  ]);
  return {
    target: targetFor('cjs-node', 'node', { level: 3 }),
    extraction: ex,
    plan: planOf(ir),
    ir,
  };
}

/** Like cjsInput, but the target asks for auth-error-as-pass at level 3: its run step makes a request to a VENDOR (a dummy key). */
export function vendorInput(): MutationInput {
  const base = cjsInput();
  return {
    ...base,
    target: targetFor('vendor-node', 'node', {
      level: 3,
      expect: { authErrorIsPass: true, timeoutSec: 300 },
    }),
  };
}

/** Like cjsInput, but the target declares that no vendor is involved (a library): its run step is local. */
export function localInput(): MutationInput {
  const base = cjsInput();
  return {
    ...base,
    target: targetFor('local-node', 'node', {
      level: 2,
      expect: { authErrorIsPass: false, timeoutSec: 300, localOnly: true },
    }),
  };
}

const PY_CODE = [
  'from acme import Client',
  '',
  'client = Client(api_key="YOUR_API_KEY")',
  'client.send(to="a@b.c", subject="hello")',
].join('\n');

/** Python, level 2. */
export function pythonInput(): MutationInput {
  const ir: StepIR = {
    irVersion: 1,
    language: 'python',
    projectInit: 'python_venv',
    maxLevelReachable: 2,
    notes: 'install and write',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'pip install acme-sdk',
        source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
        expect: EXPECT,
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'main.py',
        content: PY_CODE.replace('YOUR_API_KEY', 'qsr_dummy_key'),
        source: { blockIndex: 3, lineStart: 1, lineEnd: 4 },
      },
    ],
  };
  const ex = extraction([
    block(0, 'heading', 'Quickstart'),
    block(1, 'code', 'pip install acme-sdk', 'bash'),
    block(2, 'prose', 'Save this as main.py:'),
    block(3, 'code', PY_CODE, 'python', 'main.py'),
  ]);
  return { target: targetFor('py-python', 'python'), extraction: ex, plan: planOf(ir), ir };
}

/** A page with an install command and nothing else: the plan stops at the install (level 1). */
export function installOnlyInput(): MutationInput {
  const ir: StepIR = {
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    maxLevelReachable: 1,
    notes: 'install only',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install @scope/acme-sdk',
        source: { blockIndex: 1, lineStart: 1, lineEnd: 1 },
        expect: EXPECT,
      },
    ],
  };
  const ex = extraction([
    block(0, 'heading', 'Install'),
    block(1, 'code', 'npm install @scope/acme-sdk', 'bash'),
  ]);
  return { target: targetFor('install-node', 'node'), extraction: ex, plan: planOf(ir), ir };
}

function planOf(ir: StepIR): MutationInput['plan'] {
  return {
    toolSlug: 'x',
    contentHash: 'a'.repeat(64),
    compilerVersion: 'test',
    model: 'test',
    ir,
    groundingReport: { ok: true, violations: [] },
    accepted: true,
    truncation: {
      truncated: false,
      totalBlocks: 0,
      includedBlocks: 0,
      omittedBlocks: 0,
      omittedBlockIndexes: [],
      clippedBlockIndexes: [],
    },
    createdAt: '2026-10-18T00:00:00.000Z',
  };
}
