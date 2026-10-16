import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Step, StepIR } from '@qsr/core';
import {
  CHECK_IDS,
  HARNESS_CHECK_KIND,
  NODE_CHECK_COMMAND,
  NODE_CHECK_SCRIPT,
  PYTHON_CHECK_COMMAND,
  PYTHON_CHECK_SCRIPT,
  checkableFiles,
  planChecks,
} from './checks.js';

// The check scripts are harness-owned: they are written here, run inside the sandbox container, and
// never come from the model or the docs. These tests run the very same scripts on the host, in a temp
// directory that plays the role of /work. The real-container run is in integration.test.ts.

const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 180 };
const write = (id: string, p: string, content = 'x'): Step => ({
  kind: 'write_file',
  id,
  path: p,
  content,
  source: SRC,
});
const append = (id: string, p: string): Step => ({
  kind: 'append_file',
  id,
  path: p,
  content: 'x',
  source: SRC,
});
const shell = (id: string, command: string): Step => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: EXPECT,
});
const run = (id: string, command: string): Step => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: EXPECT,
});
const plan = (steps: Step[], language: StepIR['language'] = 'node'): StepIR => ({
  irVersion: 1,
  language,
  projectInit: 'none',
  steps,
  maxLevelReachable: 3,
  notes: '',
});

// ---------------------------------------------------------------------------------------------
// Which files are checked, and when

describe('checkableFiles', () => {
  it('lists written source files by extension, once each, relative to /work', () => {
    const ir = plan([
      write('a', './index.js'),
      write('b', 'lib/util.mjs'),
      write('c', 'lib/old.cjs'),
      write('d', 'src/app.ts'),
      write('e', 'README.md'),
      write('f', 'package.json'),
      append('g', 'index.js'),
      write('h', 'src/app.tsx'),
    ]);
    expect(checkableFiles(ir)).toEqual(['index.js', 'lib/util.mjs', 'lib/old.cjs', 'src/app.ts']);
  });

  it('python: only .py files', () => {
    const ir = plan(
      [write('a', 'main.py'), write('b', 'pkg/mod.py'), write('c', 'x.txt')],
      'python',
    );
    expect(checkableFiles(ir)).toEqual(['main.py', 'pkg/mod.py']);
  });

  it('ignores a path the harness would refuse to write', () => {
    expect(checkableFiles(plan([write('a', '../escape.js'), write('b', '/etc/x.js')]))).toEqual([]);
  });
});

