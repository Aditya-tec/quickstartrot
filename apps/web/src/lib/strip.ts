import { formatDateTime } from './format';
import type { Dot } from './model';

// Labels for the dot strips. A strip is a picture; these words make it readable by a screen reader and by anyone
// who cannot tell the shapes apart. They say what happened and never why.

const PHRASE: Record<Dot['kind'], string> = {
  pass: 'passed',
  fail: 'failed',
  not_run: 'did not run (crawl or compile problem)',
  harness: 'harness error (ours, not the vendor)',
  skipped: 'skipped (needs a person)',
};

export function describeDot(dot: Dot): string {
  return `${formatDateTime(dot.at)}: ${PHRASE[dot.kind]}${dot.stale ? ' (stale plan)' : ''}`;
}

export function summarizeStrip(dots: readonly Dot[]): string {
  if (dots.length === 0) return 'No runs yet';
  const count = (kind: Dot['kind']): number => dots.filter((d) => d.kind === kind).length;
  const parts = [
    [count('pass'), 'passed'],
    [count('fail'), 'failed'],
    [count('not_run'), 'not run'],
    [count('harness'), 'harness error'],
    [count('skipped'), 'skipped'],
    [dots.filter((d) => d.stale).length, 'on a stale plan'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${String(n)} ${word as string}`);
  return `${dots.length} recent run${dots.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
