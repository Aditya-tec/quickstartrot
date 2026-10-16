import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAILURE_CLASSES, RunResult, type FailureClass } from '@qsr/core';
import { classify } from './classify.js';
import { inputFromRunResult } from './from-run.js';
import { RULES } from './rules.js';
import type { ClassifyInput, FailingStep, RunContext } from './types.js';

// Every fixture is a RunResult plus its full step logs; most are CAPTURED from real runs in the sandbox
// images (see scripts/capture-classifier-fixtures.mjs), the rest are named synthetic-*.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Fixture {
  id: string;
  origin: 'captured' | 'synthetic';
  note: string | null;
  target: { slug: string; language: 'node' | 'python'; level: number; authErrorIsPass: boolean };
  expect: { class: FailureClass; rule: string };
  runResult: unknown;
  logs: Record<string, string>;
  commands: Record<string, string>;
}

const FIXTURES: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as Fixture);

function inputOf(fx: Fixture): ClassifyInput {
  const input = inputFromRunResult(RunResult.parse(fx.runResult), {
    language: fx.target.language,
    targetLevel: fx.target.level,
    authErrorIsPass: fx.target.authErrorIsPass,
    logs: fx.logs,
    commands: fx.commands,
  });
  if (input === null) throw new Error(`${fx.id}: nothing to classify`);
  return input;
}

describe('fixtures', () => {
  it('there are fixtures for both languages, real and synthetic, and the synthetic ones are named so', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(50);
    expect(
      FIXTURES.filter((f) => f.origin === 'synthetic').every((f) => f.id.startsWith('synthetic-')),
    ).toBe(true);
    expect(
      FIXTURES.filter((f) => f.id.startsWith('synthetic-')).every((f) => f.origin === 'synthetic'),
    ).toBe(true);
    expect(FIXTURES.filter((f) => f.target.language === 'node').length).toBeGreaterThan(15);
    expect(FIXTURES.filter((f) => f.target.language === 'python').length).toBeGreaterThan(15);
    expect(FIXTURES.filter((f) => f.origin === 'captured').length).toBeGreaterThan(40);
  });

  it.each(FIXTURES.map((f) => [f.id, f] as const))(
    '%s classifies to its expected class AND rule',
    (_id, fx) => {
      const result = classify(inputOf(fx));
      if (fx.expect.rule === 'none') {
        expect(result, 'no rule should match').toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      expect({ class: result?.failureClass, rule: result?.ruleId }).toEqual(fx.expect);
      expect(result?.source).toBe('rule');
      expect(result?.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(result?.evidenceLine).toBeTruthy();
    },
  );

  it('every class a run can fail with has at least one fixture', () => {
    const covered = new Set(FIXTURES.map((f) => f.expect.class));
    for (const c of FAILURE_CLASSES) {
      // CRAWL_ERROR and COMPILER_ERROR happen before any run exists: they are never classified from logs
      if (c === 'CRAWL_ERROR' || c === 'COMPILER_ERROR') continue;
      expect(covered.has(c), c).toBe(true);
    }
  });
});

describe('rules', () => {
  it('every rule has a stable id of the form area.name, unique, and a class from the taxonomy', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(FAILURE_CLASSES).toContain(r.failureClass);
      expect(r.description.length).toBeGreaterThan(10);
    }
  });

  it('every rule has at least one fixture, and every fixture names a real rule (or none)', () => {
    const used = new Set(FIXTURES.map((f) => f.expect.rule));
    for (const r of RULES) expect(used.has(r.id), `no fixture for rule ${r.id}`).toBe(true);
    const known = new Set([...RULES.map((r) => r.id), 'none']);
    for (const f of FIXTURES)
      expect(known.has(f.expect.rule), `${f.id}: ${f.expect.rule}`).toBe(true);
  });

  it('no pattern is global or sticky: a shared RegExp would carry lastIndex between inputs', () => {
    for (const r of RULES)
      if (r.pattern) expect(r.pattern.global || r.pattern.sticky, r.id).toBe(false);
  });

  it('classes the classifier never assigns from a run: CRAWL_ERROR and COMPILER_ERROR', () => {
    const classes = new Set(RULES.map((r) => r.failureClass));
    expect(classes.has('CRAWL_ERROR')).toBe(false);
    expect(classes.has('COMPILER_ERROR')).toBe(false);
  });

  it('classifying the same input twice gives the same answer', () => {
    const fx = FIXTURES.find((f) => f.id === 'node-run-not-a-function') as Fixture;
    expect(classify(inputOf(fx))).toEqual(classify(inputOf(fx)));
  });
});

