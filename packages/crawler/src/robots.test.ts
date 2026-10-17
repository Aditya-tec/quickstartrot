import { describe, expect, it } from 'vitest';
import { CrawlError } from './errors.js';
import {
  assertRobotsAllowed,
  botUserAgent,
  DEFAULT_BOT_URL,
  resolveBotUrl,
  type FetchLike,
} from './robots.js';

const ua = botUserAgent();
const respond =
  (status: number, body = ''): FetchLike =>
  async () => ({ status, text: async () => body });

describe('botUserAgent', () => {
  it('identifies the bot with a contact URL', () => {
    expect(ua).toMatch(/^QuickstartRotBot\/1\.0 \(\+https:\/\/.+\)$/);
  });
});

describe('the user agent string', () => {
  it('is exactly QuickstartRotBot/1.0 (+<bot page>), and the default bot page is the site /bot page', () => {
    expect(DEFAULT_BOT_URL).toBe('https://quickstartrot.vercel.app/bot');
    expect(botUserAgent()).toBe('QuickstartRotBot/1.0 (+https://quickstartrot.vercel.app/bot)');
    expect(botUserAgent('https://bots.example.org/qsr')).toBe(
      'QuickstartRotBot/1.0 (+https://bots.example.org/qsr)',
    );
  });
});

describe('resolveBotUrl (BOT_INFO_URL from configuration)', () => {
  it('falls back to the default when nothing is configured, including an empty variable', () => {
    expect(resolveBotUrl(undefined)).toBe(DEFAULT_BOT_URL);
    expect(resolveBotUrl('')).toBe(DEFAULT_BOT_URL);
    expect(resolveBotUrl('   ')).toBe(DEFAULT_BOT_URL);
  });

  it('accepts an https URL, trimmed', () => {
    expect(resolveBotUrl('  https://example.org/bot  ')).toBe('https://example.org/bot');
  });

  it.each(['not a url', 'http://example.org/bot', 'javascript:alert(1)', 'ftp://x/y', 'https://'])(
    'refuses %s loudly, so a typo cannot silently put a wrong contact in every request',
    (bad) => {
      expect(() => resolveBotUrl(bad)).toThrow(/BOT_INFO_URL/);
    },
  );

  it('refuses a value that could break a header or the product comment', () => {
    expect(() => resolveBotUrl('https://example.org/bot\r\nX-Evil: 1')).toThrow(/BOT_INFO_URL/);
    expect(() => resolveBotUrl('https://example.org/a b')).toThrow(/BOT_INFO_URL/);
    expect(() => resolveBotUrl('https://example.org/a)b')).toThrow(/BOT_INFO_URL/);
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
