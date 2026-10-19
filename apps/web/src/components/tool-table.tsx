import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { DotStrip } from '@/components/dot-strip';
import { LevelBadge } from '@/components/level-badge';
import { StatusPill } from '@/components/status-pill';
import { EM_DASH, formatDateTime, formatDay, formatPercent, relativeTime } from '@/lib/format';
import type { ToolSummary } from '@/lib/model';

const LANGUAGE: Record<string, string> = { node: 'Node.js', python: 'Python' };

/** "Failing since Oct 12", "Verifying since Oct 16", or a dash. Neutral wording. */
function sinceText(tool: ToolSummary): string {
  if (tool.status === 'failing') return `Failing since ${formatDay(tool.failingSince)}`;
  if (tool.status === 'verifying' && tool.statusSince)
    return `Verifying since ${formatDay(tool.statusSince)}`;
  return EM_DASH;
}

function PassRate({ tool }: { tool: ToolSummary }) {
  return (
    <span
      className="tabular"
      title={
        tool.decided30d > 0
          ? `${tool.decided30d} runs counted in the last 30 days`
          : 'No runs counted yet'
      }
    >
      {formatPercent(tool.passRate)}
    </span>
  );
}

function Checked({ tool, now }: { tool: ToolSummary; now: Date }) {
  return tool.lastRunAt ? (
    <time dateTime={tool.lastRunAt} title={formatDateTime(tool.lastRunAt)}>
      {relativeTime(tool.lastRunAt, now)}
    </time>
  ) : (
    <span>{EM_DASH}</span>
  );
}

/** A small decorative tile with the first letter of the name, tinted from the name so each quickstart keeps its colour. */
export const tileLetter = (name: string): string => (name.trim().charAt(0) || '?').toUpperCase();
export const tileHue = (name: string): number =>
  [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function Tile({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border font-display text-lg italic"
      style={{
        background: `hsl(${tileHue(name)} 60% 90%)`,
        color: `hsl(${tileHue(name)} 55% 25%)`,
      }}
    >
      {tileLetter(name)}
    </span>
  );
}

function ToolName({ tool }: { tool: ToolSummary }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <Tile name={tool.name} />
      <div className="flex min-w-0 flex-col">
        <Link
          href={`/tools/${tool.slug}`}
          className="inline-block break-words py-0.5 font-medium hover:underline"
        >
          {tool.name}
        </Link>
        <a
          href={tool.docsUrl}
          className="inline-flex min-h-6 items-center gap-1 text-xs text-muted hover:text-foreground"
          rel="noopener noreferrer"
        >
          <span className="sr-only">Quickstart docs for {tool.name}</span>
          <span aria-hidden="true" className="break-all">
            {new URL(tool.docsUrl).host}
          </span>
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

/** The leaderboard as a table, from the md breakpoint up. */
export function ToolTable({ tools, now }: { tools: readonly ToolSummary[]; now: Date }) {
  return (
    <div className="hidden overflow-hidden rounded-3xl border border-border bg-surface px-4 shadow-sm md:block">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Developer quickstarts and their current status</caption>
        <thead>
          <tr className="border-b border-border-strong text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Quickstart
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Language
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Level
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Last 28 runs
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              30-day pass rate
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Last checked
            </th>
            <th scope="col" className="py-2 font-medium">
              Since
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.slug} className="border-b border-border align-top">
              <th scope="row" className="max-w-64 py-3 pr-3 text-left font-normal">
                <ToolName tool={t} />
              </th>
              <td className="py-3 pr-3 text-muted">{LANGUAGE[t.language] ?? t.language}</td>
              <td className="py-3 pr-3">
                <LevelBadge level={t.level} />
              </td>
              <td className="py-3 pr-3">
                <StatusPill status={t.status} />
              </td>
              <td className="py-3 pr-3">
                <DotStrip dots={t.strip} />
              </td>
              <td className="py-3 pr-3 text-right">
                <PassRate tool={t} />
              </td>
              <td className="py-3 pr-3 whitespace-nowrap text-muted">
                <Checked tool={t} now={now} />
              </td>
              <td className="py-3 whitespace-nowrap text-muted">{sinceText(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The same rows as cards, below the md breakpoint (a 375 px phone). */
export function ToolCards({ tools, now }: { tools: readonly ToolSummary[]; now: Date }) {
  return (
    <ul className="grid gap-3 md:hidden">
      {tools.map((t) => (
        <li key={t.slug} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <ToolName tool={t} />
            <StatusPill status={t.status} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <LevelBadge level={t.level} />
            <span>{LANGUAGE[t.language] ?? t.language}</span>
            <span>
              30-day pass rate <PassRate tool={t} />
            </span>
          </div>
          <div className="mt-3 overflow-x-auto pb-1">
            <DotStrip dots={t.strip} />
          </div>
          <p className="mt-2 text-xs text-muted">
            Last checked <Checked tool={t} now={now} />
            {t.status === 'failing' || t.status === 'verifying' ? (
              <>
                {' '}
                {'·'} {sinceText(t)}
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  );
}
