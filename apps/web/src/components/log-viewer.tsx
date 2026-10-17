'use client';

import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeLog, splitLines, windowRange } from '@/lib/log-decode';

// A step log, redacted before upload. Fetched from the public bucket only when the reader expands it, inflated
// in the browser, and drawn as TEXT in a virtualized monospace list: only the lines in view are in the DOM.
// Nothing here ever parses the log as markup.

const LINE_HEIGHT = 20;
const VIEWPORT = 320;
const OVERSCAN = 12;

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; lines: string[] };

export function LogViewer({ href, label }: { href: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [scrollTop, setScrollTop] = useState(0);
  const started = useRef(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(href, { credentials: 'omit' });
      if (!res.ok)
        throw new Error(
          res.status === 404
            ? 'This log is no longer available.'
            : `The log could not be loaded (${res.status}).`,
        );
      const text = await decodeLog(await res.arrayBuffer());
      setState({ kind: 'ready', lines: splitLines(text) });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'The log could not be loaded.',
      });
    }
  }, [href]);

  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      void load();
    }
  }, [open, load]);

  const panelId = `log-${label.replace(/[^A-Za-z0-9]+/g, '-')}`;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
      >
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        {open ? 'Hide log' : 'Show log'}
        <span className="sr-only"> for {label}</span>
      </button>
      {open ? (
        <div id={panelId} className="mt-2">
          {state.kind === 'loading' || state.kind === 'idle' ? (
            <p role="status" className="text-xs text-muted">
              Loading log
            </p>
          ) : state.kind === 'error' ? (
            <p role="alert" className="text-xs text-fail">
              {state.message}{' '}
              <button type="button" className="underline" onClick={() => void load()}>
                Try again
              </button>
            </p>
          ) : state.lines.length === 0 ? (
            <p className="text-xs text-muted">The log is empty.</p>
          ) : (
            <Lines
              lines={state.lines}
              scrollTop={scrollTop}
              onScroll={setScrollTop}
              label={label}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function Lines({
  lines,
  scrollTop,
  onScroll,
  label,
}: {
  lines: string[];
  scrollTop: number;
  onScroll: (top: number) => void;
  label: string;
}) {
  const height = Math.min(VIEWPORT, lines.length * LINE_HEIGHT + 16);
  const { start, end } = windowRange({
    scrollTop,
    viewport: height,
    lineHeight: LINE_HEIGHT,
    total: lines.length,
    overscan: OVERSCAN,
  });
  return (
    <div
      role="region"
      aria-label={`Log output of ${label}, ${lines.length} lines`}
      tabIndex={0}
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      className="overflow-auto rounded border border-border bg-surface-2 font-mono text-xs"
      style={{ height }}
      data-testid="log-lines"
    >
      <div
        style={{
          height: lines.length * LINE_HEIGHT + 16,
          position: 'relative',
          minWidth: 'max-content',
        }}
      >
        {lines.slice(start, end).map((line, i) => (
          <div
            key={start + i}
            className="absolute left-0 right-0 flex whitespace-pre px-2"
            style={{
              top: (start + i) * LINE_HEIGHT + 8,
              height: LINE_HEIGHT,
              lineHeight: `${LINE_HEIGHT}px`,
            }}
          >
            <span
              className="tabular mr-3 w-8 shrink-0 select-none text-right text-muted"
              aria-hidden="true"
            >
              {start + i + 1}
            </span>
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
