import { contentHash, type Extraction, type ExtractionBlock } from '@qsr/core';

// A small docs page and the plan a model would return for it. The plan is verbatim from the page, so the
// real grounding validator accepts it.

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

export function docsBlocks(extra: ExtractionBlock[] = []): ExtractionBlock[] {
  return [
    block(0, 'heading', 'Quickstart'),
    block(1, 'prose', 'Install the package.'),
    block(2, 'code', 'npm install acme-sdk', 'bash'),
    block(3, 'prose', 'Create a file named index.js and add the following:'),
    block(
      4,
      'code',
      "const acme = require('acme-sdk');\nconsole.log(typeof acme);",
      'js',
      'index.js',
    ),
    ...extra,
  ];
}

export function docsExtraction(
  over: { blocks?: ExtractionBlock[]; slug?: string } = {},
): Extraction {
  const blocks = over.blocks ?? docsBlocks();
  const url = `https://docs.example.com/${over.slug ?? 'acme-node'}`;
  return {
    url,
    finalUrl: url,
    title: 'Acme quickstart',
    fetchedAt: '2026-10-16T11:59:00.000Z',
    blocks,
    contentHash: contentHash(blocks),
  };
}

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };

/** A correct plan for docsExtraction() at level 3. */
export function goodPlanJson(): string {
  return JSON.stringify({
    irVersion: 1,
    language: 'node',
    projectInit: 'npm_init',
    maxLevelReachable: 3,
    notes: 'install, write the file, run it',
    steps: [
      {
        kind: 'shell',
        id: 's1',
        command: 'npm install acme-sdk',
        source: { blockIndex: 2, lineStart: 1, lineEnd: 1 },
        expect: EXPECT,
      },
      {
        kind: 'write_file',
        id: 's2',
        path: 'index.js',
        content: '',
        source: { blockIndex: 4, lineStart: 1, lineEnd: 2 },
      },
      { kind: 'run', id: 's3', command: 'node index.js', source: null, expect: EXPECT },
    ],
  });
}

/** Valid JSON that is not a plan: the compiler retries once, then rejects. */
export const garbagePlanJson = (): string => JSON.stringify({ hello: 'world' });

// ---- RunResult builders (spec section 9)

import { RunResult, type StepResult } from '@qsr/core';

export const step = (
  stepId: string,
  ordinal: number,
  kind: string,
  over: Partial<StepResult> = {},
): StepResult => ({
  stepId,
  ordinal,
  kind,
  outcome: 'PASS',
  exitCode: 0,
  durationMs: 1200,
  stdoutTail: null,
  stderrTail: null,
  logFile: `slug-1/${String(ordinal).padStart(2, '0')}-${stepId}.log`,
  matchedAuthPattern: null,
  skipReason: null,
  ...over,
});

export function runResult(
  over: Partial<RunResult> & { cycleId: string; toolSlug?: string },
): RunResult {
  return RunResult.parse({
    toolSlug: 'acme-node',
    attempt: 1,
    planId: null,
    snapshotHash: null,
    outcome: 'PASS',
    reachedLevel: 3,
    failedStepId: null,
    steps: [step('s1', 0, 'shell'), step('s2', 1, 'write_file'), step('s3', 2, 'run')],
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runnerEnv: { node: 'v22.1.0', resolved: JSON.stringify({ 'acme-sdk': '1.0.0' }) },
    startedAt: '2026-10-16T11:58:00.000Z',
    finishedAt: '2026-10-16T11:58:05.000Z',
    ...over,
  });
}

/** A run that failed at its run step with this stderr. */
export function failedRun(
  cycleId: string,
  stderr: string,
  over: Partial<RunResult> = {},
  slug = 'acme-node',
): RunResult {
  return runResult({
    cycleId,
    toolSlug: slug,
    outcome: 'FAIL',
    reachedLevel: 2,
    failedStepId: 's3',
    steps: [
      step('s1', 0, 'shell'),
      step('s2', 1, 'write_file'),
      step('s3', 2, 'run', { outcome: 'FAIL', exitCode: 1, stderrTail: stderr }),
    ],
    ...over,
  });
}

export const DRIFT_STDERR =
  'TypeError: acme.createClient is not a function\n    at Object.<anonymous> (/work/index.js:3:1)\n';
export const E404_STDERR =
  'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/acme-sdk - Not found\n';
