// Configuration, read lazily where it is used and validated there: a missing admin secret never breaks the public
// pages, and a bad value stops only the feature that needs it. Errors name the VARIABLE and never its value.
// The public URL is configuration (NEXT_PUBLIC_SITE_URL), never hard coded in logic.

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Record<string, string | undefined>;
const blank = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === '' ? undefined : v.trim();

function httpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ConfigError(`${name} must be an http(s) URL`);
  return url;
}

/** The public origin of the site (canonical URLs, badge snippets, sitemap, Open Graph). */
export function siteUrl(env: Env = process.env): string {
  const value = blank(env['NEXT_PUBLIC_SITE_URL']);
  if (value === undefined) return 'http://localhost:3100';
  return httpUrl('NEXT_PUBLIC_SITE_URL', value).origin;
}

export function dataMode(env: Env = process.env): 'fixtures' | 'supabase' {
  return env['QSR_DATA'] === 'fixtures' ? 'fixtures' : 'supabase';
}

/** The Supabase project URL and the PUBLIC anon key. A service-role key is refused outright. */
export function supabaseConfig(env: Env = process.env): { url: string; anonKey: string } {
  const url = blank(env['NEXT_PUBLIC_SUPABASE_URL']);
  const anonKey = blank(env['NEXT_PUBLIC_SUPABASE_ANON_KEY']);
  if (url === undefined) throw new ConfigError('NEXT_PUBLIC_SUPABASE_URL is not set');
  if (anonKey === undefined) throw new ConfigError('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
  const parsed = httpUrl('NEXT_PUBLIC_SUPABASE_URL', url);
  const parts = anonKey.split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as {
        role?: unknown;
      };
      if (claims.role === 'service_role')
        throw new ConfigError(
          'NEXT_PUBLIC_SUPABASE_ANON_KEY holds a service-role key; only the anon key may be used here',
        );
    } catch (err) {
      if (err instanceof ConfigError) throw err;
    }
  }
  return { url: parsed.origin, anonKey };
}

const MIN_SECRET = 32;

/** What the admin area needs: the API, the bearer token (server side only) and the session signing secret. */
export function adminConfig(env: Env = process.env): {
  apiBaseUrl: string;
  adminToken: string;
  sessionSecret: string;
} {
  const api = blank(env['API_BASE_URL']);
  const token = blank(env['ADMIN_TOKEN']);
  const secret = blank(env['ADMIN_SESSION_SECRET']);
  if (api === undefined) throw new ConfigError('API_BASE_URL is not set');
  if (token === undefined) throw new ConfigError('ADMIN_TOKEN is not set');
  if (secret === undefined) throw new ConfigError('ADMIN_SESSION_SECRET is not set');
  if (token.length < MIN_SECRET)
    throw new ConfigError(`ADMIN_TOKEN must be at least ${MIN_SECRET} characters`);
  if (secret.length < MIN_SECRET)
    throw new ConfigError(`ADMIN_SESSION_SECRET must be at least ${MIN_SECRET} characters`);
  if (secret === token)
    throw new ConfigError('ADMIN_SESSION_SECRET must be different from ADMIN_TOKEN');
  return {
    apiBaseUrl: httpUrl('API_BASE_URL', api).origin,
    adminToken: token,
    sessionSecret: secret,
  };
}

/** The origin of the API (Render). Server side only: the browser never learns it. */
export function apiBaseUrl(env: Env = process.env): string {
  const api = blank(env['API_BASE_URL']);
  if (api === undefined) throw new ConfigError('API_BASE_URL is not set');
  return httpUrl('API_BASE_URL', api).origin;
}

export function revalidateSecret(env: Env = process.env): string {
  const secret = blank(env['REVALIDATE_SECRET']);
  if (secret === undefined) throw new ConfigError('REVALIDATE_SECRET is not set');
  if (secret.length < 16) throw new ConfigError('REVALIDATE_SECRET must be at least 16 characters');
  return secret;
}

/** Shown on /bot only when set to something that looks like an address. */
export function contactEmail(env: Env = process.env): string | null {
  const value = blank(env['NEXT_PUBLIC_CONTACT_EMAIL']);
  return value !== undefined && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? value : null;
}

export function turnstileSiteKey(env: Env = process.env): string | null {
  return blank(env['NEXT_PUBLIC_TURNSTILE_SITE_KEY']) ?? null;
}
