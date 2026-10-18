import { beforeEach, describe, expect, it, vi } from 'vitest';

// Any slug is accepted from anyone. A slug that is not tracked must cost nothing: no lookup of its status and no cache entry of its own,
// so a script asking for thousands of made-up slugs cannot turn into thousands of database queries.

const cached = vi.hoisted(() => ({
  getKnownSlugs: vi.fn<() => Promise<string[]>>(),
  getBadgeStatus: vi.fn<(slug: string) => Promise<string>>(),
}));
vi.mock('@/lib/cached', () => cached);

import { GET } from './route';

const call = async (slug: string): Promise<{ res: Response; body: string }> => {
  const res = await GET(new Request(`https://site.test/api/badge/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  return { res, body: await res.text() };
};

beforeEach(() => {
  cached.getKnownSlugs.mockReset().mockResolvedValue(['ably-node', 'resend-node']);
  cached.getBadgeStatus.mockReset().mockResolvedValue('passing');
});

describe('GET /api/badge/<slug>', () => {
  it('looks up the status of a tracked slug', async () => {
    const { res, body } = await call('ably-node');
    expect(cached.getBadgeStatus).toHaveBeenCalledWith('ably-node');
    expect(body).toContain('passing');
    expect(res.headers.get('cache-control')).toMatch(/s-maxage=600/);
  });

  it('says "not tracked" for a well-formed slug that is not tracked, without looking its status up', async () => {
    const { body, res } = await call('some-made-up-slug');
    expect(body).toContain('not tracked');
    expect(cached.getBadgeStatus).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toMatch(/s-maxage=600/);
  });

  it('says "not tracked" for a malformed slug without asking for anything', async () => {
    const { body } = await call('Not A Slug!');
    expect(body).toContain('not tracked');
    expect(cached.getKnownSlugs).not.toHaveBeenCalled();
    expect(cached.getBadgeStatus).not.toHaveBeenCalled();
  });

  it('accepts a .svg suffix', async () => {
    await call('ably-node.svg');
    expect(cached.getBadgeStatus).toHaveBeenCalledWith('ably-node');
  });

  it('when the data is unavailable shows "unknown" and does not let a CDN keep it for long', async () => {
    cached.getKnownSlugs.mockRejectedValue(new Error('supabase down'));
    const { body, res } = await call('ably-node');
    expect(body).toContain('unknown');
    expect(res.headers.get('cache-control')).toMatch(/s-maxage=60\b/);
  });
});
