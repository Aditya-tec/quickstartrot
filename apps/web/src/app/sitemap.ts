import type { MetadataRoute } from 'next';
import { getHome } from '@/lib/cached';
import { siteUrl } from '@/lib/env';

export const revalidate = 3600;

const STATIC = ['/', '/incidents', '/methodology', '/bot', '/submit'] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = siteUrl();
  let slugs: string[] = [];
  try {
    const home = await getHome();
    slugs = [...home.tested, ...home.needsPerson, ...home.notTested].map((t) => t.slug);
  } catch {
    slugs = []; // the data source is down: still serve the fixed pages
  }
  return [
    ...STATIC.map((path) => ({
      url: `${site}${path === '/' ? '' : path}`,
      changeFrequency: 'daily' as const,
    })),
    ...slugs.map((slug) => ({ url: `${site}/tools/${slug}`, changeFrequency: 'daily' as const })),
  ];
}
