#!/usr/bin/env node
// Captures the classifier's test fixtures from REAL runs: every case below is executed in the sandbox
// image through the real executor (the same code path as `qsr run`), and the RunResult plus the full
// redacted step logs are written to packages/classifier/fixtures/. Cases whose failure cannot be
// produced cheaply and deterministically (ECONNRESET, registry 5xx) are written as `synthetic-*`.
//
//   node scripts/capture-classifier-fixtures.mjs [--only id,id] [--synthetic-only]
//
// Needs Docker, the local images (qsr-node:local, qsr-python:local) and internet access. The committed
// fixtures are the output; the tests never run this.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'packages', 'classifier', 'fixtures');
const pkg = (name) => pathToFileURL(path.join(ROOT, 'packages', name, 'dist', 'index.js')).href;
const { executePlan, createDockerCli } = await import(pkg('executor'));

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const syntheticOnly = args.includes('--synthetic-only');

const SRC = { blockIndex: 0, lineStart: 1, lineEnd: 1 };
const EXPECT = { exitCode: 0, authErrorIsPass: false, stdoutIncludes: [], timeoutSec: 120 };
const sh = (id, command, over = {}) => ({
  kind: 'shell',
  id,
  command,
  source: SRC,
  expect: { ...EXPECT, ...over },
});
const run = (id, command, over = {}) => ({
  kind: 'run',
  id,
  command,
  source: null,
  expect: { ...EXPECT, ...over },
});
const file = (id, p, content) => ({ kind: 'write_file', id, path: p, content, source: SRC });
const manual = (id, reason) => ({ kind: 'manual', id, reason, source: SRC });

const IMAGES = { node: 'qsr-node:local', python: 'qsr-python:local' };
const PKG_JSON_NEEDS_NEW_NODE = JSON.stringify({
  name: 'needs-new-node',
  version: '1.0.0',
  engines: { node: '>=99' },
});
const PYPROJECT_NEEDS_NEW_PYTHON = [
  '[build-system]',
  'requires = ["setuptools"]',
  'build-backend = "setuptools.build_meta"',
  '[project]',
  'name = "needs-new-python"',
  'version = "1.0.0"',
  'requires-python = ">=3.99"',
].join('\n');

