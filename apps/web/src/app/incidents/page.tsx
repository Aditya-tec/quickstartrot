import type { Metadata } from 'next';
import Link from 'next/link';
import { IncidentCard } from '@/components/incident-card';
import { getIncidents } from '@/lib/cached';
import { formatDay } from '@/lib/format';

export const dynamic = 'force-dynamic'; // never read the database at build time; getIncidents() caches it for 5 minutes
export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Incidents',
  description:
    'Quickstarts that failed on a fresh machine and were confirmed by a person, with the cause, a suggested fix and what changed.',
  alternates: { canonical: '/incidents' },
};

export default async function IncidentsPage() {
  const incidents = await getIncidents();
  const open = incidents.filter((i) => i.state === 'OPEN');
  const resolved = incidents.filter((i) => i.state === 'RESOLVED');
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Incidents</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        An incident is published only after a quickstart failed twice in a row in valid test cycles
        and a person reviewed it. Failures still being checked are not listed here; those
        quickstarts show as &ldquo;verifying&rdquo;. See{' '}
        <Link
          href="/methodology#before-failing"
          className="underline underline-offset-2 hover:text-foreground"
        >
          what has to happen before a quickstart is called failing
        </Link>
        .
      </p>

      <section aria-labelledby="open" className="mt-8">
        <h2 id="open" className="text-xl font-semibold tracking-tight">
          Open <span className="tabular text-muted">({open.length})</span>
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 rounded-lg border border-border bg-surface p-4 text-sm text-muted">
            No confirmed incidents are open right now.
          </p>
        ) : (
          <div className="mt-3 grid gap-4">
            {open.map((i) => (
              <IncidentCard key={i.id} incident={i} showTool />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="resolved" className="mt-10">
        <h2 id="resolved" className="text-xl font-semibold tracking-tight">
          Resolved <span className="tabular text-muted">({resolved.length})</span>
        </h2>
        {resolved.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing has been resolved yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {resolved.map((i) => (
              <li key={i.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
                <Link href={`/tools/${i.toolSlug}`} className="font-medium hover:underline">
                  {i.toolName}
                </Link>
                <span className="tabular text-muted">
                  {' '}
                  {formatDay(i.openedAt)} to {formatDay(i.resolvedAt)}
                </span>
                <span className="block text-muted">{i.oneLine}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