// ---------------------------------------------------------------------------------------------
// Precedence: logs that fit several rules. First match wins, so the ORDER is the behaviour.

const run = (over: Partial<RunContext> = {}): RunContext => ({
  language: 'node',
  targetLevel: 3,
  reachedLevel: 2,
  outcome: 'FAIL',
  skipReason: null,
  authErrorIsPass: false,
  ...over,
});
const step = (kind: string, text: string, over: Partial<FailingStep> = {}): FailingStep => ({
  id: 's3',
  kind,
  command: null,
  exitCode: 1,
  stdoutTail: null,
  stderrTail: text,
  log: null,
  ...over,
});
const of = (
  kind: string,
  text: string,
  ctx: Partial<RunContext> = {},
  stepOver: Partial<FailingStep> = {},
) => classify({ step: step(kind, text, stepOver), run: run(ctx) });
const pair = (r: ReturnType<typeof classify>) => [r?.failureClass, r?.ruleId];

describe('precedence: auth errors', () => {
  it('an import error printed AFTER a 401 is API_DRIFT, not NEEDS_CREDENTIALS (Python)', () => {
    const text =
      "HTTP Error 401: Unauthorized\nImportError: cannot import name 'createClient' from 'acme'";
    expect(pair(of('run', text, { language: 'python' }))).toEqual([
      'API_DRIFT',
      'drift.python_import_name',
    ]);
  });

  it('a "not a function" printed after a 401 is API_DRIFT (Node)', () => {
    const text = 'Error: HTTP 401 Unauthorized\nTypeError: client.createClient is not a function';
    expect(pair(of('run', text))).toEqual(['API_DRIFT', 'drift.not_a_function']);
  });

  it('a missing module after a 401 is not NEEDS_CREDENTIALS either', () => {
    const text = "Error: HTTP 401 Unauthorized\nError: Cannot find module 'ghost'";
    expect(pair(of('run', text))).toEqual(['DOCS_SNIPPET_ERROR', 'import.missing_package']);
  });

  it('a 401 on its own is NEEDS_CREDENTIALS when auth errors are not a pass, for a run step', () => {
    expect(pair(of('run', 'Error: HTTP 401 Unauthorized'))).toEqual([
      'NEEDS_CREDENTIALS',
      'credentials.auth_error',
    ]);
    expect(pair(of('run', 'Error: 403 Forbidden'))).toEqual([
      'NEEDS_CREDENTIALS',
      'credentials.auth_error',
    ]);
    expect(pair(of('run', 'invalid api key provided'))).toEqual([
      'NEEDS_CREDENTIALS',
      'credentials.auth_error',
    ]);
  });

  it('with authErrorIsPass an auth error is never the reason the step failed', () => {
    expect(of('run', 'Error: HTTP 401 Unauthorized', { authErrorIsPass: true })).toBeNull();
  });

  it('an auth-looking word in an install step is not a credentials problem', () => {
    expect(
      of(
        'shell',
        'npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/x',
      ),
    ).toBeNull();
  });

  it('a harness check can never be NEEDS_CREDENTIALS', () => {
    expect(of('harness_check', 'index.js:1: Forbidden word unauthorized here')).toBeNull();
  });
});

