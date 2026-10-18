import { getHome, getKnownSlugs, getOgData } from '@/lib/cached';
import { isValidSlug } from '@/lib/badge';
import { DETECTION } from '@/lib/detection';
import { homeImage, methodologyImage, toolImage } from '@/lib/og-image';
import { methodologyCard, ogCard } from '@/lib/og';

// GET /api/og/<slug>: the social image of a tool page. GET /api/og/home: the home page headline. GET /api/og/methodology: what the
// monitor can and cannot see, from the committed detection-power summary (no database, no API). The inputs of a tool image come
// from the same loaders as the pages (getOgData), so the failing error line appears only for a confirmed incident.
export const revalidate = 600;

type Params = Promise<{ slug: string }>;

export async function GET(_req: Request, ctx: { params: Params }): Promise<Response> {
  const { slug } = await ctx.params;
  if (slug === 'home') return homeImage((await getHome()).headline);
  if (slug === 'methodology') return methodologyImage(methodologyCard(DETECTION));
  if (!isValidSlug(slug) || !(await getKnownSlugs()).includes(slug))
    return new Response('Not found', { status: 404 });
  const data = await getOgData(slug);
  if (!data) return new Response('Not found', { status: 404 });
  return toolImage(ogCard(data));
}
