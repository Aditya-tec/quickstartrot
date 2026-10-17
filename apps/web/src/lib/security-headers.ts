// Security headers and the Content-Security-Policy (spec section 14). Pure, so a unit test pins every directive
// and next.config.ts only calls it.
//
// script-src keeps 'unsafe-inline': Next.js puts its hydration payload in inline <script> tags, and a nonce
// would force every page to render per request, which would give up the ISR the site relies on. The
// mitigations are that no third-party script is ever allowed, no raw-HTML injection exists anywhere in
// the app (a lint rule and a test enforce it) and React escapes everything else. 'unsafe-eval' is development only.

export interface CspOptions {
  /** The Supabase project URL: the log viewer reads public-artifacts from the browser. null for fixtures. */
  supabaseUrl: string | null;
  /** Cloudflare Turnstile is loaded on /submit only when its site key is configured. */
  turnstile: boolean;
  dev: boolean;
}

const TURNSTILE = 'https://challenges.cloudflare.com';

function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('the Supabase URL is not a URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname.replace(/\/+$/, '') !== '' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('the Supabase URL must be a plain https origin');
  return parsed.origin;
}

export function buildCsp(options: CspOptions): string {
  const supabase = options.supabaseUrl ? originOf(options.supabaseUrl) : null;
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(options.dev ? ["'unsafe-eval'"] : []),
      ...(options.turnstile ? [TURNSTILE] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(supabase ? [supabase] : []), ...(options.dev ? ['ws:'] : [])],
    ...(options.turnstile ? { 'frame-src': [TURNSTILE] } : {}),
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export interface Header {
  key: string;
  value: string;
}

export function securityHeaders(options: CspOptions): Header[] {
  return [
    { key: 'Content-Security-Policy', value: buildCsp(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    {
      key: 'Permissions-Policy',
      value: [
        'camera',
        'microphone',
        'geolocation',
        'payment',
        'usb',
        'bluetooth',
        'accelerometer',
        'gyroscope',
        'magnetometer',
      ]
        .map((f) => `${f}=()`)
        .join(', '),
    },
  ];
}

/** The README badge is an SVG that needs nothing at all, so it gets the tightest possible policy. */
export const BADGE_CSP = "default-src 'none'; style-src 'none'; sandbox";

/** Replaces the page headers for /api/badge/*: Next applies the later matching rule, so this one wins. */
export function badgeHeaders(): Header[] {
  return [
    { key: 'Content-Security-Policy', value: BADGE_CSP },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
  ];
}