describe('precedence: network, dependency and timeout', () => {
  it('pip retry lines followed by "No matching distribution found" are NETWORK, not DEPENDENCY_RESOLUTION', () => {
    const text = [
      "WARNING: Retrying (Retry(total=0)) after connection broken by 'NewConnectionError(Failed to establish a new connection: [Errno 111] Connection refused)': /simple/six/",
      'ERROR: Could not find a version that satisfies the requirement six (from versions: none)',
      'ERROR: No matching distribution found for six',
    ].join('\n');
    expect(pair(of('shell', text, { language: 'python' }))).toEqual([
      'NETWORK_TRANSIENT',
      'network.pip_connection',
    ]);
  });

  it('pip without any connection warning is a real DEPENDENCY_RESOLUTION failure', () => {
    const text =
      'ERROR: Could not find a version that satisfies the requirement nope (from versions: none)\nERROR: No matching distribution found for nope';
    expect(pair(of('shell', text, { language: 'python' }))).toEqual([
      'DEPENDENCY_RESOLUTION',
      'dependency.pip_no_matching',
    ]);
  });

  it('an npm warning about ECONNRESET followed by the explicit E404 error is DEPENDENCY_RESOLUTION', () => {
    const text =
      'npm warn ECONNRESET retrying\nnpm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x';
    expect(pair(of('shell', text))).toEqual(['DEPENDENCY_RESOLUTION', 'dependency.npm_e404']);
  });

  it('the old "npm ERR!" prefix is recognised as well as npm 10\'s "npm error"', () => {
    expect(pair(of('shell', 'npm ERR! code E404\nnpm ERR! 404 Not Found'))).toEqual([
      'DEPENDENCY_RESOLUTION',
      'dependency.npm_e404',
    ]);
    expect(
      pair(of('shell', 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version')),
    ).toEqual(['DEPENDENCY_RESOLUTION', 'dependency.npm_etarget']);
    expect(
      pair(of('shell', 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve')),
    ).toEqual(['DEPENDENCY_RESOLUTION', 'dependency.npm_eresolve']);
    expect(pair(of('shell', 'npm ERR! code ECONNRESET'))).toEqual([
      'NETWORK_TRANSIENT',
      'network.npm_code',
    ]);
  });

  it('exit code 124 is TIMEOUT even when the log mentions a network error', () => {
    expect(pair(of('shell', 'npm error code ETIMEDOUT', {}, { exitCode: 124 }))).toEqual([
      'TIMEOUT',
      'timeout.exit_124',
    ]);
  });

  it('a step killed after its time limit (exit 137, or no exit code) is TIMEOUT via the executor note', () => {
    const note = '[qsr] step timed out after 180s and was killed\n';
    expect(pair(of('run', note, {}, { exitCode: 137 }))).toEqual([
      'TIMEOUT',
      'timeout.killed_note',
    ]);
    expect(pair(of('run', note, {}, { exitCode: null }))).toEqual([
      'TIMEOUT',
      'timeout.killed_note',
    ]);
  });

  it('an exit 137 without that note (out of memory) is not a timeout', () => {
    expect(
      of(
        'run',
        '[qsr] the process was killed with SIGKILL (exit 137): most likely it exceeded the container memory limit',
        {},
        { exitCode: 137 },
      ),
    ).toBeNull();
  });
});

describe('precedence: version, syntax and drift', () => {
  it('EBADENGINE as an npm WARNING does not make a later E404 a RUNTIME_VERSION failure', () => {
    const text =
      'npm warn EBADENGINE Unsupported engine {\nnpm error code E404\nnpm error 404 Not Found';
    expect(pair(of('shell', text))).toEqual(['DEPENDENCY_RESOLUTION', 'dependency.npm_e404']);
  });

  it('an ESM "does not provide an export named" is API_DRIFT even though Node calls it a SyntaxError', () => {
    const text =
      "SyntaxError: The requested module './lib.mjs' does not provide an export named 'nope'";
    expect(pair(of('run', text))).toEqual(['API_DRIFT', 'drift.no_export']);
  });

  it('a plain SyntaxError is DOCS_SNIPPET_ERROR, and it outranks a later "not a function"', () => {
    expect(pair(of('run', "SyntaxError: Unexpected token '='"))).toEqual([
      'DOCS_SNIPPET_ERROR',
      'docs.syntax_error',
    ]);
    expect(pair(of('run', 'SyntaxError: bad\nTypeError: x is not a function'))).toEqual([
      'DOCS_SNIPPET_ERROR',
      'docs.syntax_error',
    ]);
  });

  it('a missing top-level package is the docs forgetting to install it; a missing file inside an installed package is drift', () => {
    expect(pair(of('run', "Error: Cannot find module 'ghost'"))).toEqual([
      'DOCS_SNIPPET_ERROR',
      'import.missing_package',
    ]);
    expect(pair(of('run', "Error: Cannot find module '@acme/sdk'"))).toEqual([
      'DOCS_SNIPPET_ERROR',
      'import.missing_package',
    ]);
    expect(pair(of('run', "Error: Cannot find module 'acme/dist/gone.js'"))).toEqual([
      'API_DRIFT',
      'import.missing_submodule',
    ]);
    expect(pair(of('run', "Error: Cannot find module '@acme/sdk/dist/gone.js'"))).toEqual([
      'API_DRIFT',
      'import.missing_submodule',
    ]);
    expect(
      pair(of('run', "ModuleNotFoundError: No module named 'ghost'", { language: 'python' })),
    ).toEqual(['DOCS_SNIPPET_ERROR', 'import.missing_package']);
    expect(
      pair(of('run', "ModuleNotFoundError: No module named 'acme.gone'", { language: 'python' })),
    ).toEqual(['API_DRIFT', 'import.missing_submodule']);
  });
});

describe('harness check failures (the mapping to a class)', () => {
  it.each([
    [
      'a syntax error in the docs code',
      'index.js: \nSyntaxError: Unexpected token',
      'DOCS_SNIPPET_ERROR',
      'check.syntax',
    ],
    [
      'an import of a package the docs never install',
      "index.js:1: Cannot find package 'ghost' imported from index.js",
      'DOCS_SNIPPET_ERROR',
      'check.package_not_installed',
    ],
    [
      'a Python import of a module never installed',
      "main.py:1: ModuleNotFoundError: No module named 'ghost' (imported from main.py)",
      'DOCS_SNIPPET_ERROR',
      'check.package_not_installed',
    ],
    [
      'a relative import of a file the docs never write',
      "index.js:1: Cannot find module './helper' imported from index.js",
      'DOCS_SNIPPET_ERROR',
      'check.relative_missing',
    ],
    [
      'require() in an ES module',
      'a.js:1: ReferenceError: require is not defined in ES module scope, you can use import instead',
      'DOCS_SNIPPET_ERROR',
      'check.require_in_esm',
    ],
    [
      'an extensionless relative ESM import',
      "a.mjs:1: Cannot find module './util' imported from a.mjs (ES modules need the full file name, extension included)",
      'DOCS_SNIPPET_ERROR',
      'check.esm_extension',
    ],
    [
      'a subpath the installed package no longer exports',
      'a.mjs:1: Package subpath \'./x\' is not defined by "exports" in /work/node_modules/pkg/package.json (imported from a.mjs)',
      'API_DRIFT',
      'check.subpath_not_exported',
    ],
    [
      'a file the installed package no longer has',
      "a.mjs:1: Cannot find module '/work/node_modules/pkg/dist/gone.js' (imported from a.mjs)",
      'API_DRIFT',
      'check.deep_import_missing',
    ],
  ] as const)('%s', (_name, text, cls, rule) => {
    expect(pair(of('harness_check', text))).toEqual([cls, rule]);
  });

  it('a check message nothing recognises is left to the fallback', () => {
    expect(of('harness_check', 'a.js: file not found')).toBeNull();
  });

  it('check rules apply only to harness_check steps', () => {
    expect(
      pair(of('run', "index.js:1: Cannot find module './helper' imported from index.js")),
    ).toEqual(['DOCS_SNIPPET_ERROR', 'import.missing_relative']);
  });
});

describe('context rules', () => {
  it('a run that ended in a harness error is HARNESS_ERROR whatever the log says', () => {
    const r = classify({
      step: step('run', 'Error: HTTP 401 Unauthorized'),
      run: run({ outcome: 'HARNESS_ERROR' }),
    });
    expect(pair(r)).toEqual(['HARNESS_ERROR', 'harness.run_outcome']);
    expect(classify({ step: null, run: run({ outcome: 'HARNESS_ERROR' }) })?.failureClass).toBe(
      'HARNESS_ERROR',
    );
  });

  it('a run skipped at a manual step before the target level is NEEDS_CREDENTIALS', () => {
    const r = classify({
      step: step('manual', '', { exitCode: null, stderrTail: null }),
      run: run({ outcome: 'SKIPPED', skipReason: 'manual_step', reachedLevel: 1 }),
    });
    expect(pair(r)).toEqual(['NEEDS_CREDENTIALS', 'skipped.manual_step']);
    expect(r?.evidenceLine).toMatch(/manual step.*L1.*L3/);
  });

  it('a SKIPPED run with another or no reason is not guessed at', () => {
    expect(classify({ step: null, run: run({ outcome: 'SKIPPED', skipReason: null }) })).toBeNull();
  });

  it('with no failing step and nothing to read, no rule matches', () => {
    expect(classify({ step: null, run: run() })).toBeNull();
  });
});

describe('what the rules read', () => {
  it('reads the full log when there is one, so an error beyond the 4 KB tail still counts', () => {
    const r = classify({
      step: step('shell', 'npm error code ELIFECYCLE', {
        log: 'npm error code E404\nnpm error 404 Not Found\n...\nnpm error code ELIFECYCLE\n',
      }),
      run: run(),
    });
    expect(pair(r)).toEqual(['DEPENDENCY_RESOLUTION', 'dependency.npm_e404']);
  });

  it('an empty log file does not hide the stored tails', () => {
    const r = classify({
      step: step('run', 'TypeError: a.b is not a function', { log: '' }),
      run: run(),
    });
    expect(pair(r)).toEqual(['API_DRIFT', 'drift.not_a_function']);
  });

  it('falls back to the tails when the log is missing, stderr and stdout both', () => {
    expect(
      pair(
        classify({
          step: step('run', '', {
            stderrTail: null,
            stdoutTail: 'TypeError: a.b is not a function',
          }),
          run: run(),
        }),
      ),
    ).toEqual(['API_DRIFT', 'drift.not_a_function']);
    expect(
      classify({ step: step('run', '', { stderrTail: null, stdoutTail: null }), run: run() }),
    ).toBeNull();
  });

  it('the evidence line is the first line that matched, trimmed and capped', () => {
    const long = `TypeError: ${'x'.repeat(500)} is not a function`;
    const r = of('run', `starting\n   ${long}\nnext`);
    expect(r?.evidenceLine?.startsWith('TypeError: xxx')).toBe(true);
    expect((r?.evidenceLine ?? '').length).toBeLessThanOrEqual(300);
  });

  it('the signature is the same for the same failure with different paths and lines, and differs for a different symbol', () => {
    const a = of(
      'run',
      'TypeError: client.createClient is not a function\n    at Object.<anonymous> (/work/index.js:3:1)',
    );
    const b = of(
      'run',
      'TypeError: client.createClient is not a function\n    at Object.<anonymous> (/home/runner/x/index.js:80:9)',
    );
    const c = of(
      'run',
      'TypeError: client.sendEmail is not a function\n    at Object.<anonymous> (/work/index.js:3:1)',
    );
    expect(a?.signature).toBe(b?.signature);
    expect(a?.signature).not.toBe(c?.signature);
  });

  it('the signature depends on the step kind', () => {
    const text = 'TypeError: a.b is not a function';
    expect(of('run', text)?.signature).not.toBe(of('shell', text)?.signature);
  });
});
