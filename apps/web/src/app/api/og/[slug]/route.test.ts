import { beforeEach, describe, expect, it, vi } from 'vitest';

// The social image of a tool. An unknown slug is a 404 that costs no lookup and no cache entry. (The drawing itself is checked in the
// end-to-end suite; here it is replaced, because it needs a browser-like runtime.)

const cached = vi.hoisted(() => ({
  getKnownSlugs: vi.fn<() => Promise<string[]>>(),
  getOgData: vi.fn<(slug: string) => Promise<unknown>>(),
  getHome: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('@/lib/cached', () => cached);
vi.mock('@/lib/og-image', () => ({
  homeImage: () => new Response('home', { status: 200 }),
  toolImage: () => new Response('tool', { status: 200 }),
  methodologyImage: () => new Response('methodology', { status: 200 }),
}));

import { GET } from './route';

const call = async (slug: string): Promise<Response> =>
  GET(new Request(`https://site.test/api/og/${slug}`), { params: Promise.resolve({ slug }) });

beforeEach(() => {
  cached.getKnownSlugs.mockReset().mockResolvedValue(['ably-node']);
  cached.getOgData
    .mockReset()
    .mockResolvedValue({ name: 'Ably', status: 'passing', failingSince: null, errorLine: null });
  cached.getHome.mockReset().mockResolvedValue({ headline: {} });
});

describe('GET /api/og/<slug>', () => {
  it('draws a tracked tool', async () => {
    expect(await (await call('ably-node')).text()).toBe('tool');
    expect(cached.getOgData).toHaveBeenCalledWith('ably-node');
  });

  it('draws the home card and the methodology card without touching the tool loaders', async () => {
    expect(await (await call('methodology')).text()).toBe('methodology');
    expect(await (await call('home')).text()).toBe('home');
    expect(cached.getOgData).not.toHaveBeenCalled();
    expect(cached.getKnownSlugs).not.toHaveBeenCalled();
  });

  it('is a 404 for a well-formed slug that is not tracked, without looking it up', async () => {
    const res = await call('some-made-up-slug');
    expect(res.status).toBe(404);
    expect(cached.getOgData).not.toHaveBeenCalled();
  });

  it('is a 404 for a malformed slug without asking for anything', async () => {
    const res = await call('Not A Slug!');
    expect(res.status).toBe(404);
    expect(cached.getKnownSlugs).not.toHaveBeenCalled();
    expect(cached.getOgData).not.toHaveBeenCalled();
  });
});
