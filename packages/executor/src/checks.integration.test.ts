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

    // Harness version 2 (P9d). "node --check" exits 0 for a .js file that uses import when no package.json says "type": "module":
    // Node detects the module syntax and then checks nothing. Found by the mutation tests on mocha-node and vitest-node, whose plans
    // write their own package.json (so the harness does not add the type).
    describe('harness v2: an ES-module .js file is parsed as a module', () => {
      const PACKAGE_JSON = '{\n  "scripts": { "test": "mocha" }\n}';
      const BROKEN =
        'import assert from "node:assert";\n\ndescribe("Array", function () {\n  describe("#indexOf()", function ( {\n    it("works", function () {\n      assert.equal(1, 1);\n    });\n  });\n});\n';
      const FINE = BROKEN.replace('function ( {', 'function () {');

      it('REGRESSION (the mocha-node syntax mutant): a deliberately broken ES-module .js file FAILS the syntax check', async () => {
        const r = await execute('node', [
          shell('s1', 'npm install ms'),
          write('s2', 'package.json', PACKAGE_JSON),
          write('s3', 'test/example.test.js', BROKEN),
        ]);
        expect(r).toMatchObject({
          outcome: 'FAIL',
          failedStepId: 'qsr-check-syntax',
          reachedLevel: 1,
        });
        expect(failure(r)).toContain('SyntaxError');
        expect(failure(r)).toContain('test/example.test.js');
        expect(r.harnessVersion).toBe(2);
      }, 240_000);

      it('the same file, correct, passes the syntax check and the plan reaches level 2', async () => {
        const r = await execute('node', [
          shell('s1', 'npm install ms'),
          write('s2', 'package.json', PACKAGE_JSON),
          write('s3', 'test/example.test.js', FINE),
        ]);
        expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      }, 240_000);

      it('a broken CommonJS .js file still fails exactly as before, and a correct one still passes', async () => {
        const bad = await execute('node', [
          shell('s1', 'npm install ms'),
          write('s2', 'a.js', 'const ms = require("ms");\nfoo(function () {\n  bar(;\n});\n'),
        ]);
        expect(bad).toMatchObject({ outcome: 'FAIL', failedStepId: 'qsr-check-syntax' });
        const good = await execute('node', [
          shell('s1', 'npm install ms'),
          write('s2', 'a.js', 'const ms = require("ms");\nconsole.log(ms(1000));\n'),
        ]);
        expect(good).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      }, 480_000);
    });

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

    // Harness version 2 (P9d): the full dotted path of an import must resolve. Which class this is: the Python imports check reports
    // "No module named 'pkg.sub'", which the classifier maps to API_DRIFT (check.python_submodule_missing), the same class as a Node
    // deep import into an installed package (check.deep_import_missing): the package is installed, a path inside it is gone.
    describe('harness v2: a dotted import resolves all the way', () => {
      it('REGRESSION (the python deep_import mutant): import pkg.missing, and from pkg.missing import x, FAIL at the imports check', async () => {
        for (const code of [
          'import idna.qsr_missing\nprint(1)\n',
          'from idna.qsr_missing import x\nprint(1)\n',
        ]) {
          const r = await execute('python', [
            shell('s1', 'pip install idna'),
            write('s2', 'main.py', code),
          ]);
          expect(r, code).toMatchObject({
            outcome: 'FAIL',
            failedStepId: 'qsr-check-imports',
            reachedLevel: 1,
          });
          expect(failure(r)).toContain("No module named 'idna.qsr_missing'");
          expect(r.harnessVersion).toBe(2);
        }
      }, 480_000);

      it('a real submodule, a standard-library dotted import, and a package that builds submodules at run time (six.moves) all pass', async () => {
        const r = await execute('python', [
          shell('s1', 'pip install six'),
          write(
            's2',
            'main.py',
            'import os.path\nimport xml.etree.ElementTree\nimport concurrent.futures\nfrom urllib.parse import urlparse\nimport importlib.util\nfrom six.moves import urllib\nprint(1)\n',
          ),
        ]);
        expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      }, 240_000);

      it('a package that registers submodules at run time (a local pkg/__init__.py writing sys.modules) is not reported missing, because a missing file proves nothing there', async () => {
        const r = await execute('python', [
          shell('s1', 'pip install idna'),
          write(
            's2',
            'pkg/__init__.py',
            'import sys\nimport types\n\nsys.modules[__name__ + ".dyn"] = types.ModuleType("dyn")\n',
          ),
          write('s3', 'main.py', 'import pkg.dyn\nprint(pkg.dyn)\n'),
        ]);
        expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      }, 240_000);

      it('a dotted import of a submodule a written local package really has passes, and one it lacks fails', async () => {
        const ok = await execute('python', [
          shell('s1', 'pip install idna'),
          write('s2', 'pkg/__init__.py', ''),
          write('s3', 'pkg/real.py', 'X = 1\n'),
          write('s4', 'main.py', 'import pkg.real\nprint(pkg.real.X)\n'),
        ]);
        expect(ok).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
        const bad = await execute('python', [
          shell('s1', 'pip install idna'),
          write('s2', 'pkg/__init__.py', ''),
          write('s3', 'main.py', 'import pkg.gone\n'),
        ]);
        expect(bad).toMatchObject({ outcome: 'FAIL', failedStepId: 'qsr-check-imports' });
      }, 480_000);

      it('a dotted import inside try/except ImportError is optional', async () => {
        const r = await execute('python', [
          shell('s1', 'pip install idna'),
          write(
            's2',
            'main.py',
            'try:\n    import idna.qsr_missing\nexcept ImportError:\n    idna = None\nprint(1)\n',
          ),
        ]);
        expect(r).toMatchObject({ outcome: 'PASS', reachedLevel: 2 });
      }, 240_000);
    });

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