/** Real cases: id, language, plan, target level, expected class and rule, and what is interesting. */
const CASES = [
  // ---- Node: dependency resolution, runtime version, network
  {
    id: 'node-npm-e404',
    language: 'node',
    steps: [sh('s1', 'npm install qsr-classifier-nonexistent-pkg-9d41')],
    expect: ['DEPENDENCY_RESOLUTION', 'dependency.npm_e404'],
    note: 'npm 10 prints "npm error", not "npm ERR!"',
  },
  {
    id: 'node-npm-etarget',
    language: 'node',
    steps: [sh('s1', 'npm install is-number@99.99.99')],
    expect: ['DEPENDENCY_RESOLUTION', 'dependency.npm_etarget'],
  },
  {
    id: 'node-npm-eresolve',
    language: 'node',
    steps: [sh('s1', 'npm install react@18.2.0 react-dom@19.0.0')],
    expect: ['DEPENDENCY_RESOLUTION', 'dependency.npm_eresolve'],
  },
  {
    id: 'node-npm-ebadengine',
    language: 'node',
    steps: [
      file('s1', 'pkg/package.json', PKG_JSON_NEEDS_NEW_NODE),
      sh('s2', 'npm install ./pkg --engine-strict'),
    ],
    expect: ['RUNTIME_VERSION', 'runtime.npm_ebadengine'],
  },
  {
    id: 'node-npm-enotfound-registry',
    language: 'node',
    steps: [
      sh(
        's1',
        'npm install ms --registry=http://registry.invalid.example --fetch-retries=0 --fetch-timeout=5000',
      ),
    ],
    expect: ['NETWORK_TRANSIENT', 'network.npm_code'],
    note: 'a registry host that does not resolve',
  },
  {
    id: 'node-timeout',
    language: 'node',
    steps: [sh('s1', 'sleep 30', { timeoutSec: 2 })],
    expect: ['TIMEOUT', 'timeout.exit_124'],
  },
  // ---- Node: the harness checks that give L2 its meaning
  {
    id: 'node-check-syntax-error',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', 'const ms = ;\nconsole.log(ms);'),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.syntax'],
    failStep: 'qsr-check-syntax',
  },
  {
    id: 'node-check-package-not-installed',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file(
        's2',
        'index.js',
        "const { createClient } = require('never-installed-pkg');\ncreateClient();",
      ),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.package_not_installed'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'node-check-relative-missing',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const helper = require('./helper');\nconsole.log(helper);"),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.relative_missing'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'node-check-require-in-esm',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "import ms from 'ms';\nconsole.log(ms('1h'));"),
      file('s3', 'helper.js', "const ms = require('ms');\nconsole.log(ms('1h'));"),
      run('s4', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.require_in_esm'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'node-check-esm-extension',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'util.js', 'export const u = 1;'),
      file('s3', 'index.mjs', "import { u } from './util';\nconsole.log(u);"),
      run('s4', 'node index.mjs'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.esm_extension'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'node-check-subpath-not-exported',
    language: 'node',
    steps: [
      sh('s1', 'npm install nanoid@5'),
      file('s2', 'index.mjs', "import x from 'nanoid/not-a-real-subpath.js';\nconsole.log(x);"),
      run('s3', 'node index.mjs'),
    ],
    expect: ['API_DRIFT', 'check.subpath_not_exported'],
    failStep: 'qsr-check-imports',
    note: 'the package is installed but its export map no longer has the path the docs import',
  },
  // ---- Node: run-time failures of docs code
  {
    id: 'node-run-not-a-function',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const ms = require('ms');\nms.nonexistentFunction('1h');"),
      run('s3', 'node index.js'),
    ],
    expect: ['API_DRIFT', 'drift.not_a_function'],
  },
  {
    id: 'node-run-not-a-constructor',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const Thing = require('ms').Thing;\nnew Thing();"),
      run('s3', 'node index.js'),
    ],
    expect: ['API_DRIFT', 'drift.not_a_constructor'],
  },
  {
    id: 'node-run-esm-missing-export',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'lib.mjs', 'export const a = 1;'),
      file('s3', 'index.mjs', "import { nope } from './lib.mjs';\nconsole.log(nope);"),
      run('s4', 'node index.mjs'),
    ],
    expect: ['API_DRIFT', 'drift.no_export'],
    note: 'the message says SyntaxError, but it is an export that is gone: drift outranks the generic syntax rule',
  },
  {
    id: 'node-run-reference-error',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', 'console.log(clientThatWasNeverDefined);'),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.undefined_name'],
  },
  {
    id: 'node-run-cannot-find-module',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const name = ['gho', 'st'].join('');\nrequire(name);"),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'import.missing_package'],
    note: 'a dynamic require: invisible to the static import check',
  },
  {
    id: 'node-run-cannot-find-submodule',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const name = ['ms', 'dist/gone.js'].join('/');\nrequire(name);"),
      run('s3', 'node index.js'),
    ],
    expect: ['API_DRIFT', 'import.missing_submodule'],
  },
  {
    id: 'node-run-auth-401',
    language: 'node',
    level: 3,
    steps: [
      sh('s1', 'npm install ms'),
      file(
        's2',
        'index.js',
        "const r = await fetch('https://api.github.com/user');\nif (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);",
      ),
      run('s3', 'node index.mjs'),
    ],
    fixup: (c) => {
      c.steps[1].path = 'index.mjs';
    },
    expect: ['NEEDS_CREDENTIALS', 'credentials.auth_error'],
    note: 'a real 401 from a real API; authErrorIsPass is false, so the auth error is the failure',
  },
  {
    id: 'node-precedence-auth-then-drift',
    language: 'node',
    level: 3,
    steps: [
      sh('s1', 'npm install ms'),
      file(
        's2',
        'index.js',
        "console.error('Error: HTTP 401 Unauthorized');\nconst client = {};\nclient.createClient();",
      ),
      run('s3', 'node index.js'),
    ],
    expect: ['API_DRIFT', 'drift.not_a_function'],
    note: 'scripted, run for real: a 401 is printed and THEN the call fails. The 401 must not hide the drift',
  },
  {
    id: 'node-ts-cannot-find-name',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.ts', 'const client: number = 1;\nconsole.log(missingName, client);'),
      run('s3', 'tsc --noEmit index.ts'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.typescript'],
    note: 'tsc 7 (the image global) prints TS2304',
  },
  {
    id: 'node-check-deep-import-missing',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.mjs', "import x from 'ms/dist/gone.js';\nconsole.log(x);"),
      run('s3', 'node index.mjs'),
    ],
    expect: ['API_DRIFT', 'check.deep_import_missing'],
    failStep: 'qsr-check-imports',
    note: 'the package is installed; the file the docs import from it is not in it any more',
  },
  {
    id: 'node-run-syntax-error',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "eval('const = 1');"),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.syntax_error'],
    note: 'a syntax error the static check cannot see (inside a string)',
  },
  {
    id: 'node-run-cannot-find-relative',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', "const name = ['.', 'gone'].join('/');\nrequire(name);"),
      run('s3', 'node index.js'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'import.missing_relative'],
  },
  {
    id: 'node-unknown-silent-failure',
    language: 'node',
    steps: [
      sh('s1', 'npm install ms'),
      file('s2', 'index.js', 'process.exit(3);'),
      run('s3', 'node index.js'),
    ],
    expect: ['UNKNOWN', 'none'],
    note: 'nothing to read: exit 3 with no output',
  },
  {
    id: 'node-skipped-manual-step',
    language: 'node',
    level: 3,
    steps: [
      sh('s1', 'npm install ms'),
      manual('s2', 'Create an account and copy your API key'),
      run('s3', 'node index.js'),
    ],
    expect: ['NEEDS_CREDENTIALS', 'skipped.manual_step'],
  },
  // ---- Python
  {
    id: 'python-pip-no-matching-distribution',
    language: 'python',
    steps: [sh('s1', 'pip install qsr-classifier-nonexistent-pkg-9d41')],
    expect: ['DEPENDENCY_RESOLUTION', 'dependency.pip_no_matching'],
  },
  {
    id: 'python-pip-resolution-impossible',
    language: 'python',
    steps: [sh('s1', 'pip install requests==2.28.0 charset-normalizer==3.4.0')],
    expect: ['DEPENDENCY_RESOLUTION', 'dependency.pip_resolution_impossible'],
  },
  {
    id: 'python-pip-requires-different-python',
    language: 'python',
    steps: [
      file('s1', 'proj/pyproject.toml', PYPROJECT_NEEDS_NEW_PYTHON),
      sh('s2', 'pip install ./proj'),
    ],
    expect: ['RUNTIME_VERSION', 'runtime.python_requires'],
  },
  {
    id: 'python-pip-unreachable-index',
    language: 'python',
    steps: [
      sh(
        's1',
        'pip install six --index-url https://pypi.invalid.example/simple --retries 1 --timeout 3',
      ),
    ],
    expect: ['NETWORK_TRANSIENT', 'network.dns'],
    note: 'ends with "No matching distribution found" like a missing package, but the cause is DNS: the network lines must win over the dependency rule',
  },
  {
    id: 'python-pip-connection-refused',
    language: 'python',
    steps: [
      sh('s1', 'pip install six --index-url https://127.0.0.1:1/simple --retries 1 --timeout 3'),
    ],
    expect: ['NETWORK_TRANSIENT', 'network.pip_connection'],
    note: 'nothing listens on the index port; pip ends with "No matching distribution found"',
  },
  {
    id: 'python-timeout',
    language: 'python',
    steps: [sh('s1', 'sleep 30', { timeoutSec: 2 })],
    expect: ['TIMEOUT', 'timeout.exit_124'],
  },
  {
    id: 'python-check-syntax-error',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'def f(:\n    pass\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.syntax'],
    failStep: 'qsr-check-syntax',
  },
  {
    id: 'python-check-indentation-error',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'x = 1\n    y = 2\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.indentation'],
    failStep: 'qsr-check-syntax',
  },
  {
    id: 'python-check-package-not-installed',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'import never_installed_mod\nprint(1)\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.package_not_installed'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'python-check-relative-missing',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'pkg/__init__.py', ''),
      file('s3', 'pkg/main.py', 'from .gone import thing\nprint(thing)\n'),
      run('s4', 'python -m pkg.main'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'check.relative_missing'],
    failStep: 'qsr-check-imports',
  },
  {
    id: 'python-run-import-error-cannot-import-name',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'from os import not_there\nprint(not_there)\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['API_DRIFT', 'drift.python_import_name'],
  },
  {
    id: 'python-run-attribute-error',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'import six\nsix.not_a_real_attribute()\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['API_DRIFT', 'drift.python_attribute'],
  },
  {
    id: 'python-run-unexpected-keyword',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'def send(to):\n    return to\n\nsend(to="a", subject="b")\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['API_DRIFT', 'drift.unexpected_argument'],
  },
  {
    id: 'python-run-name-error',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'print(client_never_defined)\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.undefined_name'],
  },
  {
    id: 'python-run-module-not-found',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', "import importlib\nimportlib.import_module('ghost_module')\n"),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'import.missing_package'],
    note: 'dynamic import: invisible to the static import check',
  },
  {
    id: 'python-run-submodule-not-found',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', "import importlib\nimportlib.import_module('six.gone_submodule')\n"),
      run('s3', 'python main.py'),
    ],
    expect: ['API_DRIFT', 'import.missing_submodule'],
  },
  {
    id: 'python-run-auth-401',
    language: 'python',
    level: 3,
    steps: [
      sh('s1', 'pip install six'),
      file(
        's2',
        'main.py',
        "import urllib.request\nurllib.request.urlopen('https://api.github.com/user')\n",
      ),
      run('s3', 'python main.py'),
    ],
    expect: ['NEEDS_CREDENTIALS', 'credentials.auth_error'],
  },
  {
    id: 'python-precedence-auth-then-import-error',
    language: 'python',
    level: 3,
    steps: [
      sh('s1', 'pip install six'),
      file(
        's2',
        'main.py',
        "import sys\nprint('HTTP Error 401: Unauthorized', file=sys.stderr)\nfrom os import createClient\n",
      ),
      run('s3', 'python main.py'),
    ],
    expect: ['API_DRIFT', 'drift.python_import_name'],
    note: 'scripted, run for real: the 401 comes first, then the ImportError',
  },
  {
    id: 'python-run-syntax-error',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', "exec('def f(:')\n"),
      run('s3', 'python main.py'),
    ],
    expect: ['DOCS_SNIPPET_ERROR', 'docs.syntax_error'],
    note: 'a syntax error the static check cannot see (inside a string)',
  },
  {
    id: 'python-unknown-silent-failure',
    language: 'python',
    steps: [
      sh('s1', 'pip install six'),
      file('s2', 'main.py', 'import sys\nsys.exit(3)\n'),
      run('s3', 'python main.py'),
    ],
    expect: ['UNKNOWN', 'none'],
  },
  {
    id: 'python-skipped-manual-step',
    language: 'python',
    level: 3,
    steps: [
      sh('s1', 'pip install six'),
      manual('s2', 'Create an account and copy your API key'),
      run('s3', 'python main.py'),
    ],
    expect: ['NEEDS_CREDENTIALS', 'skipped.manual_step'],
  },
];

