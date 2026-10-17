import path from 'node:path';
import type { NextConfig } from 'next';
import { badgeHeaders, securityHeaders } from './src/lib/security-headers';

// Strict CSP and the other security headers come from one tested function (src/lib/security-headers.ts).
// Fonts are bundled (the `geist` package), so there is no request to a font host, and no third-party script.
const dev = process.env['NODE_ENV'] !== 'production';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Metadata (title, description, canonical, Open Graph) is in <head> for every visitor, not streamed after the
  // body, so a crawler or a link preview that is not on Next's bot list still sees it.
  htmlLimitedBots: /.*/,
  // a monorepo: trace files from the repository root so the workspace package @qsr/core is included
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({
          supabaseUrl: process.env['NEXT_PUBLIC_SUPABASE_URL']?.trim() || null,
          turnstile: Boolean(process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY']?.trim()),
          dev,
        }),
      },
      // later rules win for the same header: the badge image gets its own, tighter policy
      { source: '/api/badge/:slug', headers: badgeHeaders() },
    ];
  },
};

export default config;
