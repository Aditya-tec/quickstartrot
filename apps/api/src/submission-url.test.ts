import { describe, expect, it } from 'vitest';
import { validateSubmissionUrl } from './submission-url.js';

// Spec section 14: /submissions takes URL validation (https only, no IPs or private hosts). A submission is
// never fetched automatically, so this is defence in depth against a human following a hostile link and
// against anything that later reads these URLs; it is still strict.

const ok = (input: string) => {
  const r = validateSubmissionUrl(input);
  expect(r, input).toMatchObject({ ok: true });
  return r.ok ? r.url : '';
};
const bad = (input: string) => {
  const r = validateSubmissionUrl(input);
  expect(r.ok, input).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('accepts a normal public https docs URL', () => {
  it.each([
    'https://docs.example.com/quickstart',
    'https://example.com/docs/getting-started?lang=node',
    'https://sub.domain.example.co.uk/a/b/c',
    'https://xn--bcher-kva.example/docs',
    'https://example.com:443/docs',
    'HTTPS://Docs.Example.COM/Path',
  ])('%s', (url) => {
    ok(url);
  });

  it('returns a normalised URL without the fragment', () => {
    expect(ok('HTTPS://Docs.Example.COM/Path#section')).toBe('https://docs.example.com/Path');
  });
});

describe('https only', () => {
  it.each([
    'http://example.com/docs',
    'ftp://example.com/docs',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'gopher://example.com',
    'ws://example.com',
  ])('rejects %s', (url) => {
    expect(bad(url)).toMatch(/https/);
  });
});

describe('no IP literals, in any spelling', () => {
  it.each([
    'https://127.0.0.1/docs',
    'https://10.0.0.5/docs',
    'https://192.168.1.1/docs',
    'https://172.16.0.1/docs',
    'https://169.254.169.254/latest/meta-data',
    'https://8.8.8.8/',
    'https://[::1]/docs',
    'https://[2001:db8::1]/docs',
    'https://[::ffff:127.0.0.1]/docs',
    'https://2130706433/docs', // decimal for 127.0.0.1
    'https://0x7f000001/docs', // hex
    'https://0177.0.0.1/docs', // octal
    'https://127.1/docs', // shorthand
  ])('rejects %s', (url) => {
    expect(bad(url)).toMatch(/IP address/);
  });
});

describe('no local or private host names', () => {
  it.each([
    'https://localhost/docs',
    'https://LOCALHOST/docs',
    'https://app.localhost/docs',
    'https://printer.local/docs',
    'https://metadata.google.internal/computeMetadata',
    'https://service.internal/docs',
    'https://router.lan/docs',
    'https://nas.home.arpa/docs',
    'https://intranet/docs',
    'https://db/docs',
  ])('rejects %s', (url) => {
    expect(bad(url)).toMatch(/local|private|internal|host name/i);
  });
});

describe('other tricks', () => {
  it('rejects credentials in the URL', () => {
    expect(bad('https://user:pass@example.com/docs')).toMatch(/credentials/);
    expect(bad('https://user@example.com/docs')).toMatch(/credentials/);
  });

  it('rejects a port other than 443', () => {
    expect(bad('https://example.com:8443/docs')).toMatch(/port/);
    expect(bad('https://example.com:22/docs')).toMatch(/port/);
  });

  it.each([
    '',
    '   ',
    'not a url',
    'example.com/docs',
    '//example.com/docs',
    'https://',
    'https:///docs',
  ])('rejects the unparseable %j', (url) => {
    bad(url);
  });

  it('rejects control characters, whitespace inside the URL and absurd length', () => {
    bad('https://exa mple.com/docs');
    bad('https://example.com/docs\u0000');
    bad(`https://example.com/${'a'.repeat(2100)}`);
  });

  it('trims surrounding whitespace before judging', () => {
    expect(ok('  https://example.com/docs \n')).toBe('https://example.com/docs');
  });
});
