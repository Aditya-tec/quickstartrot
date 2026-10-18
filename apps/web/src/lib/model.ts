import {
  computeHeadline,
  confirmedOnly,
  isTested,
  publicStatus,
  type Headline,
  type Language,
  type PublicIncidentRow,
  type PublicRunHistoryRow,
  type PublicStatus,
  type PublicToolRow,
  type RunKind,
} from '@qsr/core/public';

// The view models the pages render. They are built from public view rows and are the only thing the UI sees:
// there is no field here that could carry a cause, and an incident is only ever used if a person confirmed it.

export const STRIP_LENGTH = 28;

export interface Dot {
  runId: string;
  kind: RunKind;
  stale: boolean;
  at: string;
}

export interface ToolSummary {
  slug: string;
  name: string;
  language: Language;
  level: number;
  docsUrl: string;
  status: PublicStatus;
  statusSince: string | null;
  /** Set only for a confirmed failing tool. */
  failingSince: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastReachedLevel: number | null;
  passRate: number | null;
  decided30d: number;
  streak: { kind: 'pass' | 'fail'; count: number };
  /** A vendor opted out: when probing stopped. The page says so and the tool is not in the headline or the tables. */
  optedOutAt: string | null;
  /** The vendor asked for the past results to be hidden: the page shows none. */
  historyHidden: boolean;
  /** The last runs, oldest first. */
  strip: Dot[];
  openIncidentId: string | null;
}

export function buildToolSummaries(
  tools: readonly PublicToolRow[],
  history: readonly PublicRunHistoryRow[],
  incidents: readonly PublicIncidentRow[],
): ToolSummary[] {
  // Only confirmed incidents exist for the app, whatever the database sent.
  const confirmed = confirmedOnly(incidents);
  const byTool = new Map<string, PublicRunHistoryRow[]>();
  for (const h of history) {
    const list = byTool.get(h.tool_slug) ?? [];
    list.push(h);
    byTool.set(h.tool_slug, list);
  }

  return tools.map((t) => {
    const open = confirmed.find((i) => i.tool_slug === t.slug && i.state === 'OPEN') ?? null;
    const status = publicStatus({
      status: t.status,
      lastOutcome: t.last_outcome,
      hasConfirmedOpenIncident: open !== null,
    });
    const strip: Dot[] = (byTool.get(t.slug) ?? [])
      .sort((a, b) => a.rn - b.rn) // newest first
      .slice(0, STRIP_LENGTH)
      .reverse() // oldest first, left to right
      .map((h) => ({ runId: h.run_id, kind: h.kind, stale: h.stale, at: h.started_at }));
    return {
      slug: t.slug,
      name: t.name,
      language: t.language,
      level: t.level,
      docsUrl: t.docs_url,
      status,
      statusSince: t.status_since,
      failingSince: status === 'failing' ? (t.status_since ?? open?.opened_at ?? null) : null,
      lastRunAt: t.last_run_at,
      lastRunId: t.last_run_id,
      lastReachedLevel: t.last_reached_level,
      passRate: t.pass_rate_30d,
      decided30d: t.decided_30d,
      streak: { kind: t.streak_kind ?? 'pass', count: t.current_streak ?? 0 },
      optedOutAt: t.opted_out_at,
      historyHidden: t.history_hidden,
      // a history the vendor asked to hide has no dots, whatever the data layer below still holds
      strip: t.history_hidden ? [] : strip,
      openIncidentId: open?.id ?? null,
    };
  });
}

export interface HomeModel {
  /** Tools that were tested: passing, failing or being verified. This is "Y". */
  tested: ToolSummary[];
  needsPerson: ToolSummary[];
  notTested: ToolSummary[];
  /** Vendors that opted out: no longer probed, so in none of the lists above and not in the headline. */
  optedOut: ToolSummary[];
  headline: Headline;
  /** The newest last_run_at: when the data is from. */
  asOf: string | null;
}

export function buildHomeModel(all: readonly ToolSummary[]): HomeModel {
  // a tool nobody monitors any more says nothing about whether quickstarts work today
  const tools = all.filter((t) => t.optedOutAt === null);
  const asOf = tools.reduce<string | null>(
    (latest, t) =>
      t.lastRunAt !== null && (latest === null || t.lastRunAt > latest) ? t.lastRunAt : latest,
    null,
  );
  return {
    tested: tools.filter((t) => isTested(t.status)),
    needsPerson: tools.filter((t) => t.status === 'needs_person'),
    notTested: tools.filter((t) => t.status === 'unknown'),
    optedOut: all.filter((t) => t.optedOutAt !== null),
    headline: computeHeadline(tools),
    asOf,
  };
}

export interface IncidentView {
  id: string;
  toolSlug: string;
  toolName: string;
  failureClass: PublicIncidentRow['failure_class'];
  state: PublicIncidentRow['state'];
  openedAt: string;
  confirmedAt: string | null;
  resolvedAt: string | null;
  oneLine: string;
  summary: string | null;
  suggestedFix: string | null;
  docsChanged: boolean | null;
  docsDiffPath: string | null;
  versionDiff: PublicIncidentRow['version_diff'];
  firstFailingRunId: string | null;
  /** Time from opening to resolution; null while open. */
  resolvedAfterMs: number | null;
}

const MAX_ONE_LINE = 160;

export function oneLine(summary: string | null): string {
  const text = (summary ?? '').trim();
  if (text === '') return 'Cause being documented.';
  const firstSentence = /^.+?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
  const line = firstSentence.replace(/\s+/g, ' ');
  return line.length > MAX_ONE_LINE
    ? `${line.slice(0, MAX_ONE_LINE - 1)}${String.fromCodePoint(0x2026)}`
    : line;
}

/** Confirmed incidents, newest first. */
export function buildIncidentViews(rows: readonly PublicIncidentRow[]): IncidentView[] {
  return confirmedOnly(rows)
    .map((i): IncidentView => ({
      id: i.id,
      toolSlug: i.tool_slug,
      toolName: i.tool_name,
      failureClass: i.failure_class,
      state: i.state,
      openedAt: i.opened_at,
      confirmedAt: i.confirmed_at,
      resolvedAt: i.resolved_at,
      oneLine: oneLine(i.summary),
      summary: i.summary,
      suggestedFix: i.suggested_fix,
      docsChanged: i.docs_changed,
      docsDiffPath: i.docs_diff_path,
      versionDiff: i.version_diff,
      firstFailingRunId: i.first_failing_run_id,
      resolvedAfterMs: i.resolved_at ? Date.parse(i.resolved_at) - Date.parse(i.opened_at) : null,
    }))
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
}
