import { loadDiff } from '@/lib/artifacts-server';
import { cn } from '@/lib/utils';

// The docs diff of an incident: what changed in the quickstart between the last passing run and the first
// failing one. Text only. Each line is a React text node (escaped), and the +/- sign stays visible so the
// meaning never depends on colour.

const KIND_CLASS = {
  add: 'bg-pass-bg text-pass',
  remove: 'bg-fail-bg text-fail',
  hunk: 'text-muted',
  header: 'font-medium text-muted',
  context: '',
} as const;

export async function DiffViewer({ path }: { path: string | null }) {
  const diff = await loadDiff(path);
  if (!diff.ok) return <p className="text-sm text-muted">The docs diff is not available.</p>;
  return (
    <figure className="m-0">
      <div
        role="region"
        aria-label="Docs diff"
        tabIndex={0}
        className="max-h-96 overflow-auto rounded border border-border bg-surface-2 font-mono text-xs"
        data-testid="docs-diff"
      >
        <div className="min-w-max">
          {diff.lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre px-3 leading-5', KIND_CLASS[l.kind])}>
              {l.text === '' ? ' ' : l.text}
            </div>
          ))}
        </div>
      </div>
      {diff.truncated ? (
        <figcaption className="mt-1 text-xs text-muted">
          Showing the first {diff.lines.length} lines.
        </figcaption>
      ) : null}
    </figure>
  );
}
