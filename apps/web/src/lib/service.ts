import {
  confirmedOnly,
  sanitizeRun,
  type PublicIncidentRow,
  type PublicStatus,
  type PublicToolRow,
  type SafeRun,
} from '@qsr/core/public';
import { isValidSlug, type BadgeStatus } from './badge';
import type { DataSource } from './data/source';
import {
  STRIP_LENGTH,
  buildHomeModel,
  buildIncidentViews,
  buildToolSummaries,
  type Dot,
  type HomeModel,
  type IncidentView,
  type ToolSummary,
} from './model';

// The loaders every page, the badge and the images are built from. Each takes a DataSource and returns a view
// model: nothing here returns a raw row, an unconfirmed incident or an unsanitised run. Pure and framework-free,
// so the safety rule is tested without a server; ./cached.ts adds the Next.js caching on top.

export const TOOL_STRIP_LENGTH = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * The incidents of the tools whose past results the vendor asked us to hide are dropped here, whatever the data layer below returns:
 * the public views already leave them out, and this is the second place that does.
 */
function withoutHiddenHistory(
  tools: readonly PublicToolRow[],
  incidents: readonly PublicIncidentRow[],
): PublicIncidentRow[] {
  const hidden = new Set(tools.filter((t) => t.history_hidden).map((t) => t.slug));
  return incidents.filter((i) => !hidden.has(i.tool_slug));
}

export async function loadHome(source: DataSource): Promise<HomeModel> {
  const [tools, history, incidents] = await Promise.all([
    source.listTools(),
    source.listHistory(STRIP_LENGTH),
    source.listIncidents(),
  ]);
  return buildHomeModel(buildToolSummaries(tools, history, withoutHiddenHistory(tools, incidents)));
}

export interface ToolPage {
  tool: ToolSummary;
  /** The newest 60 runs, oldest first. */
  strip: Dot[];
  /** The tool's open CONFIRMED incident. Null for a tool that is passing or being verified. */
  openIncident: IncidentView | null;
  /** The tool's other confirmed incidents (resolved), newest first. */
  incidents: IncidentView[];
  latestRun: SafeRun | null;
}

export async function loadToolPage(source: DataSource, slug: string): Promise<ToolPage | null> {
  if (!isValidSlug(slug)) return null;
  const [tools, history, incidents] = await Promise.all([
    source.listTools(),
    source.listToolHistory(slug, TOOL_STRIP_LENGTH),
    source.listIncidents(),
  ]);
  const row = tools.find((t) => t.slug === slug);
  if (!row) return null;
  const confirmed = confirmedOnly(withoutHiddenHistory(tools, incidents));
  const [tool] = buildToolSummaries([row], row.history_hidden ? [] : history, confirmed);
  if (!tool) return null;
  // The vendor asked for its past results to be hidden: the page has none, whatever the data layer below still holds.
  if (row.history_hidden)
    return { tool, strip: [], openIncident: null, incidents: [], latestRun: null };

  const views = buildIncidentViews(confirmed.filter((i) => i.tool_slug === slug));
  const open = views.find((v) => v.state === 'OPEN') ?? null;
  const run = row.last_run_id ? await source.getRun(row.last_run_id) : null;
  const strip: Dot[] = [...history]
    .sort((x, y) => x.rn - y.rn) // newest first
    .slice(0, TOOL_STRIP_LENGTH)
    .reverse() // oldest first, left to right
    .map((h) => ({ runId: h.run_id, kind: h.kind, stale: h.stale, at: h.started_at }));
  return {
    tool,
    strip,
    openIncident: open,
    incidents: views.filter((v) => v.id !== open?.id),
    latestRun: run && run.tool_slug === slug ? sanitizeRun(run, confirmed) : null,
  };
}

export interface RunPage {
  run: SafeRun;
  toolSlug: string;
  toolName: string;
  docsUrl: string;
  targetLevel: number;
}

export async function loadRunPage(source: DataSource, id: string): Promise<RunPage | null> {
  if (!isUuid(id)) return null;
  const run = await source.getRun(id);
  if (!run) return null;
  const [tools, incidents] = await Promise.all([source.listTools(), source.listIncidents()]);
  const tool = tools.find((t) => t.slug === run.tool_slug);
  if (!tool || tool.history_hidden) return null;
  return {
    run: sanitizeRun(run, confirmedOnly(incidents)),
    toolSlug: tool.slug,
    toolName: tool.name,
    docsUrl: tool.docs_url,
    targetLevel: tool.level,
  };
}

export async function loadIncidentsPage(source: DataSource): Promise<IncidentView[]> {
  const [tools, incidents] = await Promise.all([source.listTools(), source.listIncidents()]);
  return buildIncidentViews(withoutHiddenHistory(tools, incidents));
}

/** The status the badge shows. A slug that is malformed or not tracked is "not tracked". */
/**
 * The slugs of the tracked tools, sorted. The badge, the image and the tool page check a slug against this one list before they look
 * anything up, so a slug nobody tracks costs no query and no cache entry of its own.
 */
export async function loadKnownSlugs(source: DataSource): Promise<string[]> {
  return (await source.listTools()).map((t) => t.slug).sort();
}

export async function loadBadgeStatus(source: DataSource, slug: string): Promise<BadgeStatus> {
  if (!isValidSlug(slug)) return 'not_tracked';
  const [tools, incidents] = await Promise.all([source.listTools(), source.listIncidents()]);
  const row = tools.find((t) => t.slug === slug);
  if (!row) return 'not_tracked';
  if (row.opted_out_at !== null) return 'opted_out';
  return (buildToolSummaries([row], [], incidents)[0]?.status ?? 'not_tracked') satisfies
    PublicStatus | 'not_tracked';
}

export interface OgData {
  name: string;
  /** The vendor opted out: the image says so and shows no result. */
  optedOut: boolean;
  status: PublicStatus;
  failingSince: string | null;
  /** The failing error line. ONLY for a confirmed incident; null for everything else. */
  errorLine: string | null;
}

const MAX_ERROR_LINE = 120;

export async function loadOgData(source: DataSource, slug: string): Promise<OgData | null> {
  const page = await loadToolPage(source, slug);
  if (!page) return null;
  let errorLine: string | null = null;
  if (page.tool.status === 'failing' && page.latestRun?.causeVisible) {
    const stderr =
      page.latestRun.steps.find((s) => s.outcome === 'FAIL' && s.stderr_tail)?.stderr_tail ?? '';
    const line =
      stderr
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? '';
    errorLine =
      line === ''
        ? null
        : line.length > MAX_ERROR_LINE
          ? `${line.slice(0, MAX_ERROR_LINE - 1)}${String.fromCodePoint(0x2026)}`
          : line;
  }
  return {
    name: page.tool.name,
    optedOut: page.tool.optedOutAt !== null,
    status: page.tool.status,
    failingSince: page.tool.failingSince,
    errorLine,
  };
}
