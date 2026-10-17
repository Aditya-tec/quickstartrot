import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  adminConfig,
  apiBaseUrl,
  contactEmail,
  dataMode,
  revalidateSecret,
  siteUrl,
  supabaseConfig,
  turnstileSiteKey,
} from './env.js';

// Configuration is read lazily and validated where it is used, so a missing admin secret never breaks the public
// pages. Errors name the VARIABLE, never its value. The public URL is configuration, never hard coded in logic.

type Env = Record<string, string | undefined>;

describe('siteUrl', () => {
  it('is NEXT_PUBLIC_SITE_URL without a trailing slash, and defaults to localhost for development', () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: 'https://quickstartrot.vercel.app/' })).toBe(
      'https://quickstartrot.vercel.app',
    );
    expect(siteUrl({})).toBe('http://localhost:3100');
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: '' })).toBe('http://localhost:3100');
  });

  it('refuses something that is not an http(s) origin', () => {
    expect(() => siteUrl({ NEXT_PUBLIC_SITE_URL: 'javascript:alert(1)' })).toThrow(
      /NEXT_PUBLIC_SITE_URL/,
    );
    expect(() => siteUrl({ NEXT_PUBLIC_SITE_URL: 'quickstartrot.vercel.app' })).toThrow(
      ConfigError,
    );
  });
});

describe('dataMode', () => {
  it('is "fixtures" only when QSR_DATA says so', () => {
    expect(dataMode({ QSR_DATA: 'fixtures' })).toBe('fixtures');
    expect(dataMode({})).toBe('supabase');
    expect(dataMode({ QSR_DATA: 'FIXTURES' })).toBe('supabase');
    expect(dataMode({ QSR_DATA: 'live' })).toBe('supabase');
  });
});

describe('supabaseConfig', () => {
  it('needs the public URL and the anon key, and names the one that is missing', () => {
    expect(
      supabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k'.repeat(40),
      }),
    ).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'k'.repeat(40),
    });
    expect(() => supabaseConfig({ NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
    expect(() => supabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it('refuses a service-role key: only the anon key may ever be configured here', () => {
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    expect(() =>
      supabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt,
      }),
    ).toThrow(/anon/i);
  });

  it('never repeats the key in an error', () => {
    try {
      supabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: 'not a url',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'secret-anon-key-value-0123456789',
      });
    } catch (e) {
      expect(String(e)).not.toContain('secret-anon-key-value');
    }
  });
});

describe('adminConfig', () => {
  const good: Env = {
    API_BASE_URL: 'https://quickstartrot-api.onrender.com/',
    ADMIN_TOKEN: 'a'.repeat(32),
    ADMIN_SESSION_SECRET: 'b'.repeat(32),
  };

  it('returns the three values, with the API URL trimmed of a trailing slash', () => {
    expect(adminConfig(good)).toEqual({
      apiBaseUrl: 'https://quickstartrot-api.onrender.com',
      adminToken: 'a'.repeat(32),
      sessionSecret: 'b'.repeat(32),
    });
  });

  it.each(['API_BASE_URL', 'ADMIN_TOKEN', 'ADMIN_SESSION_SECRET'])(
    'names %s when it is missing',
    (name) => {
      expect(() => adminConfig({ ...good, [name]: undefined })).toThrow(new RegExp(name));
    },
  );

  it('wants long secrets, and different ones for the token and the session', () => {
    expect(() => adminConfig({ ...good, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => adminConfig({ ...good, ADMIN_SESSION_SECRET: 'short' })).toThrow(
      /ADMIN_SESSION_SECRET/,
    );
    expect(() => adminConfig({ ...good, ADMIN_SESSION_SECRET: good['ADMIN_TOKEN'] })).toThrow(
      /different/i,
    );
  });

  it('never repeats a secret in an error', () => {
    try {
      adminConfig({ ...good, ADMIN_TOKEN: 'tiny-secret-token' });
    } catch (e) {
      expect(String(e)).not.toContain('tiny-secret-token');
    }
  });
});

describe('the small optional settings', () => {
  it('revalidateSecret is required and long enough', () => {
    expect(revalidateSecret({ REVALIDATE_SECRET: 'r'.repeat(16) })).toBe('r'.repeat(16));
    expect(() => revalidateSecret({})).toThrow(/REVALIDATE_SECRET/);
    expect(() => revalidateSecret({ REVALIDATE_SECRET: 'short' })).toThrow(/REVALIDATE_SECRET/);
  });

  it('contactEmail is null unless it is set to something that looks like an address', () => {
    expect(contactEmail({})).toBeNull();
    expect(contactEmail({ NEXT_PUBLIC_CONTACT_EMAIL: '' })).toBeNull();
    expect(contactEmail({ NEXT_PUBLIC_CONTACT_EMAIL: 'bot@example.org' })).toBe('bot@example.org');
    expect(contactEmail({ NEXT_PUBLIC_CONTACT_EMAIL: 'not an email' })).toBeNull();
  });

  it('turnstileSiteKey is null unless set', () => {
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAA' })).toBe('0x4AAAA');
  });
});

describe('apiBaseUrl', () => {
  it('is the origin of API_BASE_URL', () => {
    expect(apiBaseUrl({ API_BASE_URL: 'https://api.example.com/' })).toBe(
      'https://api.example.com',
    );
  });
  it('names the variable when it is missing or not a URL', () => {
    expect(() => apiBaseUrl({})).toThrow(/API_BASE_URL/);
    expect(() => apiBaseUrl({ API_BASE_URL: 'ftp://x' })).toThrow(/API_BASE_URL/);
    expect(() => apiBaseUrl({ API_BASE_URL: 'nonsense' })).toThrow(/API_BASE_URL/);
  });
});
