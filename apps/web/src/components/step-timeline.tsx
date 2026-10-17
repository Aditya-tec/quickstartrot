import { CircleCheck, CircleMinus, CircleX, Hourglass } from 'lucide-react';
import type { SafeRun } from '@qsr/core/public';
import { LogViewer } from '@/components/log-viewer';
import { logHref } from '@/lib/artifacts-server';
import { formatDuration } from '@/lib/format';
import { describeStep, type PlanStep } from '@/lib/step-label';
import { cn } from '@/lib/utils';

// The steps of a run, in order: what the docs said (block and lines), the command that ran, its exit code and
// duration, and the redacted log on demand. For an unreviewed failure the run arrives with every output removed
// (see sanitizeRun), so this component shows the steps and their outcomes but never a cause.

function sourceText(step: PlanStep | undefined, run: SafeRun): string | null {
  const source = step && 'source' in step ? step.source : null;
  if (!source) return null;
  const block = run.snapshot_blocks?.find((b) => b.index === source.blockIndex);
  const heading = block?.headingPath.at(-1);
  const lines =
    source.lineStart === source.lineEnd
      ? `line ${source.lineStart}`
      : `lines ${source.lineStart}-${source.lineEnd}`;
  return `Docs block ${source.blockIndex + 1}, ${lines}${heading ? ` under "${heading}"` : ''}`;
}

/**
 * A failed step of an unreviewed failure is shown as "Being verified": which step failed is part of the cause, and
 * nothing about the cause is public until a person has reviewed it.
 */
function Outcome({ outcome, withheld }: { outcome: string; withheld: boolean }) {
  const pass = outcome === 'PASS';
  const fail = outcome === 'FAIL' && !withheld;
  const Icon = pass ? CircleCheck : fail ? CircleX : withheld ? Hourglass : CircleMinus;
  const word = pass ? 'Passed' : fail ? 'Failed' : withheld ? 'Being verified' : 'Skipped';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        pass ? 'text-pass' : fail ? 'text-fail' : withheld ? 'text-verify' : 'text-unknown',
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {word}
    </span>
  );
}

export function StepTimeline({ run }: { run: SafeRun }) {
  if (run.steps.length === 0) {
    return (
      <p className="text-sm text-muted">
        {run.outcome === 'SKIPPED'
          ? (run.skip_reason ?? 'This run stopped before any step.')
          : 'This run did not execute any step.'}
      </p>
    );
  }
  const plan = new Map((run.plan_ir?.steps ?? []).map((s) => [s.id, s]));
  return (
    <ol className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-label="Steps of this run">
      {run.steps
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((s) => {
          const step = plan.get(s.step_id);
          const { what, code } = describeStep(s, step);
          const src = sourceText(step, run);
          const href = logHref(s.log_path);
          const label = `step ${s.ordinal + 1} (${what.toLowerCase()})`;
          return (
            <li key={s.step_id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  <span className="tabular mr-2 text-muted">{s.ordinal + 1}.</span>
                  {what}
                </p>
                <Outcome outcome={s.outcome} withheld={!run.causeVisible && s.outcome === 'FAIL'} />
              </div>
              {code ? (
                <pre className="mt-2 overflow-x-auto rounded bg-surface-2 px-3 py-2 font-mono text-xs">
                  {code}
                </pre>
              ) : null}
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                {src ? (
                  <div>
                    <dt className="sr-only">Docs source</dt>
                    <dd>{src}</dd>
                  </div>
                ) : null}
                <div className="flex gap-1">
                  <dt>Exit code</dt>
                  <dd className="tabular text-foreground">{s.exit_code ?? ''}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>Duration</dt>
                  <dd className="tabular text-foreground">{formatDuration(s.duration_ms)}</dd>
                </div>
              </dl>
              {href ? <LogViewer href={href} label={label} /> : null}
            </li>
          );
        })}
    </ol>
  );
}