/** Hand-written logs for failures that cannot be produced on demand. Named synthetic-*. */
function syntheticResult({
  language,
  kind = 'shell',
  exitCode = 1,
  stdout = '',
  stderr = '',
  outcome = 'FAIL',
  command,
}) {
  const stepId = 's1';
  const log = [stdout, stderr].filter(Boolean).join('');
  return {
    runResult: {
      toolSlug: `fixture-${language}`,
      cycleId: randomUUID(),
      attempt: 1,
      planId: null,
      snapshotHash: null,
      outcome,
      reachedLevel: 0,
      failedStepId: stepId,
      steps: [
        {
          stepId,
          ordinal: 0,
          kind,
          outcome: 'FAIL',
          exitCode,
          durationMs: 1000,
          stdoutTail: stdout || null,
          stderrTail: stderr || null,
          logFile: `fixture/00-${stepId}.log`,
          matchedAuthPattern: null,
          skipReason: null,
        },
      ],
      imageDigest: `sha256:${'0'.repeat(64)}`,
      runnerEnv: { synthetic: 'true' },
      startedAt: '2026-10-16T00:00:00.000Z',
      finishedAt: '2026-10-16T00:00:01.000Z',
    },
    logs: { [stepId]: log },
    commands: { [stepId]: command },
  };
}
const SYNTHETIC = [
  {
    id: 'synthetic-node-econnreset',
    language: 'node',
    kind: 'run',
    command: 'node index.js',
    stderr:
      "node:internal/process/promises:394\n    triggerUncaughtException(err, true /* fromPromise */);\n    ^\n\nError: read ECONNRESET\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:218:20) {\n  errno: -104,\n  code: 'ECONNRESET',\n  syscall: 'read'\n}\n",
    expect: ['NETWORK_TRANSIENT', 'network.connection'],
  },
  {
    id: 'synthetic-node-registry-503',
    language: 'node',
    command: 'npm install acme-sdk',
    stderr:
      'npm warn registry Unexpected warning for https://registry.npmjs.org/: Miscellaneous Warning ECONNRESET: request to https://registry.npmjs.org/acme-sdk failed, reason: read ECONNRESET\nnpm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/acme-sdk\nnpm error A complete log of this run can be found in: ~/.npm/_logs/2026-10-16T07_51_26_705Z-debug-0.log\n',
    expect: ['NETWORK_TRANSIENT', 'network.npm_code'],
  },
  {
    id: 'synthetic-node-eai-again',
    language: 'node',
    kind: 'run',
    command: 'node index.js',
    stderr:
      "Error: getaddrinfo EAI_AGAIN api.acme.example\n    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {\n  errno: -3001,\n  code: 'EAI_AGAIN',\n  syscall: 'getaddrinfo',\n  hostname: 'api.acme.example'\n}\n",
    expect: ['NETWORK_TRANSIENT', 'network.dns'],
  },
  {
    id: 'synthetic-node-etimedout',
    language: 'node',
    command: 'npm install acme-sdk',
    stderr:
      'npm error code ETIMEDOUT\nnpm error syscall connect\nnpm error errno ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/acme-sdk failed, reason: connect ETIMEDOUT 104.16.0.35:443\nnpm error network This is a problem related to network connectivity.\n',
    expect: ['NETWORK_TRANSIENT', 'network.npm_code'],
  },
  {
    id: 'synthetic-python-read-timeout',
    language: 'python',
    command: 'pip install acme-sdk',
    stderr:
      "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='pypi.org', port=443): Read timed out. (read timeout=15)\")': /simple/acme-sdk/\nERROR: Could not find a version that satisfies the requirement acme-sdk (from versions: none)\nERROR: No matching distribution found for acme-sdk\n",
    expect: ['NETWORK_TRANSIENT', 'network.connection'],
  },
  {
    id: 'synthetic-python-pypi-502',
    language: 'python',
    command: 'pip install acme-sdk',
    stderr:
      'ERROR: HTTP error 502 while getting https://files.pythonhosted.org/packages/ab/cd/acme_sdk-1.0.0-py3-none-any.whl\nERROR: Could not install requirement acme-sdk from https://files.pythonhosted.org/packages/ab/cd/acme_sdk-1.0.0-py3-none-any.whl because of HTTP error 502 Bad Gateway for URL https://files.pythonhosted.org/packages/ab/cd/acme_sdk-1.0.0-py3-none-any.whl\n',
    expect: ['NETWORK_TRANSIENT', 'network.registry_5xx'],
  },
  {
    id: 'synthetic-node-killed-after-timeout',
    language: 'node',
    kind: 'run',
    command: 'node server.js',
    exitCode: 137,
    stderr: '[qsr] step timed out after 180s and was killed\n',
    expect: ['TIMEOUT', 'timeout.killed_note'],
    note: 'timeout -k had to SIGKILL the process, so the exit code is 137, not 124',
  },
  {
    id: 'synthetic-python-ignored-versions',
    language: 'python',
    command: 'pip install acme-sdk',
    stderr: [
      'Collecting acme-sdk',
      'INFO: pip is looking at multiple versions of acme-sdk to determine which version is compatible with other requirements.',
      'ERROR: Ignored the following versions that require a different Python version: 4.0.0 Requires-Python >=3.13; 3.9.0 Requires-Python >=3.13',
      'ERROR: Could not find a version that satisfies the requirement acme-sdk (from versions: none)',
      'ERROR: No matching distribution found for acme-sdk',
      '',
    ].join('\n'),
    expect: ['RUNTIME_VERSION', 'runtime.python_ignored_versions'],
  },
  {
    id: 'synthetic-harness-error',
    language: 'node',
    outcome: 'HARNESS_ERROR',
    exitCode: null,
    kind: 'run',
    command: 'node index.js',
    stderr:
      'harness error: docker exec failed: Error response from daemon: No such container: qsr-abc\n',
    expect: ['HARNESS_ERROR', 'harness.run_outcome'],
  },
  {
    id: 'synthetic-auth-ignored-when-auth-is-pass',
    language: 'node',
    level: 3,
    authErrorIsPass: true,
    kind: 'run',
    command: 'node index.js',
    stderr:
      'Error: HTTP 401 Unauthorized\n    at send (/work/index.js:4:9)\nsomething unrelated went wrong afterwards\n',
    expect: ['UNKNOWN', 'none'],
    note: 'with authErrorIsPass an auth error is the expected outcome, so it can never be the reason the step failed',
  },
];

