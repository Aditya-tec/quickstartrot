import { confirmedOnly, sanitizeRun, type PublicStatus, type SafeRun } from '@qsr/core/public';
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

export async function loadHome(source: DataSource): Promise<HomeModel> {
  const [tools, history, incidents] = await Promise.all([
    source.listTools(),
    source.listHistory(STRIP_LENGTH),
    source.listIncidents(),
  ]);
  return buildHomeModel(buildToolSummaries(tools, history, incidents));
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
  const confirmed = confirmedOnly(incidents);
  const [tool] = buildToolSummaries([row], history, confirmed);
  if (!tool) return null;

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
  if (!tool) return null;
  return {
    run: sanitizeRun(run, confirmedOnly(incidents)),
    toolSlug: tool.slug,
    toolName: tool.name,
    docsUrl: tool.docs_url,
    targetLevel: tool.level,
  };
}

export async function loadIncidentsPage(source: DataSource): Promise<IncidentView[]> {
  return buildIncidentViews(await source.listIncidents());
}

/** The status the badge shows. A slug that is malformed or not tracked is "not tracked". */
export async function loadBadgeStatus(source: DataSource, slug: string): Promise<BadgeStatus> {
  if (!isValidSlug(slug)) return 'not_tracked';
  const [tools, incidents] = await Promise.all([source.listTools(), source.listIncidents()]);
  const row = tools.find((t) => t.slug === slug);
  if (!row) return 'not_tracked';
  return (buildToolSummaries([row], [], incidents)[0]?.status ?? 'not_tracked') satisfies
    PublicStatus | 'not_tracked';
}

export interface OgData {
  name: string;
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
    status: page.tool.status,
    failingSince: page.tool.failingSince,
    errorLine,
  };
}
