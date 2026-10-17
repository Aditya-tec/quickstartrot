import { COMPILER_VERSION, type PlanCache } from '@qsr/compiler';
import { CrawlError } from '@qsr/crawler';
import {
  PlanImportResponse,
  type Extraction,
  type Logger,
  type PlanImportBody,
  type Target,
} from '@qsr/core';
import { ApiError, type ApiClient } from './api-client.js';

// `qsr plans push` (P9a). Verifying a target locally (`qsr run`) already compiled its plan into the local cache.
// Pushing it to the API's plan cache means the production plan job finds it as a cache hit and asks the model for
// nothing, so one quota is not spent twice on the same page. The server does not trust the push: it recomputes the
// hashes and re-runs the grounding validator on the extraction sent here (apps/api services/plans-import.ts).

export type PushStatus =
  'imported' | 'already_present' | 'would_push' | 'no_local_plan' | 'crawl_failed' | 'rejected';

export interface PushResult {
  slug: string;
  status: PushStatus;
  detail?: string;
}

export interface PlansPushDeps {
  api: Pick<ApiClient, 'wakeApi' | 'get' | 'post'>;
  /** The local plan cache (the files `qsr compile` and `qsr run` write). */
  cache: PlanCache;
  /** Crawls one page. Throws CrawlError. */
  crawl(target: Target): Promise<Extraction>;
  log: Logger;
}

export interface PlansPushOptions {
  targets: readonly Target[];
  /** Crawl and check, but send nothing. */
  dryRun: boolean;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runPlansPush(
  options: PlansPushOptions,
  deps: PlansPushDeps,
): Promise<PushResult[]> {
  const { api, cache, log } = deps;
  if (!options.dryRun) await api.wakeApi();
  const results: PushResult[] = [];

  // One target at a time: one page per domain at a time, as everywhere else, and the first refusal that is about
  // the token or the server (not the plan) stops the run.
  for (const target of options.targets) {
    let extraction: Extraction;
    try {
      extraction = await deps.crawl(target);
    } catch (err) {
      if (!(err instanceof CrawlError)) throw err;
      const status = err.details.httpStatus ? ` ${err.details.httpStatus}` : '';
      results.push({
        slug: target.slug,
        status: 'crawl_failed',
        detail: `${err.reason}${status}: ${err.message}`,
      });
      continue;
    }

    const plan = await cache.get({
      toolSlug: target.slug,
      contentHash: extraction.contentHash,
      compilerVersion: COMPILER_VERSION,
    });
    if (plan === null) {
      results.push({
        slug: target.slug,
        status: 'no_local_plan',
        detail: `no plan on this machine for the page as it is now (hash ${extraction.contentHash.slice(0, 12)}, compiler ${COMPILER_VERSION}); run \`qsr run ${target.slug}\` or \`qsr compile ${target.slug}\` first`,
      });
      continue;
    }
    if (!plan.accepted || plan.ir === null) {
      results.push({
        slug: target.slug,
        status: 'no_local_plan',
        detail: 'the local plan was rejected by the grounding validator; there is nothing to push',
      });
      continue;
    }
    if (options.dryRun) {
      results.push({ slug: target.slug, status: 'would_push' });
      continue;
    }

    const body: PlanImportBody = {
      target,
      extraction,
      plan: {
        contentHash: plan.contentHash,
        compilerVersion: plan.compilerVersion,
        model: plan.model,
        ir: plan.ir,
      },
    };
    try {
      const answer = await api.post('/admin/plans/import', body, PlanImportResponse);
      results.push({ slug: target.slug, status: answer.status });
      log.info({ toolSlug: target.slug, status: answer.status }, 'plan pushed');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403))
        throw new Error(
          `The API refused the admin token (${err.status}). Check ADMIN_TOKEN; nothing more was sent.`,
        );
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        results.push({
          slug: target.slug,
          status: 'rejected',
          detail: err.detail ?? err.title,
        });
        continue;
      }
      throw new Error(`could not push the plan of ${target.slug}: ${messageOf(err)}`);
    }
  }
  return results;
}

/** One line per target, then a total. Plain text for the terminal. */
export function renderPushResults(results: readonly PushResult[]): string {
  const lines = results.map((r) =>
    `${r.slug.padEnd(28)} ${r.status.padEnd(16)} ${r.detail ?? ''}`.trimEnd(),
  );
  const count = (s: PushStatus): number => results.filter((r) => r.status === s).length;
  lines.push(
    '',
    `${count('imported')} imported, ${count('already_present')} already there, ${count('would_push')} would be pushed, ` +
      `${count('no_local_plan')} without a local plan, ${count('crawl_failed')} crawl failures, ${count('rejected')} refused.`,
  );
  return `${lines.join('\n')}\n`;
}
