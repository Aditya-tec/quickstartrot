/** Why a crawl failed. All of these map to the CRAWL_ERROR failure class (spec section 7). */
export const CRAWL_ERROR_REASONS = [
  'robots', // robots.txt disallows our user agent: tool is disabled until reviewed
  'http_status', // 4xx/5xx from the docs page
  'navigation_timeout',
  'network',
  'missing_root', // extract.root never became visible
  'no_code_blocks', // usually a selector that needs updating, or the docs moved
] as const;
export type CrawlErrorReason = (typeof CRAWL_ERROR_REASONS)[number];

export class CrawlError extends Error {
  override readonly name = 'CrawlError';

  constructor(
    readonly reason: CrawlErrorReason,
    message: string,
    readonly details: { httpStatus?: number; tracePath?: string; finalUrl?: string } = {},
  ) {
    super(message);
  }

  /** Network-level failures are retried once after 10 s; nothing else is ever retried. */
  get retriable(): boolean {
    return this.reason === 'network' || this.reason === 'navigation_timeout';
  }
}
