import { describe, expect, it } from 'vitest';
import { CrawlError } from './errors.js';
import { assertRobotsAllowed, botUserAgent, type FetchLike } from './robots.js';

const ua = botUserAgent();
const respond =
  (status: number, body = ''): FetchLike =>
  async () => ({ status, text: async () => body });

describe('botUserAgent', () => {
  it('identifies the bot with a contact URL', () => {
    expect(ua).toMatch(/^QuickstartRotBot\/1\.0 \(\+https:\/\/.+\)$/);
  });
});

describe('assertRobotsAllowed', () => {
  it('allows when robots.txt is missing (4xx means no restrictions)', async () => {
    await expect(
      assertRobotsAllowed('https://x.test/docs', ua, respond(404)),
    ).resolves.toBeUndefined();
  });

  it('allows paths not covered by a rule for our token', async () => {
    const robots = 'User-agent: QuickstartRotBot\nDisallow: /private/\n';
    await expect(
      assertRobotsAllowed('https://x.test/docs/start', ua, respond(200, robots)),
    ).resolves.toBeUndefined();
  });

  it('rejects with reason "robots" when our token is disallowed', async () => {
    const robots = 'User-agent: QuickstartRotBot\nDisallow: /docs/\n';
    await expect(
      assertRobotsAllowed('https://x.test/docs/start', ua, respond(200, robots)),
    ).rejects.toMatchObject({
      name: 'CrawlError',
      reason: 'robots',
    });
  });

  it('rejects when a wildcard group disallows everything', async () => {
    const robots = 'User-agent: *\nDisallow: /\n';
    await expect(
      assertRobotsAllowed('https://x.test/docs', ua, respond(200, robots)),
    ).rejects.toMatchObject({
      reason: 'robots',
    });
  });

  it('assumes complete disallow when robots.txt is a 5xx (RFC 9309)', async () => {
    await expect(
      assertRobotsAllowed('https://x.test/docs', ua, respond(503)),
    ).rejects.toMatchObject({
      reason: 'robots',
      details: { httpStatus: 503 },
    });
  });

  it('reports a retriable network error when robots.txt cannot be fetched', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const err = await assertRobotsAllowed('https://x.test/docs', ua, failing).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrawlError);
    expect((err as CrawlError).reason).toBe('network');
    expect((err as CrawlError).retriable).toBe(true);
  });

  it('requests robots.txt at the origin root with our user agent', async () => {
    let seen: { url: string; ua: string | undefined } | undefined;
    const spy: FetchLike = async (url, init) => {
      seen = { url, ua: init?.headers?.['user-agent'] };
      return { status: 404, text: async () => '' };
    };
    await assertRobotsAllowed('https://x.test/a/b/c?d=1', ua, spy);
    expect(seen).toEqual({ url: 'https://x.test/robots.txt', ua });
  });
});
