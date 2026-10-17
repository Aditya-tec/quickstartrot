import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { logoutAction } from '@/app/admin/actions';
import { PendingList } from '@/components/admin/pending-list';
import { Button } from '@/components/ui/button';
import { createAdminApi } from '@/lib/admin-api';
import { SESSION_COOKIE, verifySession } from '@/lib/admin-session';
import { ConfigError, adminConfig } from '@/lib/env';
import { formatDateTime } from '@/lib/format';

// The review queue. Server rendered on every request, behind the middleware and checked again here. The page
// shows unreviewed material (signatures, draft summaries) on purpose: this is where it gets reviewed.

const DETAIL_LIMIT = 1500;

function detailText(detail: unknown): string {
  let text: string;
  try {
    text = typeof detail === 'string' ? detail : (JSON.stringify(detail, null, 2) ?? '');
  } catch {
    text = '';
  }
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}\n(cut)` : text;
}

function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title} <span className="tabular text-muted">({count})</span>
      </h2>
      <div className="mt-3 grid gap-3">{children}</div>
    </section>
  );
}

export default async function AdminPage() {
  let config: ReturnType<typeof adminConfig>;
  try {
    config = adminConfig();
  } catch (err) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        <p role="alert" className="mt-3 text-fail">
          {err instanceof ConfigError ? err.message : 'The admin area is not configured.'}
        </p>
      </>
    );
  }
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value ?? '';
  if (
    cookie === '' ||
    !(await verifySession(config.sessionSecret, cookie, Math.floor(Date.now() / 1000)))
  )
    redirect('/admin/login');

  const result = await createAdminApi({
    fetch,
    apiBaseUrl: config.apiBaseUrl,
    token: config.adminToken,
  }).queue();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Admin queue</h1>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </div>

      {!result.ok ? (
        <p
          role="alert"
          data-testid="queue-error"
          className="mt-6 rounded-lg border border-fail/40 bg-fail-bg p-4 text-sm text-fail"
        >
          The queue could not be loaded: {result.message}
        </p>
      ) : (
        <>
          <Section
            id="pending"
            title="Incidents to review"
            count={result.data.pendingIncidents.length}
          >
            <PendingList
              incidents={result.data.pendingIncidents.map((i) => ({
                id: i.id,
                toolSlug: i.toolSlug,
                signature: i.signature,
                failureClass: i.failureClass,
                openedAt: i.openedAt,
                summary: i.summary,
                suggestedFix: i.suggestedFix,
                docsChanged: i.docsChanged,
              }))}
            />
          </Section>

          <Section id="items" title="Needs attention" count={result.data.items.length}>
            {result.data.items.length === 0 ? (
              <p className="text-sm text-muted">
                No unclassified failures, crawl, compile or config errors.
              </p>
            ) : (
              result.data.items.map((item) => (
                <article
                  key={item.id}
                  className="rounded-lg border border-border bg-surface p-4"
                  data-testid="queue-item"
                >
                  <h3 className="text-sm font-semibold">
                    <span className="font-mono">{item.reason}</span>
                    {item.toolSlug ? (
                      <span className="text-muted">
                        {' '}
                        {'·'} {item.toolSlug}
                      </span>
                    ) : null}
                  </h3>
                  <p className="text-xs text-muted">{formatDateTime(item.createdAt)}</p>
                  {item.detail !== null && item.detail !== undefined ? (
                    <pre
                      className="mt-2 max-h-48 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs"
                      tabIndex={0}
                    >
                      {detailText(item.detail)}
                    </pre>
                  ) : null}
                </article>
              ))
            )}
          </Section>

          <Section id="submissions" title="New submissions" count={result.data.submissions.length}>
            {result.data.submissions.length === 0 ? (
              <p className="text-sm text-muted">No new submissions.</p>
            ) : (
              result.data.submissions.map((s) => (
                <article
                  key={s.id}
                  className="rounded-lg border border-border bg-surface p-4"
                  data-testid="submission"
                >
                  <p className="break-all font-mono text-sm">{s.docsUrl}</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDateTime(s.createdAt)}
                    {s.contact ? ` · ${s.contact}` : ''}
                  </p>
                  {s.note ? <p className="mt-2 whitespace-pre-line text-sm">{s.note}</p> : null}
                </article>
              ))
            )}
          </Section>
        </>
      )}
    </>
  );
}
