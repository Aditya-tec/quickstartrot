import { LANGUAGES, type Language } from '@qsr/core/public';
import type { ToolSummary } from './model';

// Filters and sort for the leaderboard live in the URL (/?lang=node&status=failing&sort=name&dir=desc): the
// page is rendered on the server, a view can be shared, and nothing needs client-side state. A value the URL
// carries that we do not understand falls back to the default instead of being echoed anywhere.

export const STATUS_FILTERS = ['all', 'passing', 'failing', 'verifying'] as const;
export const LEVEL_FILTERS = ['all', 'L3', 'L2', 'L1'] as const;
export const SORTS = ['status', 'name', 'pass_rate', 'checked'] as const;
export const DIRS = ['asc', 'desc'] as const;

export interface HomeParams {
  lang: 'all' | Language;
  status: (typeof STATUS_FILTERS)[number];
  level: (typeof LEVEL_FILTERS)[number];
  sort: (typeof SORTS)[number];
  dir: (typeof DIRS)[number];
}

export const DEFAULT_PARAMS: HomeParams = {
  lang: 'all',
  status: 'all',
  level: 'all',
  sort: 'status',
  dir: 'asc',
};

type Raw = Record<string, string | string[] | undefined>;

function pick<T extends string>(raw: Raw, key: string, allowed: readonly T[], fallback: T): T {
  const value = raw[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function parseHomeParams(raw: Raw): HomeParams {
  return {
    lang: pick(raw, 'lang', ['all', ...LANGUAGES] as const, DEFAULT_PARAMS.lang),
    status: pick(raw, 'status', STATUS_FILTERS, DEFAULT_PARAMS.status),
    level: pick(raw, 'level', LEVEL_FILTERS, DEFAULT_PARAMS.level),
    sort: pick(raw, 'sort', SORTS, DEFAULT_PARAMS.sort),
    dir: pick(raw, 'dir', DIRS, DEFAULT_PARAMS.dir),
  };
}

/** The URL for a set of parameters; defaults are left out, so the plain home page has no query string. */
export function homeHref(params: HomeParams): string {
  const query = new URLSearchParams();
  for (const key of ['lang', 'status', 'level', 'sort', 'dir'] as const)
    if (params[key] !== DEFAULT_PARAMS[key]) query.set(key, params[key]);
  const text = query.toString();
  return text === '' ? '/' : `/?${text}`;
}

const STATUS_ORDER: Record<string, number> = { failing: 0, verifying: 1, passing: 2 };
const levelTier = (level: number): HomeParams['level'] =>
  level >= 3 ? 'L3' : level === 2 ? 'L2' : 'L1';
const byName = (a: ToolSummary, b: ToolSummary): number =>
  a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en');

export function filterAndSort(tools: readonly ToolSummary[], params: HomeParams): ToolSummary[] {
  const kept = tools.filter(
    (t) =>
      (params.lang === 'all' || t.language === params.lang) &&
      (params.status === 'all' || t.status === params.status) &&
      (params.level === 'all' || levelTier(t.level) === params.level),
  );
  const sign = params.dir === 'asc' ? 1 : -1;

  /** Compare two possibly-missing numbers: missing values always go last, whichever way we sort. */
  const numeric = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * sign;
  };

  return [...kept].sort((a, b) => {
    let order = 0;
    switch (params.sort) {
      case 'status':
        order = ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)) * sign;
        break;
      case 'name':
        order = byName(a, b) * sign;
        return order;
      case 'pass_rate':
        order = numeric(a.passRate, b.passRate);
        break;
      case 'checked':
        order = numeric(
          a.lastRunAt === null ? null : Date.parse(a.lastRunAt),
          b.lastRunAt === null ? null : Date.parse(b.lastRunAt),
        );
        break;
    }
    return order !== 0 ? order : byName(a, b);
  });
}
