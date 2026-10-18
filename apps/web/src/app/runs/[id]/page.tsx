import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LevelBadge } from '@/components/level-badge';
import { StepTimeline } from '@/components/step-timeline';
import { getRunPage } from '@/lib/cached';
import { formatDateTime, formatDuration, shortId } from '@/lib/format';
import { splitRunnerEnv } from '@/lib/run-env';
import { levelLabel } from '@/lib/status-style';

export const revalidate = 300;

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const page = await getRunPage(id);
  if (!page) return { title: 'Run not found', robots: { index: false } };
  return {
    title: `${page.toolName} run ${shortId(id)}`,
    description: `One test run of the ${page.toolName} quickstart: plan, steps and environment.`,
    alternates: { canonical: `/runs/${id}` },
    robots: { index: false, follow: true },
  };
}

const OUTCOME_WORD: Record<string, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  HARNESS_ERROR: 'Did not run (a problem on our side)',
  SKIPPED: 'Needs a person',
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function RunPage({ params }: { params: Params }) {
  const { id } = await params;
  const page = await getRunPage(id);
  if (!page) notFound();
  const { run } = page;
  const plan = run.plan_ir;
  const truncation = run.plan_truncation;
  const env = splitRunnerEnv(run.runner_env);
  // An unreviewed failure is shown as "being verified": the outcome word must not say more than that.
  const outcomeWord = run.causeVisible
    ? (OUTCOME_WORD[run.outcome] ?? run.outcome)
    : 'A failure was seen and is being verified';

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link href="/" className="underline underline-offset-2 hover:text-foreground">
          All quickstarts
        </Link>
        {' / '}
        <Link
          href={`/tools/${page.toolSlug}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {page.toolName}
        </Link>
      </nav>

      <header>
        <h1 className="break-words text-3xl font-semibold tracking-tight">
          {page.toolName} <span className="font-mono text-xl text-muted">run {shortId(id)}</span>
        </h1>
        <p className="mt-2 text-sm">{outcomeWord}.</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Started</dt>
            <dd className="mt-0.5">
              <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Duration</dt>
            <dd className="tabular mt-0.5">{formatDuration(run.duration_ms)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Level reached</dt>
            <dd className="mt-0.5 flex items-center gap-2">
              {run.reached_level > 0 ? <LevelBadge level={run.reached_level} /> : 'None'}
              <span className="text-muted">of {levelLabel(page.targetLevel)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Attempt</dt>
            <dd className="tabular mt-0.5">{run.attempt}</dd>
          </div>
        </dl>
        <p data-testid="harness-version" className="mt-3 text-xs text-muted">
          Harness v{run.harness_version}. The version of the checks that ran this plan; a change of
          version never counts as a failure by itself.
        </p>
        {run.plan_stale ? (
          <p
            role="note"
            className="mt-4 rounded-lg border border-verify/40 bg-verify-bg px-4 py-3 text-sm text-verify"
          >
            Stale plan: the quickstart text changed after this plan was compiled, and a new plan
            could not be compiled in time. This run used the older plan.
          </p>
        ) : null}
      </header>

      <Section id="plan" title="Plan">
        {plan ? (
          <>
            <p className="text-sm text-muted">
              Compiled from the docs by{' '}
              <span className="font-mono text-xs">
                {run.plan_compiler_version ?? 'an earlier compiler'}
              </span>
              . Only code that appears verbatim in the docs is run; the model never writes code.{' '}
              <span className="tabular">{plan.steps.length}</span> step
              {plan.steps.length === 1 ? '' : 's'}, highest reachable level{' '}
              {levelLabel(plan.maxLevelReachable)}.
            </p>
            {plan.notes ? <p className="mt-2 text-sm">{plan.notes}</p> : null}
            {run.snapshot_title ? (
              <p className="mt-2 text-sm text-muted">
                Docs page: {run.snapshot_title}
                {run.snapshot_url ? <span className="break-all"> ({run.snapshot_url})</span> : null}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">No plan was recorded for this run.</p>
        )}

        <h3 className="mt-5 text-sm font-semibold">Grounding report</h3>
        {run.grounding_report ? (
          run.grounding_report.ok ? (
            <p className="mt-1 text-sm">
              Every command and file in the plan was found verbatim in the docs. No violations.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm">
                The plan broke the grounding rules, so it was not run as compiled:
              </p>
              <ul className="mt-2 grid gap-1 text-sm">
                {run.grounding_report.violations.map((v, i) => (
                  <li key={i} className="rounded border border-border bg-surface px-3 py-2">
                    <span className="font-mono text-xs">{v.stepId}</span>
                    {' · '}
                    <span className="font-medium">{v.rule}</span>
                    <span className="text-muted">: {v.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <p className="mt-1 text-sm text-muted">No grounding report was recorded.</p>
        )}

        <h3 className="mt-5 text-sm font-semibold">Truncation</h3>
        {truncation ? (
          truncation.truncated ? (
            <p className="mt-1 text-sm">
              The docs page was too long for the compiler to read in full:{' '}
              <span className="tabular">{truncation.includedBlocks}</span> of{' '}
              <span className="tabular">{truncation.totalBlocks}</span> blocks were included,{' '}
              <span className="tabular">{truncation.omittedBlocks}</span> omitted
              {truncation.clippedBlockIndexes.length > 0
                ? `, ${truncation.clippedBlockIndexes.length} cut short`
                : ''}
              . Omitted blocks:{' '}
              {truncation.omittedBlockIndexes.map((n) => n + 1).join(', ') || 'none'}.
            </p>
          ) : (
            <p className="mt-1 text-sm">
              Nothing was truncated: all <span className="tabular">{truncation.totalBlocks}</span>{' '}
              blocks of the docs page were read.
            </p>
          )
        ) : (
          <p className="mt-1 text-sm text-muted">No truncation record for this run.</p>
        )}
      </Section>

      <Section id="steps" title="Steps">
        <StepTimeline run={run} />
      </Section>

      <Section id="environment" title="Environment">
        <dl className="grid gap-x-8 gap-y-2 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">Image digest</dt>
          <dd className="break-all font-mono text-xs">{run.image_digest}</dd>
          {env.other.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted">{key}</dt>
              <dd className="break-all font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-5 text-sm font-semibold">Resolved packages</h3>
        {env.packages.length > 0 ? (
          <dl className="mt-2 grid gap-x-8 gap-y-1 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-[max-content_1fr]">
            {env.packages.map(([name, version]) => (
              <div key={name} className="contents">
                <dt className="font-mono text-xs">{name}</dt>
                <dd className="tabular font-mono text-xs">{version}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-sm text-muted">
            No resolved packages were recorded for this run.
          </p>
        )}
      </Section>
    </>
  );
}
