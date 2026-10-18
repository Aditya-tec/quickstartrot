import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { NODE_CHECK_SCRIPT, PYTHON_CHECK_SCRIPT } from './check-scripts.js';

// The experimental export check and the two harness-v2 fixes, run as the real scripts on the host against tiny fake packages: no
// Docker and no network. (checks.integration.test.ts runs the same scripts inside the sandbox images.)

let dir: string;
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const node = (mode: 'syntax' | 'imports' | 'exports', ...files: string[]) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-', mode, ...files], {
    cwd: dir,
    input: NODE_CHECK_SCRIPT,
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'qsr-exports-'));
  // an ES-module package that exports a value and (like LaunchDarkly's) nothing for the TypeScript types
  put(
    'node_modules/ld/package.json',
    '{"name":"ld","version":"1.0.0","type":"module","exports":"./index.js"}',
  );
  put('node_modules/ld/index.js', 'export const init = () => 1;\nexport class Observability {}\n');
  // a CommonJS package
  put('node_modules/cjs/package.json', '{"name":"cjs","version":"1.0.0","main":"index.js"}');
  put('node_modules/cjs/index.js', 'module.exports = { make: () => 1 };\n');
  // a package that tries the network the moment it is loaded
  put('node_modules/chatty/package.json', '{"name":"chatty","version":"1.0.0","main":"index.js"}');
  put(
    'node_modules/chatty/index.js',
    "require('node:https').get('https://example.com');\nmodule.exports = { ok: 1 };\n",
  );
});

describe('qsr-check-exports (node)', () => {
  it('a name the package exports passes, and one it does not is reported with its package and name', () => {
    put('good.mjs', "import { init, Observability as O } from 'ld';\nconsole.log(init(), O);\n");
    put('bad.mjs', "import { init, Gone } from 'ld';\nconsole.log(init(), Gone);\n");
    expect(node('exports', 'good.mjs')).toMatchObject({ code: 0 });
    const bad = node('exports', 'bad.mjs');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("bad.mjs:1: qsr-check-exports: 'ld' does not export 'Gone'");
  });

  it('a destructured require is checked too', () => {
    put('c1.js', "const { make } = require('cjs');\nconsole.log(make());\n");
    put('c2.js', "const { make, nope } = require('cjs');\nconsole.log(make(), nope);\n");
    expect(node('exports', 'c1.js').code).toBe(0);
    expect(node('exports', 'c2.js').out).toContain("'cjs' does not export 'nope'");
  });

  it('REGRESSION (launchdarkly-node, the P9c false positive): TypeScript that imports types and uses them only as types passes', () => {
    put(
      'ts1.ts',
      "import { init, LDContext, LDOptions } from 'ld';\nconst context: LDContext = { kind: 'user' };\nconst options: LDOptions = {};\nconsole.log(init(), context, options);\n",
    );
    const r = node('exports', 'ts1.ts');
    expect(r, r.out).toMatchObject({ code: 0 });
    // and the same when the extension says .js but the code is TypeScript (an inline type modifier, or an annotation)
    put('ts2.js', "import { init, type LDContext } from 'ld';\nconsole.log(init());\n");
    put(
      'ts3.js',
      "import { init, LDContext } from 'ld';\nconst c: LDContext = {};\nconsole.log(init(), c);\n",
    );
    expect(node('exports', 'ts2.js').code).toBe(0);
    expect(node('exports', 'ts3.js').code).toBe(0);
  });

  it('REGRESSION (drizzle-node renamed_symbol): a renamed name CALLED as an object property value (key: name(...)) is a value, not a type annotation', () => {
    put(
      'ts-prop.ts',
      "import { init, initQsr } from 'ld';\nexport const table = { id: init(), name: initQsr({ length: 255 }) };\n",
    );
    const r = node('exports', 'ts-prop.ts');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("'ld' does not export 'initQsr'");
    // a type annotation that happens to look like a call is still not mistaken: a name only ever in a type position passes
    put(
      'ts-ann.ts',
      "import { init, LDContext } from 'ld';\nconst c: LDContext = {};\nconsole.log(init(), c);\n",
    );
    expect(node('exports', 'ts-ann.ts').code).toBe(0);
  });

  it('TypeScript is still checked for the names it uses as VALUES', () => {
    put(
      'ts4.ts',
      "import { init, gone } from 'ld';\nconst n: number = 1;\nconsole.log(init(), gone(), n);\n",
    );
    const r = node('exports', 'ts4.ts');
    expect(r.code).toBe(1);
    expect(r.out).toContain("'ld' does not export 'gone'");
    expect(r.out).not.toContain('number');
  });

  it('the exact LaunchDarkly snippet has NO TypeScript signal (an untagged fence, imports only), so it reads as JavaScript and its types are reported: why that target opts out (harness.skipExportCheck)', () => {
    put(
      'exact.js',
      "import { init, LDContext, LDOptions } from 'ld';\n\n// optional observability plugin, requires Node.js (server-side) SDK v9.10+\nimport { Observability } from 'ld';\nconst client = init('YOUR_SDK_KEY', { plugins: [new Observability()] });\n",
    );
    const r = node('exports', 'exact.js');
    expect(r.code).toBe(1);
    expect(r.out).toContain("'ld' does not export 'LDContext'");
    expect(r.out).toContain("'ld' does not export 'LDOptions'");
    expect(r.out).not.toContain("does not export 'init'");
    expect(r.out).not.toContain("does not export 'Observability'");
  });

  it('a package that tries the network when it loads is not reported: it is "not checked", and nothing leaves the process', () => {
    put('net.js', "const { ok, missing } = require('chatty');\nconsole.log(ok, missing);\n");
    const r = node('exports', 'net.js');
    expect(r.code).toBe(0);
    expect(r.out).toContain('not checked');
    expect(r.out).toContain('the network is blocked');
  });

  it('relative imports, builtins and files with no named import are left alone', () => {
    put('plain.js', "import fs from 'node:fs';\nimport def from 'ld';\nconsole.log(fs, def);\n");
    expect(node('exports', 'plain.js').code).toBe(0);
  });
});

