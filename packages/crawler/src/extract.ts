import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { type Extraction, type Logger, noopLogger, PIPELINE, type Target } from '@qsr/core';
import { CrawlError } from './errors.js';
import { contentHash, normalizeBlocks, type RawBlock } from './normalize.js';
import { collectBlocks } from './page-script.js';
import { assertRobotsAllowed, botUserAgent, type FetchLike } from './robots.js';
import { applyVariants } from './variants.js';

export interface ExtractOptions {
  browser: Browser;
  /** If set, a Playwright trace is written here when the crawl fails (uploaded to private storage). */
  traceDir?: string;
  /** Contact page shown in the User-Agent (spec: `+https://<site>/bot`). */
  botUrl?: string;
  log?: Logger;
  /** Injected for tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Override the 30 s wait for extract.root to become visible (tests only). */
  rootTimeoutMs?: number;
}

const NAV_TIMEOUT_MS = 30_000;
const IDLE_CAP_MS = 5_000;
const SETTLE_MS = 300;
/** One retry, for network errors only; the delay is the methodology's number (PIPELINE in @qsr/core). */
export const CRAWL_RETRY_DELAY_MS = PIPELINE.crawlRetryDelaySeconds * 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Spec section 7. Turns one docs URL into a normalized, hashable Extraction.
 * One request per tool per cycle; the single permitted retry is for network errors (10 s later).
 * Throws CrawlError for every failure mode, which callers record as a CRAWL_ERROR result.
 */
export async function extract(target: Target, opts: ExtractOptions): Promise<Extraction> {
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? noopLogger;
  try {
    return await attempt(target, opts);
  } catch (err) {
    if (!(err instanceof CrawlError) || !err.retriable) throw err;
    log.warn(
      { toolSlug: target.slug, reason: err.reason },
      'crawl network error, retrying once in 10s',
    );
    await sleep(CRAWL_RETRY_DELAY_MS);
    return attempt(target, opts);
  }
}

async function attempt(target: Target, opts: ExtractOptions): Promise<Extraction> {
  const userAgent = botUserAgent(opts.botUrl);
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const log = opts.log ?? noopLogger;
  const now = opts.now ?? (() => new Date());

  await assertRobotsAllowed(target.docsUrl, userAgent, fetchImpl);

  const context = await opts.browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  if (opts.traceDir) await context.tracing.start({ screenshots: true, snapshots: true });

  try {
    const page = await context.newPage();
    const extraction = await crawlPage(page, target, now, opts.rootTimeoutMs ?? NAV_TIMEOUT_MS);
    if (opts.traceDir) await context.tracing.stop();
    log.info(
      {
        toolSlug: target.slug,
        blocks: extraction.blocks.length,
        contentHash: extraction.contentHash,
      },
      'crawl ok',
    );
    return extraction;
  } catch (err) {
    const tracePath = await saveTrace(context, opts.traceDir, target.slug);
    if (err instanceof CrawlError) {
      throw new CrawlError(err.reason, err.message, {
        ...err.details,
        ...(tracePath ? { tracePath } : {}),
      });
    }
    throw err;
  } finally {
    await context.close();
  }
}

async function saveTrace(
  context: BrowserContext,
  dir: string | undefined,
  slug: string,
): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug}-${Date.now()}.zip`);
    await context.tracing.stop({ path: file });
    return file;
  } catch {
    return undefined;
  }
}

async function crawlPage(
  page: Page,
  target: Target,
  now: () => Date,
  rootTimeoutMs: number,
): Promise<Extraction> {
  const { docsUrl, extract: cfg } = target;

  let status: number | undefined;
  try {
    const response = await page.goto(docsUrl, { waitUntil: 'domcontentloaded' });
    status = response?.status();
  } catch (err) {
    throw classifyNavigationError(err);
  }
  if (status !== undefined && status >= 400) {
    throw new CrawlError('http_status', `docs page returned HTTP ${status}`, {
      httpStatus: status,
    });
  }

  try {
    await page.locator(cfg.root).first().waitFor({ state: 'visible', timeout: rootTimeoutMs });
  } catch {
    throw new CrawlError('missing_root', `selector "${cfg.root}" never became visible`, {
      finalUrl: page.url(),
    });
  }
  // Many docs sites never go fully idle, so cap the wait.
  await page.waitForLoadState('networkidle', { timeout: IDLE_CAP_MS }).catch(() => undefined);

  if (cfg.tab) {
    await page.evaluate(
      ({ root, tab }) => {
        const wanted = tab.trim().toLowerCase();
        const scope = document.querySelector(root);
        scope?.querySelectorAll<HTMLElement>('[role=tab]').forEach((t) => {
          if ((t.textContent ?? '').trim().toLowerCase() === wanted) t.click();
        });
      },
      { root: cfg.root, tab: cfg.tab },
    );
    await page.waitForTimeout(SETTLE_MS);
  }

  await page.evaluate((root) => {
    document
      .querySelector(root)
      ?.querySelectorAll<HTMLElement>('details:not([open]) > summary')
      .forEach((s) => s.click());
  }, cfg.root);
  await page.waitForTimeout(SETTLE_MS);

  const raw: RawBlock[] = await page.evaluate(collectBlocks, {
    root: cfg.root,
    codeBlocks: cfg.codeBlocks,
  });
  const normalized = normalizeBlocks(raw, cfg.ignoreBlocksMatching);
  const resolved = cfg.variants ? applyVariants(normalized, cfg.variants) : null;
  const blocks = resolved ? resolved.blocks : normalized;
  const finalUrl = page.url();

  if (!blocks.some((b) => b.kind === 'code')) {
    throw new CrawlError(
      'no_code_blocks',
      `no code blocks matched "${cfg.codeBlocks}" under "${cfg.root}"`,
      {
        finalUrl,
      },
    );
  }

  return {
    url: docsUrl,
    finalUrl,
    title: await page.title(),
    fetchedAt: now().toISOString(),
    blocks,
    contentHash: contentHash(blocks, resolved?.report, target.extract.hashIgnore),
    ...(resolved ? { variants: resolved.report } : {}),
  };
}

function classifyNavigationError(err: unknown): CrawlError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new CrawlError('navigation_timeout', `navigation timed out after ${NAV_TIMEOUT_MS} ms`);
  }
  return new CrawlError('network', message.split('\n')[0] ?? message);
}
