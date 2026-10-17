import { describe, expect, it } from 'vitest';
import { BADGE_CSP, badgeHeaders, buildCsp, securityHeaders } from './security-headers.js';

// Spec section 14: strict CSP and security headers. Nothing from a third party runs on the site: scripts are
// ours, connections go only to our own origin and the Supabase project (the log viewer reads public-artifacts
// from the browser), nothing can frame the site. Turnstile is the one optional exception and only when its
// site key is configured.

const SUPABASE = 'https://abc123.supabase.co';
const directives = (csp: string): Record<string, string[]> =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name as string, values];
      }),
  );

describe('buildCsp', () => {
  const csp = directives(buildCsp({ supabaseUrl: SUPABASE, turnstile: false, dev: false }));

  it('allows scripts only from the site itself (inline for the framework payload, never eval)', () => {
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp['script-src']).not.toContain("'unsafe-eval'");
  });

  it('limits connections to the site and the Supabase project', () => {
    expect(csp['connect-src']).toEqual(["'self'", SUPABASE]);
  });

  it('forbids framing, plugins, other bases and form targets', () => {
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
  });

  it('serves fonts, images and styles from the site (fonts are bundled, nothing external)', () => {
    expect(csp['font-src']).toEqual(["'self'"]);
    expect(csp['img-src']).toEqual(["'self'", 'data:']);
    expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('names no third-party host anywhere, except the Supabase project', () => {
    const all = Object.values(csp).flat();
    const hosts = all.filter((v) => /^https?:/.test(v));
    expect(hosts).toEqual([SUPABASE]);
  });

  it('adds Cloudflare Turnstile only when it is configured', () => {
    const on = directives(buildCsp({ supabaseUrl: SUPABASE, turnstile: true, dev: false }));
    expect(on['script-src']).toContain('https://challenges.cloudflare.com');
    expect(on['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    expect(csp['frame-src']).toBeUndefined();
    expect(csp['script-src']).not.toContain('https://challenges.cloudflare.com');
  });

  it('allows eval and websockets only in development (hot reload)', () => {
    const dev = directives(buildCsp({ supabaseUrl: SUPABASE, turnstile: false, dev: true }));
    expect(dev['script-src']).toContain("'unsafe-eval'");
    expect(dev['connect-src']).toContain('ws:');
  });

  it('works without a Supabase URL (fixtures)', () => {
    const none = directives(buildCsp({ supabaseUrl: null, turnstile: false, dev: false }));
    expect(none['connect-src']).toEqual(["'self'"]);
  });

  it('refuses a Supabase URL that is not a plain https origin', () => {
    expect(() => buildCsp({ supabaseUrl: 'http://x.test', turnstile: false, dev: false })).toThrow(
      /https/,
    );
    expect(() =>
      buildCsp({ supabaseUrl: 'https://x.test; script-src *', turnstile: false, dev: false }),
    ).toThrow();
  });
});

describe('securityHeaders', () => {
  const headers = Object.fromEntries(
    securityHeaders({ supabaseUrl: SUPABASE, turnstile: false, dev: false }).map((h) => [
      h.key.toLowerCase(),
      h.value,
    ]),
  );

  it('sets the standard set', () => {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('disables powerful browser features the site never uses', () => {
    const p = headers['permissions-policy'] as string;
    for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb'])
      expect(p).toContain(`${f}=()`);
  });

  it('carries the CSP', () => {
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('badgeHeaders', () => {
  it('locks the SVG down: no script, style, image or connection of its own', () => {
    const csp = directives(BADGE_CSP);
    expect(csp['default-src']).toEqual(["'none'"]);
    expect(csp['style-src']).toEqual(["'none'"]);
    expect(csp['sandbox']).toEqual([]);
  });
  it('is sent with nosniff, and replaces the page CSP for the badge only', () => {
    const h = Object.fromEntries(badgeHeaders().map((x) => [x.key.toLowerCase(), x.value]));
    expect(h['content-security-policy']).toBe(BADGE_CSP);
    expect(h['x-content-type-options']).toBe('nosniff');
  });
});