describe('planChecks', () => {
  it('is null when the plan writes no source file: there is nothing to prove importable', () => {
    expect(planChecks(plan([shell('s1', 'npm install acme'), run('s2', 'npx acme')]))).toBeNull();
    expect(planChecks(plan([write('s1', 'package.json')]))).toBeNull();
  });

  it('runs after the LAST write when no install follows it', () => {
    const p = planChecks(
      plan([
        shell('s1', 'npm install acme'),
        write('s2', 'a.js'),
        write('s3', 'b.js'),
        run('s4', 'node a.js'),
      ]),
    );
    expect(p?.afterIndex).toBe(2);
  });

  it('runs after the last install when that comes later, so installed packages can resolve', () => {
    const p = planChecks(
      plan([write('s1', 'a.js'), shell('s2', 'npm install acme'), run('s3', 'node a.js')]),
    );
    expect(p?.afterIndex).toBe(1);
  });

  it('is two harness-owned checks, syntax then imports, with fixed ids', () => {
    const p = planChecks(plan([write('s1', 'a.js'), write('s2', 'sub/b.mjs')]));
    expect(p?.checks.map((c) => c.id)).toEqual([CHECK_IDS.syntax, CHECK_IDS.imports]);
    expect(HARNESS_CHECK_KIND).toBe('harness_check');
    for (const c of p?.checks ?? []) {
      expect(c.stdin).toBe(NODE_CHECK_SCRIPT);
      // timeout wrapper, the interpreter, the mode, then the files as plain arguments (no shell parsing)
      expect(c.argv.slice(4)).toEqual([
        '60',
        ...NODE_CHECK_COMMAND,
        c === p?.checks[0] ? 'syntax' : 'imports',
        'a.js',
        'sub/b.mjs',
      ]);
      expect(c.argv[2]).toContain('qsr-harness-check');
    }
  });

  it('python uses the python script and interpreter', () => {
    const p = planChecks(plan([write('s1', 'main.py')], 'python'));
    expect(p?.checks[0]?.stdin).toBe(PYTHON_CHECK_SCRIPT);
    expect(p?.checks[0]?.argv.slice(5)).toEqual([...PYTHON_CHECK_COMMAND, 'syntax', 'main.py']);
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, run on the host

const here = createRequire(import.meta.url);
let tsDir: string | null = null;
try {
  tsDir = path.dirname(here.resolve('typescript/package.json'));
} catch {
  tsDir = null;
}

async function project(files: Record<string, string>, withTs = false): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'qsr-chk-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  if (withTs && tsDir !== null) {
    await mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await symlink(tsDir, path.join(dir, 'node_modules', 'typescript'), 'junction');
  }
  return dir;
}

interface Outcome {
  code: number | null;
  out: string;
}

function runNode(dir: string, mode: 'syntax' | 'imports', files: string[]): Outcome {
  const [cmd, ...args] = NODE_CHECK_COMMAND;
  const r = spawnSync(
    cmd === 'node' ? process.execPath : (cmd as string),
    [...args, mode, ...files],
    {
      cwd: dir,
      input: NODE_CHECK_SCRIPT,
      encoding: 'utf8',
      // pnpm/npx put the workspace on NODE_PATH; the container has no NODE_PATH.
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_PATH')),
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const pythonBin = ['python3', 'python'].find(
  (b) => spawnSync(b, ['--version'], { encoding: 'utf8' }).status === 0,
);
const maybePython = pythonBin === undefined ? describe.skip : describe;

function runPython(
  dir: string,
  mode: 'syntax' | 'imports',
  files: string[],
  env: Record<string, string> = {},
): Outcome {
  const [, ...args] = PYTHON_CHECK_COMMAND;
  const r = spawnSync(pythonBin as string, [...args, mode, ...files], {
    cwd: dir,
    input: PYTHON_CHECK_SCRIPT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('node syntax check', () => {
  it('passes valid CommonJS and ESM', async () => {
    const dir = await project({
      'a.js': 'const x = 1;\nconsole.log(x);\n',
      'b.mjs': "import fs from 'node:fs';\nconsole.log(typeof fs);\n",
      'c.cjs': "const fs = require('node:fs');\nconsole.log(fs);\n",
    });
    expect(runNode(dir, 'syntax', ['a.js', 'b.mjs', 'c.cjs'])).toMatchObject({ code: 0 });
  });

  it('fails a syntax error, naming the file and keeping the SyntaxError line', async () => {
    const dir = await project({ 'bad.js': 'const x = ;\nconsole.log(x)\n' });
    const r = runNode(dir, 'syntax', ['bad.js']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.js');
    expect(r.out).toMatch(/SyntaxError: Unexpected token/);
  });

  it('reports every broken file, not just the first', async () => {
    const dir = await project({ 'a.js': 'let = ;', 'b.js': 'function (', 'ok.js': '1' });
    const r = runNode(dir, 'syntax', ['a.js', 'b.js', 'ok.js']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a.js');
    expect(r.out).toContain('b.js');
  });

  it('ESM syntax in a .cjs file is a syntax error (CJS vs ESM)', async () => {
    const dir = await project({ 'x.cjs': "import fs from 'node:fs';\nconsole.log(fs);\n" });
    const r = runNode(dir, 'syntax', ['x.cjs']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SyntaxError/);
  });

  it('ESM syntax in a .js file of a package that says "type": "commonjs" is a syntax error', async () => {
    const dir = await project({
      'package.json': '{"type":"commonjs"}',
      'x.js': "import fs from 'node:fs';\nconsole.log(fs);\n",
    });
    expect(runNode(dir, 'syntax', ['x.js']).code).toBe(1);
  });

  it('ESM syntax in a .js file of a "type": "module" package is fine', async () => {
    const dir = await project({
      'package.json': '{"type":"module"}',
      'x.js': "import fs from 'node:fs';\nconsole.log(fs);\n",
    });
    expect(runNode(dir, 'syntax', ['x.js']).code).toBe(0);
  });

  it.runIf(tsDir !== null)(
    'TypeScript: checks syntax with tsc, keeps only syntax diagnostics (no type errors, no unresolved modules)',
    async () => {
      const dir = await project(
        {
          // a type error and an unresolvable module: neither is a syntax error
          'ok.ts':
            "import ms from 'unresolvable-mod';\nconst n: number = 'not a number';\nexport const f = (a: string): string => ms(a) + n;\n",
          'bad.ts': 'const x: = 1;\n',
        },
        true,
      );
      // A type error is NOT a syntax error: typechecking needs the quickstart's own tsconfig and @types.
      expect(runNode(dir, 'syntax', ['ok.ts']).code).toBe(0);
      const bad = runNode(dir, 'syntax', ['bad.ts']);
      expect(bad.code).toBe(1);
      expect(bad.out).toContain('bad.ts:1');
      expect(bad.out).toMatch(/SyntaxError: .* \(TS1\d{3}\)/);
    },
  );

  it('TypeScript with no tsc available is "cannot check" (exit 3), never a silent pass', async () => {
    const dir = await project({ 'a.ts': 'export const a = 1;\n' });
    const r = runNode(dir, 'syntax', ['a.ts']);
    // The container image carries typescript globally; a bare host may not. Either way it is never exit 1.
    expect([0, 3]).toContain(r.code);
    if (r.code === 3) expect(r.out).toContain('tsc');
  });
});

describe('node import check', () => {
  const modules = {
    'node_modules/acme/package.json': '{"name":"acme","version":"1.0.0","main":"index.js"}',
    'node_modules/acme/index.js': 'module.exports = {};\n',
    'node_modules/acme/sub.js': 'module.exports = {};\n',
    'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg","main":"main.js"}',
    'node_modules/@scope/pkg/main.js': 'module.exports = {};\n',
  };

  it('resolves node builtins with and without the node: prefix, including subpaths', async () => {
    const dir = await project({
      'a.mjs':
        "import fs from 'fs';\nimport p from 'node:path';\nimport fp from 'fs/promises';\nconsole.log(fs, p, fp);\n",
    });
    expect(runNode(dir, 'imports', ['a.mjs']).code).toBe(0);
  });

  it('resolves installed packages (plain, scoped, subpath) from node_modules', async () => {
    const dir = await project({
      ...modules,
      'a.mjs':
        "import a from 'acme';\nimport s from 'acme/sub.js';\nimport p from '@scope/pkg';\nconsole.log(a, s, p);\n",
      'b.cjs': "const a = require('acme');\nconst p = require('@scope/pkg');\nconsole.log(a, p);\n",
    });
    expect(runNode(dir, 'imports', ['a.mjs', 'b.cjs'])).toMatchObject({ code: 0 });
  });

  it('a deep import of a file an installed package does not have fails (ESM and CJS), one it has passes', async () => {
    const dir = await project({
      ...modules,
      'a.mjs': "import x from 'acme/sub.js';\nconsole.log(x);\n",
      'b.mjs': "import x from 'acme/gone.js';\nconsole.log(x);\n",
      'c.cjs': "const x = require('acme/gone');\nconsole.log(x);\n",
      'd.cjs': "const x = require('acme/sub');\nconsole.log(x);\n",
    });
    expect(runNode(dir, 'imports', ['a.mjs']).code).toBe(0);
    const esm = runNode(dir, 'imports', ['b.mjs']);
    expect(esm.code).toBe(1);
    expect(esm.out).toMatch(/Cannot find module '[^']*node_modules[\\/]acme[\\/]gone\.js'/);
    expect(runNode(dir, 'imports', ['c.cjs']).code).toBe(1);
    expect(runNode(dir, 'imports', ['d.cjs']).code).toBe(0);
  });

  it('ES modules cannot deep-import without the extension, CommonJS can', async () => {
    const dir = await project({
      ...modules,
      'a.mjs': "import x from 'acme/sub';\nconsole.log(x);\n",
      'b.cjs': "const x = require('acme/sub');\nconsole.log(x);\n",
    });
    expect(runNode(dir, 'imports', ['a.mjs']).code).toBe(1);
    expect(runNode(dir, 'imports', ['b.cjs']).code).toBe(0);
  });

  it('fails an import of a package that was never installed, naming it', async () => {
    const dir = await project({
      'a.mjs': "import { createClient } from 'never-installed-pkg';\ncreateClient();\n",
    });
    const r = runNode(dir, 'imports', ['a.mjs']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Cannot find package 'never-installed-pkg'");
    expect(r.out).toContain('a.mjs');
  });

  it('fails a require() of a package that was never installed', async () => {
    const dir = await project({ 'a.cjs': "const x = require('ghost-pkg');\nconsole.log(x);\n" });
    const r = runNode(dir, 'imports', ['a.cjs']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Cannot find package 'ghost-pkg'");
  });

  it('fails a scoped package that was never installed, naming the scoped name', async () => {
    const dir = await project({ 'a.mjs': "import x from '@nope/thing/deep';\nconsole.log(x);\n" });
    const r = runNode(dir, 'imports', ['a.mjs']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('@nope/thing');
  });

  it('a global package is not visible: resolution is from /work/node_modules only', async () => {
    const dir = await project({ 'a.mjs': "import 'tsx';\n" });
    expect(runNode(dir, 'imports', ['a.mjs']).code).toBe(1);
  });

  it('relative imports must exist: present files pass, missing files fail', async () => {
    const dir = await project({
      'lib/util.js': 'module.exports = 1;\n',
      'lib/index.js': 'module.exports = 2;\n',
      'data.json': '{}',
      'main.cjs':
        "require('./lib/util.js');\nrequire('./lib/util');\nrequire('./lib');\nrequire('./data.json');\n",
      'missing.cjs': "require('./lib/nope.js');\n",
      'missing-esm.mjs': "import x from './does-not-exist.mjs';\nconsole.log(x);\n",
    });
    expect(runNode(dir, 'imports', ['main.cjs']).code).toBe(0);
    const a = runNode(dir, 'imports', ['missing.cjs']);
    expect(a.code).toBe(1);
    expect(a.out).toContain("Cannot find module './lib/nope.js'");
    const b = runNode(dir, 'imports', ['missing-esm.mjs']);
    expect(b.code).toBe(1);
    expect(b.out).toContain("'./does-not-exist.mjs'");
  });

  it('ES modules need the full file name: an extensionless relative import fails in .mjs, passes in .cjs and .ts', async () => {
    const dir = await project({
      'util.js': 'module.exports = 1;\n',
      'util.ts': 'export const u = 1;\n',
      'a.mjs': "import u from './util';\nconsole.log(u);\n",
      'b.cjs': "const u = require('./util');\nconsole.log(u);\n",
      'c.ts': "import { u } from './util';\nconsole.log(u);\n",
    });
    const esm = runNode(dir, 'imports', ['a.mjs']);
    expect(esm.code).toBe(1);
    expect(esm.out).toContain('full file name');
    expect(runNode(dir, 'imports', ['b.cjs']).code).toBe(0);
    expect(runNode(dir, 'imports', ['c.ts']).code).toBe(0);
  });

  it('a relative ./x.js import is satisfied by x.ts (TypeScript ESM convention)', async () => {
    const dir = await project({
      'x.ts': 'export const x = 1;\n',
      'main.ts': "import { x } from './x.js';\nconsole.log(x);\n",
    });
    expect(runNode(dir, 'imports', ['main.ts']).code).toBe(0);
  });

  it('resolves relative to the importing file, not to /work', async () => {
    const dir = await project({
      'src/helper.js': 'module.exports = 1;\n',
      'src/main.cjs': "require('./helper.js');\n",
      'broken/main.cjs': "require('./helper.js');\n",
    });
    expect(runNode(dir, 'imports', ['src/main.cjs']).code).toBe(0);
    expect(runNode(dir, 'imports', ['broken/main.cjs']).code).toBe(1);
  });

  it('dynamic import() and non-literal require() are NOT checked (documented limit)', async () => {
    const dir = await project({
      'a.mjs':
        "const m = await import('never-installed-dynamic');\nconst name = 'also-missing';\nconst n = await import(name);\nconsole.log(m, n);\n",
      'b.cjs': "const name = 'x-missing';\nrequire(name);\n",
    });
    expect(runNode(dir, 'imports', ['a.mjs', 'b.cjs']).code).toBe(0);
  });

  it('ignores specifiers in comments and type-only imports', async () => {
    const dir = await project({
      'a.ts':
        "// import x from 'commented-out'\n/* const y = require('also-commented') */\nimport type { T } from 'types-only-pkg';\nexport type U = T;\n",
    });
    expect(runNode(dir, 'imports', ['a.ts']).code).toBe(0);
  });

  it('checks multi-line imports and re-exports', async () => {
    const dir = await project({
      'a.mjs':
        "import {\n  one,\n  two,\n} from 'multi-line-missing';\nexport * from './nope.mjs';\n",
    });
    const r = runNode(dir, 'imports', ['a.mjs']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('multi-line-missing');
    expect(r.out).toContain('./nope.mjs');
  });

  it('package.json "imports" aliases (#internal) are not resolvable here and are left alone', async () => {
    const dir = await project({ 'a.mjs': "import x from '#internal/thing';\nconsole.log(x);\n" });
    expect(runNode(dir, 'imports', ['a.mjs']).code).toBe(0);
  });

  it('require() in an ES module is a failure (ESM vs CJS): .mjs, and .js under "type": "module"', async () => {
    const dir = await project({
      ...modules,
      'package.json': '{"type":"module"}',
      'a.mjs': "const a = require('acme');\nconsole.log(a);\n",
      'b.js': "const a = require('acme');\nconsole.log(a);\n",
    });
    for (const f of ['a.mjs', 'b.js']) {
      const r = runNode(dir, 'imports', [f]);
      expect(r.code, f).toBe(1);
      expect(r.out).toContain('require is not defined in ES module scope');
    }
  });

  it('require() is fine in .cjs, in a plain CJS .js, and in an ES module that makes its own require', async () => {
    const dir = await project({
      ...modules,
      'a.cjs': "const a = require('acme');\nconsole.log(a);\n",
      'b.js': "const a = require('acme');\nconsole.log(a);\n",
      'c.mjs':
        "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst a = require('acme');\nconsole.log(a);\n",
    });
    expect(runNode(dir, 'imports', ['a.cjs', 'b.js', 'c.mjs'])).toMatchObject({ code: 0 });
  });

  it('a .js file that mixes import syntax is treated as ESM, so a require() in it fails', async () => {
    const dir = await project({
      ...modules,
      'a.js': "import fs from 'node:fs';\nconst a = require('acme');\nconsole.log(fs, a);\n",
    });
    expect(runNode(dir, 'imports', ['a.js']).code).toBe(1);
  });

  it('a file that does not exist is reported, not crashed on', async () => {
    const dir = await project({});
    const r = runNode(dir, 'imports', ['gone.js']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('gone.js');
  });
});

maybePython('python syntax check', () => {
  it('passes valid code', async () => {
    const dir = await project({ 'a.py': 'import os\nprint(os.name)\n' });
    expect(runPython(dir, 'syntax', ['a.py'])).toMatchObject({ code: 0 });
  });

  it('fails a syntax error with py_compile output', async () => {
    const dir = await project({ 'bad.py': 'def f(:\n    pass\n' });
    const r = runPython(dir, 'syntax', ['bad.py']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('bad.py');
    expect(r.out).toContain('SyntaxError');
  });

  it('reports every broken file', async () => {
    const dir = await project({ 'a.py': 'x = (', 'b.py': 'class :', 'ok.py': 'x = 1\n' });
    const r = runPython(dir, 'syntax', ['a.py', 'b.py', 'ok.py']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a.py');
    expect(r.out).toContain('b.py');
  });

  it('does not leave bytecode behind', async () => {
    const dir = await project({ 'a.py': 'x = 1\n' });
    runPython(dir, 'syntax', ['a.py']);
    const listing = spawnSync(
      pythonBin as string,
      ['-c', "import os;print(os.path.exists('__pycache__'))"],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    expect(listing.stdout.trim()).toBe('False');
  });
});

maybePython('python import check', () => {
  it('standard library imports pass, including submodules and __future__', async () => {
    const dir = await project({
      'a.py':
        'from __future__ import annotations\nimport os.path\nimport json, sys\nfrom collections import abc\nprint(os, json, sys, abc)\n',
    });
    expect(runPython(dir, 'imports', ['a.py'])).toMatchObject({ code: 0 });
  });

  it('fails an import of a module that was never installed, naming it', async () => {
    const dir = await project({ 'a.py': 'import never_installed_mod\n' });
    const r = runPython(dir, 'imports', ['a.py']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("No module named 'never_installed_mod'");
    expect(r.out).toContain('a.py');
  });

  it('checks the top-level package of `from x.y import z` and of `import x.y`', async () => {
    const dir = await project({
      'a.py': 'from ghost.sub import thing\n',
      'b.py': 'import phantom.sub\n',
    });
    expect(runPython(dir, 'imports', ['a.py']).out).toContain("'ghost'");
    expect(runPython(dir, 'imports', ['b.py']).out).toContain("'phantom'");
  });

  it('an installed package passes (found on the interpreter path)', async () => {
    const dir = await project({
      'a.py': 'import fakeinstalled\n',
      'site/fakeinstalled/__init__.py': '',
    });
    expect(runPython(dir, 'imports', ['a.py'], { PYTHONPATH: path.join(dir, 'site') }).code).toBe(
      0,
    );
  });

  it('a module written next to the importing file passes, one that was not written fails', async () => {
    const dir = await project({
      'app/main.py': 'import helper\nimport also_missing\n',
      'app/helper.py': 'x = 1\n',
    });
    const r = runPython(dir, 'imports', ['app/main.py']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("'also_missing'");
    expect(r.out).not.toContain("'helper'");
  });

  it('a local package under /work passes', async () => {
    const dir = await project({
      'main.py': 'import mypkg\nfrom mypkg import sub\n',
      'mypkg/__init__.py': '',
      'mypkg/sub.py': '',
    });
    expect(runPython(dir, 'imports', ['main.py']).code).toBe(0);
  });

  it('relative imports must point at something written', async () => {
    const dir = await project({
      'pkg/a.py': 'from . import b\nfrom .b import thing\nfrom .gone import nothing\n',
      'pkg/b.py': 'thing = 1\n',
      'pkg/__init__.py': '',
      'pkg/c.py': 'from ..up import nothing\n',
    });
    const r = runPython(dir, 'imports', ['pkg/a.py', 'pkg/c.py']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('.gone');
    expect(r.out).toContain('..up');
    expect(r.out).not.toContain("'.b'");
  });

  it('an import guarded by except ImportError (or Exception, or bare except) is optional and not a failure', async () => {
    const dir = await project({
      'a.py': [
        'try:',
        '    import tomllib',
        '    import optional_one',
        'except ImportError:',
        '    tomllib = None',
        'try:',
        '    import optional_two',
        'except (ImportError, OSError):',
        '    pass',
        'try:',
        '    import optional_three',
        'except Exception:',
        '    pass',
        'try:',
        '    import optional_four',
        'except:',
        '    pass',
        'try:',
        '    import optional_five',
        'except ModuleNotFoundError:',
        '    pass',
        '',
      ].join('\n'),
    });
    expect(runPython(dir, 'imports', ['a.py'])).toMatchObject({ code: 0 });
  });

  it('a try/except that handles something else does NOT make the import optional', async () => {
    const dir = await project({
      'a.py': 'try:\n    import needed_mod\nexcept ValueError:\n    pass\n',
    });
    expect(runPython(dir, 'imports', ['a.py']).code).toBe(1);
  });

  it('imports inside functions are static imports too', async () => {
    const dir = await project({ 'a.py': 'def f():\n    import inside_fn_missing\n' });
    expect(runPython(dir, 'imports', ['a.py']).code).toBe(1);
  });

  it('dynamic importlib.import_module and __import__ are NOT checked (documented limit)', async () => {
    const dir = await project({
      'a.py':
        "import importlib\nimportlib.import_module('dyn_missing')\n__import__('dyn_missing2')\n",
    });
    expect(runPython(dir, 'imports', ['a.py']).code).toBe(0);
  });

  it('does not execute the file under test or the packages it imports', async () => {
    const dir = await project({
      'a.py': "import sentinel_pkg\nopen('RAN', 'w').write('x')\n",
      'site/sentinel_pkg/__init__.py': "open('PKG_RAN', 'w').write('x')\n",
    });
    runPython(dir, 'imports', ['a.py'], { PYTHONPATH: path.join(dir, 'site') });
    const probe = spawnSync(
      pythonBin as string,
      ['-c', "import os;print(os.path.exists('RAN'), os.path.exists('PKG_RAN'))"],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(probe.stdout.trim()).toBe('False False');
  });
});
