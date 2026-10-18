import { describe, expect, it } from 'vitest';
import { StepOutput } from './sink.js';

// Spec section 9, "Output capture and redaction": stream output into a ring buffer, full log up to
// 256 KB per step to a file, last 4 KB as stdoutTail / stderrTail. Redact before anything leaves
// the process. Strip ANSI.

const make = (over: Partial<ConstructorParameters<typeof StepOutput>[0]> = {}) =>
  new StepOutput({ secrets: ['qsr_dummy_key'], stdoutIncludes: [], ...over });
const bytes = (s: string) => Buffer.byteLength(s);
const ESC = String.fromCharCode(27);

describe('StepOutput: line handling', () => {
  it('joins chunks that split a line, and flushes a final line with no newline', () => {
    const out = make();
    out.stdout('hel');
    out.stdout('lo wor');
    out.stdout('ld\nsecond');
    const r = out.finish();
    expect(r.stdoutTail).toBe('hello world\nsecond\n');
    expect(r.log).toBe('hello world\nsecond\n');
  });

  it('keeps stdout and stderr tails separate but the log in arrival order', () => {
    const out = make();
    out.stdout('one\n');
    out.stderr('two\n');
    out.stdout('three\n');
    const r = out.finish();
    expect(r.stdoutTail).toBe('one\nthree\n');
    expect(r.stderrTail).toBe('two\n');
    expect(r.log).toBe('one\ntwo\nthree\n');
  });

  it('decodes a multi-byte character split across two chunks', () => {
    const out = make();
    const euro = Buffer.from('€ ok\n');
    out.stdout(euro.subarray(0, 1));
    out.stdout(euro.subarray(1));
    expect(out.finish().stdoutTail).toBe('€ ok\n');
  });

  it('treats CRLF as a newline and a bare CR as an in-place overwrite (progress bars)', () => {
    const out = make();
    out.stdout('windows line\r\n');
    out.stdout('progress 10%\rprogress 50%\rprogress 100%\n');
    expect(out.finish().stdoutTail).toBe('windows line\nprogress 100%\n');
  });

  it('strips ANSI colour codes', () => {
    const out = make();
    out.stdout(`${ESC}[31mred${ESC}[0m text\n`);
    expect(out.finish().log).toBe('red text\n');
  });

  it('writes harness notes into the log and the stderr tail', () => {
    const out = make();
    out.stdout('output\n');
    out.note('[qsr] killed: out of memory');
    const r = out.finish();
    expect(r.log).toBe('output\n[qsr] killed: out of memory\n');
    expect(r.stderrTail).toBe('[qsr] killed: out of memory\n');
    expect(r.stdoutTail).toBe('output\n');
  });
});

describe('StepOutput: redaction happens before anything is stored', () => {
  it('redacts dummy keys, tokens, home path and IPs in the log AND in both tails', () => {
    const out = make();
    out.stdout('key=qsr_dummy_key at /home/runner/work/x.js\n');
    out.stderr('connect to 10.0.0.1 with api_key=0123456789abcdef0123456789abcdef\n');
    const r = out.finish();
    for (const text of [r.log, r.stdoutTail, r.stderrTail]) {
      expect(text).not.toMatch(/qsr_dummy_key|10\.0\.0\.1|0123456789abcdef|\/home\/runner/);
    }
    expect(r.stdoutTail).toBe('key=[REDACTED] at ~/work/x.js\n');
  });

  it('redacts a secret that arrives split across two chunks', () => {
    const out = make();
    out.stdout('token qsr_dum');
    out.stdout('my_key end\n');
    const r = out.finish();
    expect(r.log).toBe('token [REDACTED] end\n');
    expect(r.log).not.toContain('qsr_dum');
  });

  it('redacts the value even when the secret is in the very last, unterminated line', () => {
    const out = make();
    out.stdout('last qsr_dummy_key');
    expect(out.finish().log).toBe('last [REDACTED]\n');
  });
});

describe('StepOutput: tails are the last 4 KB', () => {
  it('keeps only the final 4096 bytes, never more, and never splits a character', () => {
    const out = make();
    for (let i = 0; i < 2000; i++) out.stdout(`line ${String(i).padStart(4, '0')} ✓✓✓\n`);
    const r = out.finish();
    expect(bytes(r.stdoutTail)).toBeLessThanOrEqual(4096);
    expect(bytes(r.stdoutTail)).toBeGreaterThan(4000);
    expect(r.stdoutTail.endsWith('line 1999 ✓✓✓\n')).toBe(true);
    expect(r.stdoutTail).not.toContain(String.fromCharCode(0xfffd));
  });
});

