import { describe, expect, it } from 'vitest';
import { BADGE_CACHE_CONTROL, badgeFor, isValidSlug, renderBadge, xmlEscape } from './badge.js';

// /api/badge/[slug]: a shields-style SVG for a README. Anyone can ask for any slug, so the slug is validated
// strictly and every piece of text that reaches the SVG is XML-escaped; the SVG makes no external request.

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  "'; DROP TABLE tools; --",
  '&lt;b&gt; & &amp;',
  '</text><image href="https://evil.test/x.png"/>',
  'x'.repeat(5000),
  String.fromCharCode(0, 31, 0x202e, 0x200b),
];

describe('xmlEscape', () => {
  it('escapes the five XML characters', () => {
    expect(xmlEscape(`<a href="x" t='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; t=&apos;y&apos;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('drops control characters and bidi overrides that are not valid XML text', () => {
    const dirty = [
      'a',
      String.fromCharCode(0),
      'b',
      String.fromCharCode(31),
      'c',
      String.fromCharCode(0x202e),
      'd',
    ].join('');
    expect(xmlEscape(dirty)).toBe('abcd');
  });
});

describe('isValidSlug', () => {
  it.each(['resend-node', 'a', 'zod-node', 'a1-b2-c3', 'canary-pass-node'])('accepts %s', (s) => {
    expect(isValidSlug(s)).toBe(true);
  });

  it.each([
    '',
    'Resend',
    'a_b',
    '-a',
    'a-',
    'a--b',
    'a b',
    '../x',
    'a/b',
    'a.b',
    '<x>',
    'a'.repeat(65),
    '%3Cscript%3E',
    'é',
  ])('rejects %j', (s) => {
    expect(isValidSlug(s)).toBe(false);
  });
});

describe('badgeFor: the value and colour for a status', () => {
  it.each([
    ['passing', 'passing'],
    ['failing', 'failing'],
    ['verifying', 'verifying'],
    ['unknown', 'unknown'],
    ['needs_person', 'needs a person'],
    ['not_tracked', 'not tracked'],
  ] as const)('%s -> %s', (status, value) => {
    expect(badgeFor(status).value).toBe(value);
  });

  it('gives each state its own colour', () => {
    const colours = (
      ['passing', 'failing', 'verifying', 'unknown', 'needs_person', 'not_tracked'] as const
    ).map((s) => badgeFor(s).color);
    expect(new Set(colours.slice(0, 5)).size).toBe(5);
  });
});

describe('renderBadge', () => {
  const svg = renderBadge({ label: 'quickstart', value: 'passing', color: '#1a7f37' });

  it('is a self-contained SVG with a label and a value, readable by a screen reader', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="quickstart: passing"');
    expect(svg).toContain('>quickstart<');
    expect(svg).toContain('>passing<');
    expect(svg).toContain('<title>quickstart: passing</title>');
  });

  it('makes no external request: no href, no url(), no script, no style import, no foreignObject', () => {
    const outside = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
    expect(outside).not.toMatch(/https?:/);
    expect(svg).not.toMatch(/href|url\(|<script|@import|foreignObject|<image|onload|onerror/i);
  });

  it('grows with its text', () => {
    const width = (s: string) =>
      Number(
        /width="(\d+)"/.exec(renderBadge({ label: 'quickstart', value: s, color: '#000000' }))?.[1],
      );
    expect(width('needs a person')).toBeGreaterThan(width('passing'));
  });

  it.each(PAYLOADS)('escapes a hostile value: %j', (payload) => {
    const out = renderBadge({ label: payload, value: payload, color: '#000000' });
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<svg onload');
    expect(out).not.toContain('<image');
    // no event-handler ATTRIBUTE (text like `onload=` inside a quoted value is harmless and is escaped anyway)
    const withoutQuoted = out.replace(/"[^"]*"/g, '""');
    expect(withoutQuoted).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i);
    expect((out.match(/<svg/g) ?? []).length).toBe(1);
    // the document is still well formed: every < is a tag we wrote
    const stripped = out.replace(
      /<\/?(svg|title|g|rect|text|linearGradient|stop|clipPath|path)\b[^>]*>/g,
      '',
    );
    expect(stripped).not.toMatch(/[<>]/);
  });

  it('refuses a colour that is not a plain hex value (it ends up in an attribute)', () => {
    expect(() => renderBadge({ label: 'a', value: 'b', color: '"/><script>' })).toThrow(/colou?r/i);
    expect(() => renderBadge({ label: 'a', value: 'b', color: 'red' })).toThrow(/colou?r/i);
  });

  it('truncates an absurdly long text instead of producing an enormous image', () => {
    expect(
      renderBadge({ label: 'a', value: 'x'.repeat(5000), color: '#000000' }).length,
    ).toBeLessThan(3000);
  });
});

describe('the caching policy', () => {
  it('is the one in the spec: public, 10 minutes at the edge, a day stale-while-revalidate', () => {
    expect(BADGE_CACHE_CONTROL).toBe('public, s-maxage=600, stale-while-revalidate=86400');
  });
});
