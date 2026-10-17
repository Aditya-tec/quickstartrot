import Link from 'next/link';
import { DotLegend } from '@/components/dot-strip';
import { FiltersBar } from '@/components/filters-bar';
import { Headline } from '@/components/headline';
import { LevelBadge } from '@/components/level-badge';
import { StatusPill } from '@/components/status-pill';
import { ToolCards, ToolTable } from '@/components/tool-table';
import { getHome } from '@/lib/cached';
import { getNow } from '@/lib/data';
import { filterAndSort, homeHref, parseHomeParams, DEFAULT_PARAMS } from '@/lib/filters';
import { formatDateTime } from '@/lib/format';

// The leaderboard. Data is cached for 5 minutes and refreshed on demand (see lib/cached.ts). Filters and sort come
// from the URL, so the page is rendered on the server and a view can be shared.
export const revalidate = 300;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const params = parseHomeParams(await searchParams);
  const home = await getHome();
  const now = getNow();
  const shown = filterAndSort(home.tested, params);

  return (
    <>
      <Headline headline={home.headline} tested={home.tested} asOf={home.asOf} />

      <section aria-labelledby="leaderboard">
        <h2 id="leaderboard" className="mb-4 text-xl font-semibold tracking-tight">
          Quickstarts
        </h2>
        <FiltersBar params={params} />
        {shown.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            No quickstarts match these filters.{' '}
            <Link
              href={homeHref(DEFAULT_PARAMS)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Clear the filters
            </Link>
            .
          </p>
        ) : (
          <>
            <ToolTable tools={shown} now={now} />
            <ToolCards tools={shown} now={now} />
          </>
        )}
        <DotLegend className="mt-4" />
      </section>

      {home.needsPerson.length > 0 ? (
        <section aria-labelledby="needs-person" className="mt-12">
          <h2 id="needs-person" className="text-xl font-semibold tracking-tight">
            Needs a person
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            These quickstarts stop at a step only a person can do, such as an interactive prompt or
            a sign-up, so a fresh machine cannot finish them. They are not counted above and are not
            failures.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {home.needsPerson.map((t) => (
              <li
                key={t.slug}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center gap-2">
                  <Link href={`/tools/${t.slug}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <LevelBadge level={t.level} />
                </div>
                <StatusPill status="needs_person" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {home.notTested.length > 0 ? (
        <section aria-labelledby="not-tested" className="mt-12">
          <h2 id="not-tested" className="text-xl font-semibold tracking-tight">
            Not yet tested
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Added to the list, waiting for their first completed run.
          </p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {home.notTested.map((t) => (
              <li
                key={t.slug}
                className="rounded-full border border-border bg-surface px-3 py-1 text-sm"
              >
                <Link href={`/tools/${t.slug}`} className="hover:underline">
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-10 text-xs text-muted">
        Data refreshes about every five minutes.
        {home.asOf ? <> Latest run: {formatDateTime(home.asOf)}.</> : null}
      </p>
    </>
  );
}