describe('harness v2: the syntax check parses an ES-module .js file as a module', () => {
  const BROKEN =
    'import assert from "node:assert";\n\ndescribe("Array", function () {\n  describe("#indexOf()", function ( {\n    it("works", function () {\n      assert.equal(1, 1);\n    });\n  });\n});\n';

  it('REGRESSION (the mocha-node and vitest-node syntax mutants): a deliberately broken ES-module .js file now FAILS', () => {
    put('esm-broken/package.json', '{"scripts":{"test":"mocha"}}');
    put('esm-broken/example.test.js', BROKEN);
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-', 'syntax', 'example.test.js'],
      { cwd: path.join(dir, 'esm-broken'), input: NODE_CHECK_SCRIPT, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('SyntaxError');
    expect(`${r.stdout}${r.stderr}`).toContain('example.test.js');
  });

  it('the same file, repaired, passes; a CommonJS file and an .mjs file behave as they always did', () => {
    put('esm-ok/package.json', '{"scripts":{"test":"mocha"}}');
    put('esm-ok/example.test.js', BROKEN.replace('function ( {', 'function () {'));
    put('esm-ok/cjs.js', 'const a = require("node:fs");\nconsole.log(a);\n');
    put('esm-ok/m.mjs', 'import fs from "node:fs";\nconsole.log(fs);\n');
    const run = (cwd: string, ...files: string[]) =>
      spawnSync(process.execPath, ['--input-type=module', '-', 'syntax', ...files], {
        cwd: path.join(dir, cwd),
        input: NODE_CHECK_SCRIPT,
        encoding: 'utf8',
      });
    expect(run('esm-ok', 'example.test.js', 'cjs.js', 'm.mjs').status).toBe(0);
    put('esm-bad-mjs/m.mjs', 'import x from "y";\nfoo(function () {\n bar(;\n});\n');
    expect(run('esm-bad-mjs', 'm.mjs').status).toBe(1);
  });

  it('a package of type module is parsed as a module by node --check already, and a broken file there still fails once', () => {
    put('esm-typed/package.json', '{"type":"module"}');
    put('esm-typed/a.js', 'import x from "y";\nbar(;\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-', 'syntax', 'a.js'], {
      cwd: path.join(dir, 'esm-typed'),
      input: NODE_CHECK_SCRIPT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`.match(/SyntaxError/g)?.length).toBe(1);
  });
});

const pythonAvailable = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!pythonAvailable)(
  'python: the export check and the dotted imports check (harness v2)',
  () => {
    const py = (mode: 'imports' | 'exports', cwd: string, ...files: string[]) => {
      const r = spawnSync('python', ['-', mode, ...files], {
        cwd: path.join(dir, cwd),
        input: PYTHON_CHECK_SCRIPT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: path.join(dir, 'py', 'site') },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    beforeAll(() => {
      put('py/site/acme/__init__.py', 'class Client:\n    pass\n');
      put('py/site/acme/real.py', 'X = 1\n');
      put(
        'py/site/dyn/__init__.py',
        'import sys\nimport types\nsys.modules[__name__ + ".late"] = types.ModuleType("late")\n',
      );
      put('py/site/flat.py', 'Y = 1\n');
    });

    it('imports: import pkg.missing and from pkg.missing import x fail with the dotted name; a real submodule passes', () => {
      put('py/ok.py', 'import acme.real\nfrom acme.real import X\nprint(X)\n');
      put('py/bad1.py', 'import acme.missing\n');
      put('py/bad2.py', 'from acme.missing import x\n');
      expect(py('imports', 'py', 'ok.py').code).toBe(0);
      for (const f of ['bad1.py', 'bad2.py']) {
        const r = py('imports', 'py', f);
        expect(r.code, f).toBe(1);
        expect(r.out).toContain("ModuleNotFoundError: No module named 'acme.missing'");
      }
    });

    it('imports: the standard library, a flat module, a package that registers submodules at run time, and an optional import all pass', () => {
      put(
        'py/std.py',
        'import os.path\nimport xml.etree.ElementTree\nimport concurrent.futures\nfrom urllib.parse import urlparse\nimport flat\nimport dyn.late\nprint(1)\n',
      );
      put('py/opt.py', 'try:\n    import acme.nothing\nexcept ImportError:\n    acme = None\n');
      expect(py('imports', 'py', 'std.py').code).toBe(0);
      expect(py('imports', 'py', 'opt.py').code).toBe(0);
    });

    it('exports: a name the package has, or a submodule, passes; a missing name and a missing module fail', () => {
      put('py/e_ok.py', 'from acme import Client\nfrom acme import real\nprint(Client, real)\n');
      put('py/e_bad.py', 'from acme import Client, Client_qsr\n');
      put('py/e_mod.py', 'import acme.gone\n');
      expect(py('exports', 'py', 'e_ok.py').code).toBe(0);
      expect(py('exports', 'py', 'e_bad.py').out).toContain(
        "qsr-check-exports: cannot import name 'Client_qsr' from 'acme'",
      );
      expect(py('exports', 'py', 'e_mod.py').out).toContain(
        "qsr-check-exports: cannot import module 'acme.gone'",
      );
    });
  },
);
