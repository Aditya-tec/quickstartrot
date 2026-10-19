import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OPT_OUT } from '@qsr/core/public';
import { BadgeSnippets } from '@/components/badge-snippets';
import { DotLegend, DotStrip } from '@/components/dot-strip';
import { IncidentCard } from '@/components/incident-card';
import { LevelBadge } from '@/components/level-badge';
import { OptedOutPill, StatusPill } from '@/components/status-pill';
import { StepTimeline } from '@/components/step-timeline';
import { getKnownSlugs, getToolPage } from '@/lib/cached';
import { getNow } from '@/lib/data';
import { siteUrl } from '@/lib/env';
import { FACTS, words } from '@/lib/facts';
import {
  EM_DASH,
  formatDateTime,
  formatDay,
  formatDuration,
  formatPercent,
  relativeTime,
} from '@/lib/format';
import { LEVEL_DESCRIPTION, levelLabel } from '@/lib/status-style';

export const revalidate = 300;

type Params = Promise<{ slug: string }>;

/** A slug nobody tracks is a 404 answered from the one cached list: no lookup and no cache entry of its own. */
async function pageFor(slug: string): Promise<Awaited<ReturnType<typeof getToolPage>>> {
  return (await getKnownSlugs()).includes(slug) ? getToolPage(slug) : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const page = await pageFor(slug);
  if (!page) return { title: 'Quickstart not found', robots: { index: false } };
  const { tool } = page;
  const title = `${tool.name} quickstart status`;
  const description =
    tool.optedOutAt !== null
      ? `${tool.name}: ${OPT_OUT.pageLabel.toLowerCase()}.`
      : tool.status === 'failing'
        ? `${tool.name} quickstart failing since ${formatDay(tool.failingSince)}.`
        : `Is the ${tool.name} quickstart passing its checks? Installed and tested on a fresh machine about every ${words(FACTS.cycleHours)} hours.`;
  const og = `${siteUrl()}/api/og/${tool.slug}`;
  return {
    title,
    description,
    alternates: { canonical: `/tools/${tool.slug}` },
    openGraph: {
      title,
      description,
      url: `/tools/${tool.slug}`,
      images: [{ url: og, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [og] },
  };
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="tabular mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

export default async function ToolPage({ params }: { params: Params }) {
  const { slug } = await params;
  const page = await pageFor(slug);
  if (!page) notFound();
  const { tool, strip, openIncident, incidents, latestRun } = page;
  const now = getNow();
  const optedOut = tool.optedOutAt !== null;
  const streakText =
    tool.streak.count === 0
      ? EM_DASH
      : `${tool.streak.count} ${tool.streak.kind === 'pass' ? 'passing' : 'failed'} in a row`;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link href="/" className="underline underline-offset-2 hover:text-foreground">
          All quickstarts
        </Link>
      </nav>

      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-words text-3xl font-semibold tracking-tight sm:text-4xl">
            {tool.name}
          </h1>
          {optedOut ? <OptedOutPill /> : <StatusPill status={tool.status} />}
          {optedOut ? null : <LevelBadge level={tool.level} />}
        </div>
        <p className="mt-2 text-sm text-muted">
          {optedOut
            ? `Probing stopped on ${formatDay(tool.optedOutAt)}. ${
                tool.historyHidden
                  ? "At the vendor's request, the past results are not shown."
                  : 'The results below are from before probing stopped.'
              }`
            : tool.status === 'failing'
              ? `Quickstart failing since ${formatDay(tool.failingSince)}.`
              : tool.status === 'verifying'
                ? `A failure was seen${tool.statusSince ? ` on ${formatDay(tool.statusSince)}` : ''} and is being verified. Details are published after a person reviews them.`
                : tool.status === 'passing'
                  ? 'The quickstart ran to its target level in the latest cycle.'
                  : tool.status === 'needs_person'
                    ? 'The quickstart stops at a step only a person can do, so a fresh machine cannot finish it. This is not a failure.'
                    : 'This quickstart has not completed a test run yet.'}
        </p>
        <p className="mt-2 text-sm">
          <a
            href={tool.docsUrl}
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-accent"
          >
            Read the quickstart docs
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens the vendor site)</span>
          </a>
        </p>
        {optedOut ? null : (
          <p className="mt-1 max-w-3xl text-xs text-muted">
            {LEVEL_DESCRIPTION[levelLabel(tool.level)]}.
          </p>
        )}

        {tool.historyHidden ? null : (
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-4">
            {optedOut ? null : <Stat label="30-day pass rate">{formatPercent(tool.passRate)}</Stat>}
            {optedOut ? null : <Stat label="Current streak">{streakText}</Stat>}
            <Stat label={optedOut ? 'Last checked before probing stopped' : 'Last checked'}>
              {tool.lastRunAt ? (
                <time dateTime={tool.lastRunAt} title={formatDateTime(tool.lastRunAt)}>
                  {relativeTime(tool.lastRunAt, now)}
                </time>
              ) : (
                EM_DASH
              )}
            </Stat>
            <Stat label="Reached level">
              {tool.lastReachedLevel ? levelLabel(tool.lastReachedLevel) : EM_DASH}
            </Stat>
          </dl>
        )}
      </header>

      {tool.historyHidden ? null : (
        <>
          <section aria-labelledby="history" className="mt-10">
            <h2 id="history" className="text-xl font-semibold tracking-tight">
              Last {strip.length || 60} runs
            </h2>
            <p className="mt-1 text-sm text-muted">Oldest on the left. Select a run to open it.</p>
            <div className="mt-3 rounded-lg border border-border bg-surface p-3">
              <DotStrip dots={strip} interactive />
            </div>
            <DotLegend className="mt-3" />
          </section>

          {openIncident ? (
            <section aria-label="Open incident" className="mt-10">
              <IncidentCard incident={openIncident} />
            </section>
          ) : null}

          <section aria-labelledby="latest-run" className="mt-10">
            <h2 id="latest-run" className="text-xl font-semibold tracking-tight">
              Latest run
            </h2>
            {latestRun ? (
              <>
                <p className="mt-1 text-sm text-muted">
                  <time dateTime={latestRun.started_at}>
                    {formatDateTime(latestRun.started_at)}
                  </time>
                  {' · '}
                  <span className="tabular">{formatDuration(latestRun.duration_ms)}</span>
                  {' · '}
                  <Link
                    href={`/runs/${latestRun.id}`}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Full run details
                  </Link>
                  {latestRun.plan_stale ? ' · used an older plan (stale)' : ''}
                </p>
                <div className="mt-4">
                  <StepTimeline run={latestRun} />
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted">No run has been recorded yet.</p>
            )}
          </section>

          {incidents.length > 0 ? (
            <section aria-labelledby="past" className="mt-10">
              <h2 id="past" className="text-xl font-semibold tracking-tight">
                Earlier incidents
              </h2>
              <ul className="mt-3 grid gap-2">
                {incidents.map((i) => (
                  <li key={i.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
                    <span className="font-medium">
                      {formatDay(i.openedAt)}
                      {i.resolvedAt ? ` to ${formatDay(i.resolvedAt)}` : ''}
                    </span>
                    <span className="text-muted">: {i.oneLine}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {tool.coverageNotes.length > 0 ? (
        <section aria-labelledby="not-covered" className="mt-10">
          <h2 id="not-covered" className="text-xl font-semibold tracking-tight">
            What this check does not cover
          </h2>
          <ul className="mt-3 grid max-w-3xl gap-2 text-sm text-muted">
            {tool.coverageNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {optedOut ? null : <BadgeSnippets slug={tool.slug} />}
    </>
  );
}
