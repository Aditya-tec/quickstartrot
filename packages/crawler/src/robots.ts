import robotsParserModule from 'robots-parser';
import { CrawlError } from './errors.js';

// robots-parser ships CJS with ESM-style typings; under NodeNext the default import is module.exports.
type RobotsParser = (
  url: string,
  body: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };
const robotsParser = robotsParserModule as unknown as RobotsParser;

/** Product token matched against `User-agent:` lines in robots.txt. */
export const BOT_TOKEN = 'QuickstartRotBot';
export const DEFAULT_BOT_URL = 'https://github.com/Aditya-tec/quickstartrot';

export function botUserAgent(botUrl: string = DEFAULT_BOT_URL): string {
  return `${BOT_TOKEN}/1.0 (+${botUrl})`;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/**
 * Spec section 7, step 1. Follows RFC 9309: a 4xx robots.txt means no restrictions, a 5xx means
 * the site is unreachable and we must assume complete disallow. Throws CrawlError('robots') when
 * the URL is disallowed for our user agent, CrawlError('network') when robots.txt cannot be read.
 */
export async function assertRobotsAllowed(
  url: string,
  userAgent: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const robotsUrl = new URL('/robots.txt', url).href;
  let status: number;
  let body = '';
  try {
    const res = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (status < 400) body = await res.text();
  } catch (err) {
    throw new CrawlError(
      'network',
      `could not fetch robots.txt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (status >= 500)
    throw new CrawlError('robots', `robots.txt unavailable (${status}); assuming disallow`, {
      httpStatus: status,
    });
  if (status >= 400) return;

  const robots = robotsParser(robotsUrl, body);
  if (robots.isAllowed(url, BOT_TOKEN) === false) {
    throw new CrawlError('robots', `robots.txt disallows ${BOT_TOKEN} for ${url}`);
  }
}
