import type { StatsResponse } from '@qsr/core/public';
import { formatBytes, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

// The pipeline's own health, for the person reviewing the queue (spec section 14, "Observability"): the last cycles,
// the harness error rate, model tokens, and storage used against the free tier. Numbers come from GET /admin/stats.

/** The share of a limit above which the page says so in words (the same 70% the growth estimate uses). */
const WARN_PERCENT = 70;

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const warn = percent >= WARN_PERCENT;
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-valuetext={`${percent.toFixed(1)} percent used`}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cn('h-full', warn ? 'bg-verify' : 'bg-pass')}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted">
        {detail} ({percent.toFixed(1)}%)
        {warn ? (
          <span className="font-medium text-verify"> Above {WARN_PERCENT}% of the limit.</span>
        ) : null}
      </p>
    </div>
  );
}

export function StatusSection({ stats }: { stats: StatsResponse }) {
  const day = stats.groq.at(-1);
  const objects = stats.storage.objects;
  return (
    <section aria-labelledby="status" className="mt-10" data-testid="status-section">
      <h2 id="status" className="text-xl font-semibold tracking-tight">
        Pipeline status
      </h2>
      <p className="mt-1 text-sm text-muted">
        The last {stats.days} days, from {formatDateTime(stats.generatedAt)}.
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Cycles</dt>
          <dd className="tabular mt-0.5">
            {stats.cycles.valid} valid, {stats.cycles.invalid} invalid
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Harness error rate</dt>
          <dd className="tabular mt-0.5">
            {(stats.harness.overall.rate * 100).toFixed(1)}% ({stats.harness.overall.errors} of{' '}
            {stats.harness.overall.runs})
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Model tokens, latest day</dt>
          <dd className="tabular mt-0.5">{day ? `${day.tokens} on ${day.day}` : 'none yet'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Incidents</dt>
          <dd className="tabular mt-0.5">
            {stats.incidents.pendingReview} to review, {stats.incidents.confirmed} confirmed
          </dd>
        </div>
      </dl>

      <h3 className="mt-6 text-base font-semibold">Storage used</h3>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Meter
          label="Database"
          percent={stats.storage.database.percent}
          detail={`${formatBytes(stats.storage.database.bytes)} of ${formatBytes(stats.storage.database.limitBytes)}`}
        />
        {objects ? (
          <Meter
            label="Storage (logs, diffs, traces)"
            percent={objects.percent}
            detail={`${formatBytes(objects.totalBytes)} of ${formatBytes(objects.limitBytes)}; cleanup aims under ${formatBytes(objects.targetBytes)}`}
          />
        ) : (
          <p className="text-sm text-muted">
            Storage objects are not visible from the database; see the Supabase dashboard.
          </p>
        )}
      </div>

      <h3 className="mt-6 text-base font-semibold">Last cycles</h3>
      {stats.cycles.recent.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No cycles in this window.</p>
      ) : (
        <div
          className="mt-2 overflow-x-auto"
          role="region"
          aria-label="The most recent probe cycles"
          tabIndex={0}
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">The most recent probe cycles</caption>
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Started
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Valid
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Minutes
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Tools
                </th>
                <th scope="col" className="py-1 font-medium">
                  Harness errors
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.cycles.recent.slice(0, 20).map((c) => (
                <tr key={c.id} className="border-t border-border align-top">
                  <td className="tabular py-1.5 pr-4 whitespace-nowrap">
                    {formatDateTime(c.startedAt)}
                  </td>
                  <td className="py-1.5 pr-4">
                    {c.valid === null ? 'running' : c.valid ? 'yes' : 'no'}
                    {c.valid === false && c.problems.length > 0 ? (
                      <span className="block text-xs text-muted">{c.problems.join('; ')}</span>
                    ) : null}
                  </td>
                  <td className="tabular py-1.5 pr-4">
                    {c.durationSeconds === null ? '-' : (c.durationSeconds / 60).toFixed(1)}
                  </td>
                  <td className="tabular py-1.5 pr-4">{c.tools}</td>
                  <td className="tabular py-1.5">{c.harnessErrors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
