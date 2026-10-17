import { getHome, getOgData } from '@/lib/cached';
import { isValidSlug } from '@/lib/badge';
import { homeImage, toolImage } from '@/lib/og-image';
import { ogCard } from '@/lib/og';

// GET /api/og/<slug>: the social image of a tool page. GET /api/og/home: the home page headline. The inputs come
// from the same loaders as the pages (getOgData), so the failing error line appears only for a confirmed incident.
export const revalidate = 600;

type Params = Promise<{ slug: string }>;

export async function GET(_req: Request, ctx: { params: Params }): Promise<Response> {
  const { slug } = await ctx.params;
  if (slug === 'home') return homeImage((await getHome()).headline);
  if (!isValidSlug(slug)) return new Response('Not found', { status: 404 });
  const data = await getOgData(slug);
  if (!data) return new Response('Not found', { status: 404 });
  return toolImage(ogCard(data));
}
