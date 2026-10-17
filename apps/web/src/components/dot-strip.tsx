import Link from 'next/link';
import type { Dot } from '@/lib/model';
import { describeDot, summarizeStrip } from '@/lib/strip';
import { cn } from '@/lib/utils';

// The run history as a strip of dots, oldest to newest. Each outcome is a different SHAPE as well as a colour:
// passed = filled circle, failed = filled square, did not run = dashed circle, harness error = outlined square,
// skipped = diamond. A stale-plan run has a dashed ring around it.

function Shape({ dot }: { dot: Dot }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {dot.kind === 'pass' && <circle cx="5" cy="5" r="4" fill="var(--pass)" />}
      {dot.kind === 'fail' && <rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--fail)" />}
      {dot.kind === 'not_run' && (
        <circle
          cx="5"
          cy="5"
          r="3.6"
          fill="none"
          stroke="var(--unknown)"
          strokeWidth="1.4"
          strokeDasharray="2 1.5"
        />
      )}
      {dot.kind === 'harness' && (
        <rect
          x="1.7"
          y="1.7"
          width="6.6"
          height="6.6"
          rx="1"
          fill="none"
          stroke="var(--unknown)"
          strokeWidth="1.4"
        />
      )}
      {dot.kind === 'skipped' && <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="var(--person)" />}
      {dot.stale && (
        <circle
          cx="5"
          cy="5"
          r="4.7"
          fill="none"
          stroke="var(--foreground)"
          strokeWidth="0.8"
          strokeDasharray="1.6 1.2"
          opacity="0.7"
        />
      )}
    </svg>
  );
}

interface Props {
  dots: readonly Dot[];
  /** Each dot links to its run. The tool page uses this; the leaderboard strip is a picture. */
  interactive?: boolean;
  className?: string;
}

export function DotStrip({ dots, interactive = false, className }: Props) {
  if (dots.length === 0) return <span className="text-sm text-muted">No runs yet</span>;
  const label = summarizeStrip(dots);
  if (!interactive)
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-flex items-center gap-[3px]', className)}
      >
        {dots.map((d) => (
          <Shape key={d.runId} dot={d} />
        ))}
      </span>
    );
  return (
    <ol aria-label={label} className={cn('flex flex-wrap', className)}>
      {dots.map((d) => (
        <li key={d.runId}>
          <Link
            href={`/runs/${d.runId}`}
            aria-label={describeDot(d)}
            title={describeDot(d)}
            className="flex size-6 items-center justify-center rounded hover:bg-surface-2"
          >
            <Shape dot={d} />
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** The legend under a strip: shape, colour and meaning. */
export function DotLegend({ className }: { className?: string }) {
  const items: { kind: Dot['kind']; text: string }[] = [
    { kind: 'pass', text: 'Passed' },
    { kind: 'fail', text: 'Failed' },
    { kind: 'not_run', text: 'Did not run' },
    { kind: 'harness', text: 'Harness error' },
    { kind: 'skipped', text: 'Needs a person' },
  ];
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted', className)}>
      {items.map((i) => (
        <li key={i.kind} className="inline-flex items-center gap-1.5">
          <Shape dot={{ runId: i.kind, kind: i.kind, stale: false, at: '' }} />
          {i.text}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <Shape dot={{ runId: 'stale', kind: 'pass', stale: true, at: '' }} />
        Stale plan
      </li>
    </ul>
  );
}