describe('StepOutput: the log is capped at 256 KB', () => {
  it('stops storing after the cap, says so once, but keeps the tail and the evidence current', () => {
    const out = make();
    const line = `${'x'.repeat(98)}\n`;
    for (let i = 0; i < 6000; i++) out.stdout(line); // ~600 KB
    out.stderr('HTTP 401 Unauthorized\n'); // arrives AFTER the cap
    const r = out.finish();
    expect(r.logTruncated).toBe(true);
    expect(bytes(r.log)).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(bytes(r.log)).toBeGreaterThan(250 * 1024);
    expect(r.log.match(/output truncated/g)).toHaveLength(1);
    expect(r.stderrTail).toContain('HTTP 401');
    expect(r.evidence.authPattern).toBe('http_401_403');
    expect(r.bytesStdout).toBe(6000 * 99);
  });

  it('does not mark a log under the cap as truncated', () => {
    const out = make();
    out.stdout('small\n');
    expect(out.finish().logTruncated).toBe(false);
  });

  it('a 10 MB flood produces a log of at most 256 KB plus the marker, and a tail of at most 4 KB', () => {
    const out = make();
    const chunk = Buffer.from('flooding the output with lorem ipsum dolor sit amet\n'.repeat(1000));
    for (let sent = 0; sent < 10 * 1024 * 1024; sent += chunk.length) out.stdout(chunk);
    const r = out.finish();
    expect(bytes(r.log)).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(bytes(r.stdoutTail)).toBeLessThanOrEqual(4096);
    expect(r.bytesStdout).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });

  it('truncates one enormous line instead of buffering it (10 MB with no newline)', () => {
    const out = make({ maxLineBytes: 1000 });
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    for (let i = 0; i < 10; i++) out.stdout(chunk);
    out.stdout('\nafter the long line\n');
    const r = out.finish();
    expect(bytes(r.log)).toBeLessThan(2000);
    expect(r.log).toContain('[line truncated]');
    expect(r.log).toContain('after the long line');
  });
});

describe('StepOutput: the lines that are the evidence (shadow-L3 records them)', () => {
  const NOISE = Array.from(
    { length: 300 },
    (_, i) => `    at frame ${i} (file:///work/node_modules/x.js:${i}:1)\n`,
  ).join('');

  it('keeps the first line that matched an auth pattern and the first error line, even when 10 KB of output follows and pushes them out of the tail', () => {
    const out = make();
    out.stderr('UnauthorizedResponseError: Missing Authentication header\n');
    out.stderr('  statusCode: 401,\n');
    out.stderr(NOISE);
    const r = out.finish();
    expect(r.stderrTail).not.toContain('Missing Authentication header');
    expect(r.evidence.errorLine).toBe('UnauthorizedResponseError: Missing Authentication header');
    expect(r.evidence.authLine).toBe('statusCode: 401,');
  });

  it('recognises a Python exception line and an "Error:" line as the error line, and ignores stack frames', () => {
    const py = make();
    py.stderr(
      'Traceback (most recent call last):\n  File "/work/q.py", line 5, in <module>\nanthropic.AuthenticationError: Error code: 401 - {}\n',
    );
    expect(py.finish().evidence.errorLine).toBe(
      'anthropic.AuthenticationError: Error code: 401 - {}',
    );
    const js = make();
    js.stderr(
      '    at Object.<anonymous> (file.js:1:1)\nError: connect ECONNREFUSED 127.0.0.1:443\n',
    );
    // an IP address is redacted like everywhere else in the output
    expect(js.finish().evidence.errorLine).toBe('Error: connect ECONNREFUSED [REDACTED]:443');
    const none = make();
    none.stdout('Hello world!\n');
    expect(none.finish().evidence).toMatchObject({ errorLine: null, authLine: null });
  });

  it('redacts the secret in both lines and clips each to 300 characters', () => {
    const out = make();
    out.stderr(`AuthenticationError: bad key qsr_dummy_key ${'x'.repeat(600)}\n`);
    const r = out.finish();
    expect(r.evidence.errorLine).not.toContain('qsr_dummy_key');
    expect(r.evidence.errorLine?.length).toBeLessThanOrEqual(300);
    expect(r.evidence.authLine).toBeNull();
  });
});

describe('StepOutput: whether the step wrote anything', () => {
  it('knows when nothing at all arrived, and that a harness note does not count as output', () => {
    const none = make();
    expect(none.hasOutput()).toBe(false);
    none.note('[qsr] something');
    expect(none.hasOutput()).toBe(false);
    const some = make();
    some.stderr('x');
    expect(some.hasOutput()).toBe(true);
    const out = make();
    out.stdout('');
    expect(out.hasOutput()).toBe(false);
  });
});

describe('StepOutput: evidence for the pass/fail decision', () => {
  it('records the first auth pattern and the first drift pattern from either stream', () => {
    const out = make();
    out.stderr('Error: Request failed with status code 401\n');
    out.stdout('TypeError: x.send is not a function\n');
    out.stderr('Forbidden\n');
    const { evidence } = out.finish();
    expect(evidence.authPattern).toBe('http_401_403');
    expect(evidence.driftPattern).toBe('is not a function');
  });

  it('records nothing for clean output', () => {
    const out = make();
    out.stdout('all good\n');
    expect(out.finish().evidence).toEqual({
      authPattern: null,
      authLine: null,
      errorLine: null,
      driftPattern: null,
      stdoutIncludesFound: new Set(),
    });
  });

  it('matches stdoutIncludes on stdout only', () => {
    const out = make({ stdoutIncludes: ['ready', 'listening'] });
    out.stderr('ready on stderr\n');
    out.stdout('server is listening now\n');
    expect(out.finish().evidence.stdoutIncludesFound).toEqual(new Set(['listening']));
  });

  it('scans the redacted text, so a redacted secret cannot be matched later', () => {
    const out = make({ stdoutIncludes: ['qsr_dummy_key'] });
    out.stdout('value qsr_dummy_key\n');
    expect(out.finish().evidence.stdoutIncludesFound).toEqual(new Set());
  });
});
