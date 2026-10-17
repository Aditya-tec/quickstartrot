import Link from 'next/link';
import { DiffViewer } from '@/components/diff-viewer';
import { formatDay, formatDuration } from '@/lib/format';
import type { IncidentView } from '@/lib/model';

// A confirmed incident, as a person reviewed it. Only confirmed incidents reach this component (the loaders drop
// everything else), so the summary and fix here are reviewed text.

const CLASS_LABEL: Record<string, string> = {
  DOCS_SNIPPET_ERROR: 'The docs snippet does not work as written',
  API_DRIFT: 'The vendor API changed',
  DEPENDENCY_RESOLUTION: 'A dependency could not be resolved',
  RUNTIME_VERSION: 'A runtime version mismatch',
  NEEDS_CREDENTIALS: 'The quickstart needs credentials',
  NETWORK_TRANSIENT: 'A network problem',
  TIMEOUT: 'A step timed out',
};

function VersionDiff({ diff }: { diff: NonNullable<IncidentView['versionDiff']> }) {
  const rows = [
    ...diff.changed.map((c) => ({
      key: `c-${c.name}`,
      name: c.name,
      change: `${c.from} to ${c.to}`,
      kind: 'Changed',
    })),
    ...diff.added.map((a) => ({
      key: `a-${a.name}`,
      name: a.name,
      change: a.version,
      kind: 'Added',
    })),
    ...diff.removed.map((r) => ({
      key: `r-${r.name}`,
      name: r.name,
      change: r.version,
      kind: 'Removed',
    })),
  ];
  if (rows.length === 0) return <p className="text-sm text-muted">No package versions changed.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Package versions between the last passing run and the first failing run
        </caption>
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="py-1 pr-4 font-medium">
              Package
            </th>
            <th scope="col" className="py-1 pr-4 font-medium">
              Change
            </th>
            <th scope="col" className="py-1 font-medium">
              Version
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="py-1.5 pr-4">{r.name}</td>
              <td className="py-1.5 pr-4 font-sans text-muted">{r.kind}</td>
              <td className="tabular py-1.5">{r.change}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IncidentCard({
  incident,
  showTool = false,
}: {
  incident: IncidentView;
  showTool?: boolean;
}) {
  const open = incident.state === 'OPEN';
  return (
    <article
      aria-labelledby={`incident-${incident.id}`}
      className="rounded-lg border border-border-strong bg-surface p-5"
      data-testid="incident-card"
    >
      <header>
        <h2 id={`incident-${incident.id}`} className="text-lg font-semibold tracking-tight">
          {showTool ? (
            <>
              <Link href={`/tools/${incident.toolSlug}`} className="hover:underline">
                {incident.toolName}
              </Link>
              {': '}
            </>
          ) : null}
          {open
            ? `Quickstart failing since ${formatDay(incident.openedAt)}`
            : `Failed ${formatDay(incident.openedAt)}, resolved ${formatDay(incident.resolvedAt)}`}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {CLASS_LABEL[incident.failureClass] ?? 'Cause reviewed by a person'}
          {incident.resolvedAfterMs !== null ? (
            <>
              {' '}
              {'·'} open for {formatDuration(incident.resolvedAfterMs)}
            </>
          ) : null}
          {incident.firstFailingRunId ? (
            <>
              {' '}
              {'·'}{' '}
              <Link
                href={`/runs/${incident.firstFailingRunId}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                first failing run
              </Link>
            </>
          ) : null}
        </p>
      </header>

      <section className="mt-4" aria-label="Summary">
        <h3 className="text-sm font-semibold">What happened</h3>
        <p className="mt-1 whitespace-pre-line text-sm">
          {incident.summary ?? 'A summary is being written.'}
        </p>
      </section>

      {incident.suggestedFix ? (
        <section className="mt-4" aria-label="Suggested fix">
          <h3 className="text-sm font-semibold">Suggested fix</h3>
          <p className="mt-1 whitespace-pre-line text-sm">{incident.suggestedFix}</p>
        </section>
      ) : null}

      <section className="mt-4" aria-label="Docs change">
        <h3 className="text-sm font-semibold">Did the docs change?</h3>
        {incident.docsChanged === false ? (
          <p className="mt-1 text-sm text-muted">
            No. The quickstart text is the same as in the last passing run.
          </p>
        ) : incident.docsDiffPath ? (
          <div className="mt-2">
            <DiffViewer path={incident.docsDiffPath} />
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">
            {incident.docsChanged ? 'Yes, but the diff is not available.' : 'Not determined.'}
          </p>
        )}
      </section>

      <section className="mt-4" aria-label="Version changes">
        <h3 className="text-sm font-semibold">Package versions</h3>
        <div className="mt-2">
          {incident.versionDiff ? (
            <VersionDiff diff={incident.versionDiff} />
          ) : (
            <p className="text-sm text-muted">No version comparison is available.</p>
          )}
        </div>
      </section>
    </article>
  );
}
