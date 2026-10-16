import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunResult, Step, StepIR } from '@qsr/core';
import { createDockerCli } from './docker-cli.js';
import { executePlan } from './execute.js';

// The harness checks, adversarially, inside the REAL sandbox images: this is where "level 2 means the
// snippet imports or compiles" is proven rather than assumed. Skips without Docker unless
// QSR_REQUIRE_DOCKER=1 (CI), exactly like integration.test.ts.

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const IMAGES = { node: 'qsr-node:local', python: 'qsr-python:local' } as const;

async function dockerUp(): Promise<boolean> {
  try {
    await run('docker', ['info'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const available = process.env['QSR_SKIP_DOCKER_TESTS'] !== '1' && (await dockerUp());

const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 120 };
const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const shell = (id: string, command: string): Step => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: EXPECT,
});
const runStep = (id: string, command: string): Step => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: EXPECT,
});
const write = (id: string, p: string, content: string): Step => ({
  kind: 'write_file',
  id,
  path: p,
  content,
  source: SRC,
});

let counter = 0;
async function execute(
  language: 'node' | 'python',
  steps: Step[],
  projectInit?: StepIR['projectInit'],
) {
  const ir: StepIR = {
    irVersion: 1,
    language,
    projectInit: projectInit ?? (language === 'node' ? 'npm_init' : 'python_venv'),
    steps,
    maxLevelReachable: 3,
    notes: '',
  };
  return executePlan(
    {
      target: {
        slug: `chk-${language}`,
        language,
        level: 3,
        placeholders: {},
        expect: { authErrorIsPass: false, timeoutSec: 300 },
      },
      ir,
      image: IMAGES[language],
      outDir: await mkdtemp(path.join(tmpdir(), 'qsr-chk-int-')),
      cycleId: '3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60',
      attempt: 1,
      planId: null,
      snapshotHash: null,
    },
    { docker: createDockerCli(), runId: `chk${process.pid}x${++counter}` },
  );
}
const stepNamed = (r: RunResult, id: string) => r.steps.find((s) => s.stepId === id);
const failure = (r: RunResult): string => stepNamed(r, r.failedStepId ?? '')?.stderrTail ?? '';