const cli = createDockerCli();
const toFixture = (c, extra) => ({
  id: c.id,
  origin: c.id.startsWith('synthetic-') ? 'synthetic' : 'captured',
  note: c.note ?? null,
  target: {
    slug: `fixture-${c.language}`,
    language: c.language,
    level: c.level ?? 2,
    authErrorIsPass: c.authErrorIsPass ?? false,
  },
  expect: { class: c.expect[0], rule: c.expect[1] },
  ...extra,
});

async function capture(c) {
  const { fixup, ...data } = c;
  const plan = structuredClone(data);
  fixup?.(plan);
  const ir = {
    irVersion: 1,
    language: c.language,
    projectInit: c.language === 'node' ? 'npm_init' : 'python_venv',
    steps: plan.steps,
    maxLevelReachable: 3,
    notes: '',
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'qsr-fixture-'));
  const result = await executePlan(
    {
      target: {
        slug: `fixture-${c.language}`,
        language: c.language,
        level: c.level ?? 2,
        placeholders: {},
        expect: { authErrorIsPass: false, timeoutSec: 600 },
      },
      ir,
      image: IMAGES[c.language],
      outDir,
      cycleId: randomUUID(),
      attempt: 1,
      planId: null,
      snapshotHash: null,
    },
    { docker: cli, runId: `fx${process.pid}${Math.random().toString(36).slice(2, 8)}` },
  );
  const logs = {};
  const commands = {};
  for (const s of result.steps) {
    const planned = ir.steps.find((p) => p.id === s.stepId);
    if (planned && 'command' in planned) commands[s.stepId] = planned.command;
    if (s.logFile) logs[s.stepId] = await readFile(path.join(outDir, s.logFile), 'utf8');
  }
  // Fixtures must be stable files: drop volatile run identifiers.
  result.cycleId = '00000000-0000-4000-8000-000000000000';
  result.startedAt = '2026-10-16T00:00:00.000Z';
  result.finishedAt = '2026-10-16T00:00:01.000Z';
  return toFixture(c, { runResult: result, logs, commands });
}

await mkdir(OUT, { recursive: true });
const wanted = (c) => (only ? only.includes(c.id) : true);
const real = syntheticOnly ? [] : CASES.filter(wanted);
const queue = [...real];
const worker = async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    process.stderr.write(`capturing ${c.id} ...\n`);
    const fx = await capture(c);
    const got = `${fx.runResult.outcome}/${fx.runResult.failedStepId}`;
    await writeFile(path.join(OUT, `${c.id}.json`), `${JSON.stringify(fx, null, 2)}\n`);
    process.stderr.write(`  ${c.id}: ${got}\n`);
  }
};
await Promise.all([worker(), worker(), worker()]);
for (const s of SYNTHETIC.filter(wanted)) {
  const fx = toFixture(s, syntheticResult(s));
  await writeFile(path.join(OUT, `${s.id}.json`), `${JSON.stringify(fx, null, 2)}\n`);
}
process.stderr.write('done\n');
