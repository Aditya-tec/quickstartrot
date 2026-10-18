import { expect, test } from '@playwright/test';

// What a link to the site unfurls to.

/** The width and height of a PNG, from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const meta = (html: string, key: string): string | null => {
  const tag = new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]*>`).exec(html)?.[0];
  return tag ? (/content="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
};

test.describe('social cards', () => {
  for (const [name, path, image] of [
    ['home', '/', '/api/og/home'],
    ['methodology', '/methodology', '/api/og/methodology'],
  ] as const) {
    test(`${name}: the page names its image, absolute, and the image is a 1200 by 630 png`, async ({
      request,
    }) => {
      const html = await (await request.get(path)).text();
      const og = meta(html, 'og:image');
      expect(og, `og:image of ${path}`).toMatch(new RegExp(`^https?://[^/]+${image}$`));
      expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'og:title')).toBeTruthy();
      expect(meta(html, 'og:description')).toBeTruthy();
      const res = await request.get(image);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('image/png');
      expect(res.headers()['cache-control']).toMatch(/s-maxage=\d+/);
      expect(pngSize(await res.body())).toEqual({ width: 1200, height: 630 });
    });
  }
});
