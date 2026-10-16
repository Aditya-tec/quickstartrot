import { describe, expect, it } from 'vitest';
import { computeSignature, firstErrorLines, normalize } from './signature.js';

// Spec section 10: signature = sha256(class + stepKind + normalize(firstErrorLines)). Two failures with
// the same cause must get the same signature however the paths, line numbers and times differ, and two
// different causes must not, which is why package names and identifiers are KEPT.

describe('normalize: what is removed', () => {
  it('removes ANSI codes', () => {
    expect(normalize('\u001b[31mError: boom\u001b[39m')).toBe('error: boom');
  });

  it.each([
    ['at Object.<anonymous> (/work/index.js:3:1)', 'at object.<anonymous> ()'],
    ['at Object.<anonymous> (/home/runner/project/src/index.js:99:12)', 'at object.<anonymous> ()'],
    [
      'Error: ENOENT: no such file or directory, open C:\\Users\\kalam\\proj\\a.txt',
      'error: enoent: no such file or directory, open',
    ],
    [
      'npm error A complete log of this run can be found in: ~/.npm/_logs/2026-10-16T07_51_26_705Z-debug-0.log',
      'npm error a complete log of this run can be found in:',
    ],
    ["cannot open '/tmp/tmp.Xk29aB/data.json'", "cannot open ''"],
  ])('removes absolute paths: %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('removes :line:col after a source file and TypeScript (line,col)', () => {
    expect(normalize('index.js:3:1 is broken')).toBe('index.js is broken');
    expect(normalize('main.py:12 is broken')).toBe('main.py is broken');
    expect(normalize("index.ts(2,13): error TS2304: Cannot find name 'x'.")).toBe(
      "index.ts: error ts2304: cannot find name 'x'.",
    );
    expect(normalize('IndentationError: unexpected indent (main.py, line 2)')).toBe(
      'indentationerror: unexpected indent (main.py)',
    );
  });

  it('keeps a port number: it is not a line number', () => {
    expect(normalize('connect ECONNREFUSED 127.0.0.1:3000')).toBe(
      'connect econnrefused 127.0.0.1:3000',
    );
  });

  it('removes hex addresses', () => {
    expect(
      normalize('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x7fcd732c1250>'),
    ).toBe('<pip._vendor.urllib3.connection.httpsconnection object at >');
    expect(normalize('object at 0xDEADBEEF')).toBe('object at');
  });

  it.each([
    ['failed at 2026-10-16T07:51:26.705Z', 'failed at'],
    ['failed at 2026-10-16T07_51_26_705Z', 'failed at'],
    ['[2026-10-16 07:51:26] failed', '[] failed'],
    ['10:16AM failed', 'failed'],
    ['failed at 1792145270782', 'failed at'],
  ])('removes timestamps: %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it.each([
    ['[qsr] step timed out after 2s and was killed', '[qsr] step timed out after and was killed'],
    ['[qsr] step timed out after 30s and was killed', '[qsr] step timed out after and was killed'],
    ['request took 1500ms', 'request took'],
    ['finished in 3.5 seconds', 'finished in'],
    ['waited 2 minutes', 'waited'],
  ])('removes durations: %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('removes temp dir names, run ids and uuids', () => {
    expect(normalize('cannot read pip-install-a8x2k9q1 now')).toBe('cannot read now');
    expect(normalize('cannot read pip-build-env-x9k2m4p7 now')).toBe('cannot read now');
    expect(normalize('container qsr-3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60 died')).toBe(
      'container died',
    );
    expect(normalize('run 3f2b8c1e-6d0a-4c52-9a3e-1b2c3d4e5f60 failed')).toBe('run failed');
    expect(normalize('cannot create tmpab12cd9 file')).toBe('cannot create file');
  });

  it('does not eat a package name that merely looks like one of those', () => {
    expect(
      normalize(
        "npm error 404 'qsr-canary-nonexistent-package-7f3a9c1e@*' is not in this registry",
      ),
    ).toContain('qsr-canary-nonexistent-package-7f3a9c1e');
    expect(normalize('cannot find tmpfile helper')).toBe('cannot find tmpfile helper');
  });

  it('lowercases and collapses whitespace', () => {
    expect(normalize('  TypeError:   Foo   IS not A Function \n')).toBe(
      'typeerror: foo is not a function',
    );
  });
});

describe('normalize: what is kept', () => {
  it('keeps identifiers, so different symbols are different signatures', () => {
    expect(normalize('TypeError: createClient is not a function')).toBe(
      'typeerror: createclient is not a function',
    );
    expect(normalize('TypeError: sendEmail is not a function')).not.toBe(
      normalize('TypeError: createClient is not a function'),
    );
  });

  it('keeps package names, scoped ones and the part of a path after node_modules', () => {
    expect(normalize("Error: Cannot find package 'left-pad' imported from /work/index.mjs")).toBe(
      "error: cannot find package 'left-pad' imported from",
    );
    expect(normalize("Cannot find module '/work/node_modules/@acme/sdk/dist/gone.js'")).toBe(
      "cannot find module 'node_modules/@acme/sdk/dist/gone.js'",
    );
    expect(normalize("No module named 'six.gone_submodule'")).toBe(
      "no module named 'six.gone_submodule'",
    );
  });

  it('keeps URLs, including the package name at the end of a registry URL', () => {
    const a = normalize(
      'npm error 404 Not Found - GET https://registry.npmjs.org/pkg-one - Not found',
    );
    const b = normalize(
      'npm error 404 Not Found - GET https://registry.npmjs.org/pkg-two - Not found',
    );
    expect(a).toContain('https://registry.npmjs.org/pkg-one');
    expect(a).not.toBe(b);
  });

  it('keeps version numbers and error codes', () => {
    expect(normalize('npm error notarget No matching version found for is-number@99.99.99.')).toBe(
      'npm error notarget no matching version found for is-number@99.99.99.',
    );
    expect(normalize('npm error code E404')).toBe('npm error code e404');
  });
});

