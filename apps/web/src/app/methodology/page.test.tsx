import { describe, expect, it } from 'vitest';
import { metadata } from './page';

// What a link to /methodology unfurls to. The home page gets /api/og/home from the root layout; this page has its own card, and it
// must name it: a page-level openGraph replaces the layout's, so without images here the link would unfurl with no picture.
describe('/methodology metadata', () => {
  const og = metadata.openGraph;
  const image = (list: unknown): { url: string; width?: number; height?: number } | undefined =>
    Array.isArray(list) ? (list[0] as { url: string }) : undefined;

  it('has its own social image, 1200 by 630, from the og route', () => {
    const first = image(og?.images);
    expect(first?.url).toBe('/api/og/methodology');
    expect(first?.width).toBe(1200);
    expect(first?.height).toBe(630);
  });

  it('repeats title, description and canonical url so a preview does not fall back to the home page’s', () => {
    expect(og?.title).toBe('Methodology');
    expect(typeof og?.description).toBe('string');
    expect((og as { url?: string }).url).toBe('/methodology');
    expect(metadata.alternates?.canonical).toBe('/methodology');
  });

  it('asks for the large card on Twitter, with the same image', () => {
    const tw = metadata.twitter as { card?: string; images?: unknown[] } | null | undefined;
    expect(tw?.card).toBe('summary_large_image');
    expect(tw?.images?.[0]).toBe('/api/og/methodology');
  });
});
