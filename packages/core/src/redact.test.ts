import { describe, expect, it } from 'vitest';
import { redact, stripAnsi, REDACTED } from './redact.js';

// Spec sections 4 and 9: "No secret ever appears in a log, artifact or LLM prompt. A redaction
// helper in core runs over all captured output." Redacts dummy key values, secret-looking tokens
// near key/token/secret, the runner's home path and IP addresses, and strips ANSI.

// Token-shaped test values are assembled at runtime so no scanner (GitHub push protection, Gitleaks)
// can mistake a fixture in the source for a leaked credential.
const fake = (...parts: string[]): string => parts.join('');

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('stripAnsi', () => {
  it('removes colour, cursor and erase sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m ${ESC}[1;32mbold green${ESC}[39;49m`)).toBe(
      'red bold green',
    );
    expect(stripAnsi(`a${ESC}[2K${ESC}[1Gb${ESC}[?25lc${ESC}[?25h`)).toBe('abc');
  });

  it('removes OSC sequences such as terminal hyperlinks and titles', () => {
    expect(stripAnsi(`${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL}`)).toBe('link');
    expect(stripAnsi(`${ESC}]0;title${ESC}\\text`)).toBe('text');
  });

  it('leaves ordinary text, newlines and unicode alone', () => {
    expect(stripAnsi('plain [31m not an escape\nline two ✓ café')).toBe(
      'plain [31m not an escape\nline two ✓ café',
    );
  });
});

describe('redact: explicit secrets (dummy keys)', () => {
  it('replaces every occurrence of a supplied secret', () => {
    expect(
      redact('key=qsr_dummy_key and again qsr_dummy_key', { secrets: ['qsr_dummy_key'] }),
    ).toBe(`key=${REDACTED} and again ${REDACTED}`);
  });

  it('replaces longer secrets before shorter ones that they contain', () => {
    expect(redact('abcd1234 abcd', { secrets: ['abcd', 'abcd1234'] })).toBe(
      `${REDACTED} ${REDACTED}`,
    );
  });

  it('ignores secrets that are too short to be safe to search for, and empty ones', () => {
    expect(redact('a b ab abc', { secrets: ['', 'a', 'ab', 'abc'] })).toBe('a b ab abc');
  });

  it('escapes regex characters in secrets', () => {
    expect(redact('token a.b*c+d? end', { secrets: ['a.b*c+d?'] })).toBe(`token ${REDACTED} end`);
  });
});

describe('redact: secret-looking tokens', () => {
  it.each([
    ['groq', fake('gsk', '_aB3dE5gH7jK9mN1pQ3sT5vX7zB2dF4hJ6kL8nP0q')],
    ['openai-style', fake('sk', '-aB3dE5gH7jK9mN1pQ3sT5vX7zB2dF4hJ6kL8nP0q')],
    ['github', fake('gh', 'p_aB3dE5gH7jK9mN1pQ3sT5vX7zB2dF4hJ6kL8')],
    ['slack', fake('xox', 'b-1234567890-abcdefghijklmnop')],
    ['aws', fake('AKIA', 'IOSFODNN7EXAMPLE')],
    [
      'jwt',
      fake('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'Jyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlX3ZhbHVlXzEyMzQ'),
    ],
  ])('redacts a standalone %s token', (_name, token) => {
    expect(redact(`error with ${token} in output`)).toBe(`error with ${REDACTED} in output`);
  });

  it('redacts a bearer token', () => {
    expect(redact('Authorization: Bearer abcdef0123456789abcdef.xyz-123')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it.each([
    'api_key=0123456789abcdef0123456789abcdef',
    'API_KEY: 0123456789abcdef0123456789abcdef',
    'RESEND_API_KEY="0123456789abcdef0123456789abcdef"',
    "SUPABASE_SERVICE_ROLE_KEY='0123456789abcdefABCDEF+/=0123'",
    '"access_token": "0123456789abcdef0123456789abcdef"',
    'INGEST_HMAC_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef',
    'password = hunter2hunter2hunter2',
    'client-secret: Zm9vYmFyYmF6cXV4MTIzNDU2',
  ])('redacts the value after a key/token/secret name: %s', (line) => {
    const out = redact(line);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/0123456789abcdef|hunter2|Zm9vYmFy/);
  });

  it('keeps the variable name so the log stays readable', () => {
    expect(redact('RESEND_API_KEY=0123456789abcdef0123456789abcdef')).toBe(
      `RESEND_API_KEY=${REDACTED}`,
    );
  });

  it('does not touch values that are short, or hex/base64 with no key-like name nearby', () => {
    expect(redact('api_key=short')).toBe('api_key=short');
    expect(redact('commit 0123456789abcdef0123456789abcdef01234567 fixed it')).toBe(
      'commit 0123456789abcdef0123456789abcdef01234567 fixed it',
    );
    expect(redact('integrity sha512-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh==')).toContain(
      'sha512-AbCdEf',
    );
    expect(redact('keyboard: layout-us-international-extended')).toBe(
      'keyboard: layout-us-international-extended',
    );
  });
});

describe('redact: home path', () => {
  it('replaces the runner home with ~ in paths and stack traces', () => {
    expect(redact('at /home/runner/work/index.js:3:9')).toBe('at ~/work/index.js:3:9');
    expect(redact('cwd=/home/runner')).toBe('cwd=~');
  });

  it('supports a different home path and does not touch look-alikes', () => {
    expect(redact('/root/.npm/_logs', { homePath: '/root' })).toBe('~/.npm/_logs');
    expect(redact('/home/runners/x /home/runner2')).toBe('/home/runners/x /home/runner2');
  });
});

describe('redact: IP addresses', () => {
  it.each(['10.0.0.1', '192.168.1.254', '8.8.8.8', '172.17.0.2', '255.255.255.255', '0.0.0.0'])(
    'redacts IPv4 %s',
    (ip) => {
      expect(redact(`connect ECONNREFUSED ${ip}:443`)).toBe(`connect ECONNREFUSED ${REDACTED}:443`);
    },
  );

  it.each(['2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:db8::8a2e:370:7334', 'fe80::1', '::1'])(
    'redacts IPv6 %s',
    (ip) => {
      expect(redact(`addr ${ip} ok`)).toBe(`addr ${REDACTED} ok`);
    },
  );

  it('leaves version numbers, timestamps, dates and ports alone', () => {
    const text =
      'node v22.23.3, npm 10.9.9, 1.2.3, 999.1.1.1, at 12:30:45, 2026-10-16T07:27:00Z, port :3000, 10:20:30:40';
    expect(redact(text)).toBe(text);
  });
});

describe('redact: combined behaviour', () => {
  it('strips ANSI first so escape codes cannot hide a secret', () => {
    expect(redact(`${ESC}[31mapi_key=0123456789abcdef0123456789abcdef${ESC}[0m`)).toBe(
      `api_key=${REDACTED}`,
    );
  });

  it('is idempotent', () => {
    const once = redact(
      'RESEND_API_KEY=0123456789abcdef0123456789abcdef from 10.0.0.1 in /home/runner/x',
      {
        secrets: ['qsr_dummy_key'],
      },
    );
    expect(redact(once, { secrets: ['qsr_dummy_key'] })).toBe(once);
  });

  it('works line by line on multi-line output and returns an empty string for empty input', () => {
    expect(redact('a\nb 10.0.0.1\nc')).toBe(`a\nb ${REDACTED}\nc`);
    expect(redact('')).toBe('');
  });
});