describe('firstErrorLines', () => {
  it('returns up to 3 lines that look like errors, in order', () => {
    const log = [
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/x - Not found',
      'npm error 404',
      'npm error 404  x@* is not in this registry.',
    ].join('\n');
    expect(firstErrorLines(log)).toEqual([
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/x - Not found',
      'npm error 404',
    ]);
  });

  it('skips stack frames, tracebacks, source excerpts and the "complete log" pointer', () => {
    const log = [
      'Traceback (most recent call last):',
      '  File "/work/main.py", line 3, in <module>',
      '    from os import createClient',
      "ImportError: cannot import name 'createClient' from 'os'",
      'npm error A complete log of this run can be found in: ~/.npm/_logs/x.log',
      '    at Object.<anonymous> (/work/index.js:3:1) failed',
    ].join('\n');
    expect(firstErrorLines(log)).toEqual([
      "ImportError: cannot import name 'createClient' from 'os'",
    ]);
  });

  it('is empty when nothing looks like an error', () => {
    expect(firstErrorLines('all good\nstill good')).toEqual([]);
    expect(firstErrorLines('')).toEqual([]);
  });
});

describe('computeSignature', () => {
  const lines = ['TypeError: createClient is not a function'];

  it('is a sha256 hex digest', () => {
    expect(computeSignature('API_DRIFT', 'run', lines)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the class and on the step kind', () => {
    const base = computeSignature('API_DRIFT', 'run', lines);
    expect(computeSignature('DOCS_SNIPPET_ERROR', 'run', lines)).not.toBe(base);
    expect(computeSignature('API_DRIFT', 'shell', lines)).not.toBe(base);
  });

  it('is the same for the same error with different paths, line numbers, timestamps and durations (Node)', () => {
    const a = [
      'TypeError: createClient is not a function',
      '    at Object.<anonymous> (/work/index.js:3:1)',
    ];
    const b = [
      'TypeError: createClient is not a function',
      '    at Object.<anonymous> (/home/runner/app/src/index.js:57:9)',
    ];
    expect(computeSignature('API_DRIFT', 'run', a)).toBe(computeSignature('API_DRIFT', 'run', b));
    const slow = ['Error: timed out after 2s at 2026-10-16T07:51:26.705Z in /work/a.js:1:1'];
    const slower = ['Error: timed out after 31s at 2026-10-17T10:00:00.001Z in /tmp/x/a.js:80:4'];
    expect(computeSignature('TIMEOUT', 'run', slow)).toBe(
      computeSignature('TIMEOUT', 'run', slower),
    );
  });

  it('is the same for the same error with different paths, line numbers and addresses (Python)', () => {
    const a = ["ImportError: cannot import name 'x' from 'os' (/usr/local/lib/python3.12/os.py)"];
    const b = ["ImportError: cannot import name 'x' from 'os' (/opt/py/lib/python3.11/os.py)"];
    expect(computeSignature('API_DRIFT', 'run', a)).toBe(computeSignature('API_DRIFT', 'run', b));
    const c = ["NewConnectionError('<HTTPSConnection object at 0x7fcd732c1250>: Failed')"];
    const d = ["NewConnectionError('<HTTPSConnection object at 0x7f0000001111>: Failed')"];
    expect(computeSignature('NETWORK_TRANSIENT', 'shell', c)).toBe(
      computeSignature('NETWORK_TRANSIENT', 'shell', d),
    );
  });

  it('differs for different identifiers: createClient vs sendEmail', () => {
    expect(
      computeSignature('API_DRIFT', 'run', ['TypeError: createClient is not a function']),
    ).not.toBe(computeSignature('API_DRIFT', 'run', ['TypeError: sendEmail is not a function']));
    expect(
      computeSignature('API_DRIFT', 'run', [
        "AttributeError: module 'acme' has no attribute 'create_client'",
      ]),
    ).not.toBe(
      computeSignature('API_DRIFT', 'run', [
        "AttributeError: module 'acme' has no attribute 'send_email'",
      ]),
    );
  });

  it('only the first three error lines count', () => {
    const three = ['error one', 'error two', 'error three'];
    expect(computeSignature('UNKNOWN', 'run', [...three, 'error four'])).toBe(
      computeSignature('UNKNOWN', 'run', three),
    );
  });

  it('has a stable signature for an empty log (the class and step kind alone)', () => {
    expect(computeSignature('TIMEOUT', 'shell', [])).toBe(computeSignature('TIMEOUT', 'shell', []));
    expect(computeSignature('TIMEOUT', 'shell', [])).not.toBe(
      computeSignature('TIMEOUT', 'run', []),
    );
  });
});
