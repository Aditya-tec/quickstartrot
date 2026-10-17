import {
  BADGE_CACHE_CONTROL,
  badgeFor,
  isValidSlug,
  renderBadge,
  type BadgeStatus,
} from '@/lib/badge';
import { getBadgeStatus } from '@/lib/cached';

// GET /api/badge/<slug>: the README badge, a self-contained SVG. Any slug is accepted from anyone, so it is
// validated with a strict pattern and never reflected into the image; an unknown or malformed slug is shown as
// "not tracked". The status comes from the same function as every page (a failure is "failing" only once a
// person confirmed the incident; until then it is "verifying").
export const revalidate = 600;

type Params = Promise<{ slug: string }>;

// The image never needs a script, a style or any other resource.
const SVG_HEADERS = {
  'content-type': 'image/svg+xml; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'none'; sandbox",
  'x-content-type-options': 'nosniff',
} as const;

export async function GET(_req: Request, ctx: { params: Params }): Promise<Response> {
  const { slug: raw } = await ctx.params;
  const slug = raw.endsWith('.svg') ? raw.slice(0, -4) : raw;
  let status: BadgeStatus = 'not_tracked';
  let cache = BADGE_CACHE_CONTROL;
  if (isValidSlug(slug)) {
    try {
      status = await getBadgeStatus(slug);
    } catch {
      status = 'unknown'; // the data source is down: say so, and do not let the CDN keep it for long
      cache = 'public, max-age=0, s-maxage=60';
    }
  }
  return new Response(renderBadge(badgeFor(status)), {
    status: 200,
    headers: { ...SVG_HEADERS, 'cache-control': cache },
  });
}