describe.skipIf(!available)('harness checks in the real sandbox images', () => {
  beforeAll(async () => {
    for (const [language, tag] of Object.entries(IMAGES)) {
      try {
        await run('docker', ['image', 'inspect', tag]);
      } catch {
        await run(
          'docker',
          [
            'build',
            '-q',
            '-f',
            path.join(REPO, `docker/${language}.Dockerfile`),
            '-t',
            tag,
            path.join(REPO, 'docker'),
          ],
          { timeout: 600_000 },
        );
      }
    }
  }, 1_300_000);

  describe('node', () => {
    it('a syntax error: FAIL at the syntax check, level 1, and the run step never starts', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.js', 'const ms = ;\nconsole.log(ms)'),
        runStep('s3', 'node index.js'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-syntax',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain('index.js');
      expect(failure(r)).toMatch(/SyntaxError/);
      expect(stepNamed(r, 's3')).toBeUndefined();
    }, 240_000);

    it('an import of a module that was never installed: FAIL at the imports check, level 1', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write(
          's2',
          'index.js',
          "const { createClient } = require('never-installed-pkg');\ncreateClient();",
        ),
        runStep('s3', 'node index.js'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-imports',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain("Cannot find package 'never-installed-pkg'");
      expect(stepNamed(r, 'qsr-check-syntax')?.outcome).toBe('PASS');
    }, 240_000);

    it('a relative import to a file the docs never write: FAIL, level 1', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.js', "const helper = require('./helper');\nconsole.log(helper);"),
        runStep('s3', 'node index.js'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-imports',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain("Cannot find module './helper'");
    }, 240_000);

    it('a deep import of a file the installed package does not have: FAIL at the imports check, level 1', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.mjs', "import x from 'ms/dist/gone.js';\nconsole.log(x);"),
        runStep('s3', 'node index.mjs'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-imports',
        reachedLevel: 1,
      });
      expect(failure(r)).toMatch(/Cannot find module '[^']*node_modules\/ms\/dist\/gone\.js'/);
    }, 240_000);

    it('an installed package resolves; the run then reaches level 3', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.js', "const ms = require('ms');\nconsole.log('ms ok', ms('2 days'));"),
        runStep('s3', 'node index.js'),
      ]);
      expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
      expect(r.steps.map((s) => s.stepId)).toEqual([
        's1',
        's2',
        'qsr-check-syntax',
        'qsr-check-imports',
        's3',
      ]);
    }, 240_000);

    it('a dynamic import() of a missing module is NOT caught by the checks (documented limit): L2, then the run fails', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write(
          's2',
          'index.js',
          "import('never-installed-dynamic').catch((e) => { console.error(e.message); process.exit(1); });",
        ),
        runStep('s3', 'node index.js'),
      ]);
      expect(stepNamed(r, 'qsr-check-imports')?.outcome).toBe('PASS');
      expect(r).toMatchObject({ outcome: 'FAIL', failedStepId: 's3', reachedLevel: 2 });
    }, 240_000);

    it('ESM vs CJS: require() in a file the harness had to make ESM fails the imports check', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        // index.js uses ESM syntax, so the harness sets "type": "module"; helper.js then cannot require().
        write('s2', 'index.js', "import ms from 'ms';\nconsole.log(ms('1h'));"),
        write('s3', 'helper.js', "const ms = require('ms');\nconsole.log(ms('1h'));"),
        runStep('s4', 'node index.js'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-imports',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain('require is not defined in ES module scope');
    }, 240_000);

    it('ESM vs CJS: import syntax in a .cjs file fails the syntax check', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.cjs', "import ms from 'ms';\nconsole.log(ms('1h'));"),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-syntax',
        reachedLevel: 1,
      });
    }, 240_000);

    it('ESM vs CJS: a CommonJS .js file and an ESM .mjs file both pass', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'a.js', "const ms = require('ms');\nconsole.log(ms('1h'));"),
        write('s3', 'b.mjs', "import ms from 'ms';\nconsole.log(ms('1h'));"),
      ]);
      expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    }, 240_000);

    it('TypeScript: syntax is checked with the typescript package in the image, types are not', async () => {
      const ok = await execute('node', [
        shell('s1', 'npm install ms'),
        write(
          's2',
          'index.ts',
          "import ms from 'ms';\nconst n: number = ms('1h');\nconsole.log(n);",
        ),
      ]);
      expect(ok).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      const bad = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.ts', 'const x: = 1;\nconsole.log(x);'),
      ]);
      expect(bad).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-syntax',
        reachedLevel: 1,
      });
    }, 300_000);

    it('a global module (tsx, typescript are installed globally in the image) does not satisfy an import', async () => {
      const r = await execute('node', [
        shell('s1', 'npm install ms'),
        write('s2', 'index.mjs', "import 'tsx';"),
      ]);
      expect(r).toMatchObject({ outcome: 'FAIL', failedStepId: 'qsr-check-imports' });
    }, 240_000);
  });

  describe('python', () => {
    it('a syntax error: FAIL at py_compile, level 1', async () => {
      const r = await execute('python', [
        shell('s1', 'pip install six'),
        write('s2', 'main.py', 'def f(:\n    pass\n'),
        runStep('s3', 'python main.py'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-syntax',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain('SyntaxError');
      expect(stepNamed(r, 's3')).toBeUndefined();
    }, 240_000);

    it('an import of a module that was never installed: FAIL at find_spec, level 1', async () => {
      const r = await execute('python', [
        shell('s1', 'pip install six'),
        write('s2', 'main.py', 'import never_installed_mod\nprint(1)\n'),
        runStep('s3', 'python main.py'),
      ]);
      expect(r).toMatchObject({
        outcome: 'FAIL',
        failedStepId: 'qsr-check-imports',
        reachedLevel: 1,
      });
      expect(failure(r)).toContain("No module named 'never_installed_mod'");
    }, 240_000);

    it('an installed package, the stdlib and a written local module pass; the run reaches level 3', async () => {
      const r = await execute('python', [
        shell('s1', 'pip install six'),
        write('s2', 'helper.py', 'VALUE = 41\n'),
        write(
          's3',
          'main.py',
          'import json\nimport six\nimport helper\nprint("py ok", helper.VALUE + 1, six.PY3, json.dumps(1))\n',
        ),
        runStep('s4', 'python main.py'),
      ]);
      expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 3 });
    }, 240_000);

    it('an import guarded by except ImportError is optional; a dynamic import is not checked', async () => {
      const r = await execute('python', [
        shell('s1', 'pip install six'),
        write(
          's2',
          'main.py',
          "import importlib\ntry:\n    import nothing_here\nexcept ImportError:\n    nothing_here = None\nprint(importlib.util.find_spec('x'))\n",
        ),
      ]);
      expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
    }, 240_000);

    it('leaves no bytecode in /work', async () => {
      const r = await execute('python', [
        shell('s1', 'pip install six'),
        write('s2', 'main.py', 'print(1)\n'),
        shell('s3', 'test ! -e /work/__pycache__'),
      ]);
      expect(r).toMatchObject({ outcome: 'PASS' });
    }, 240_000);
  });
});
