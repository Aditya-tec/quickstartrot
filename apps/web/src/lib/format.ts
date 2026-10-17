// Formatting for the public pages. Everything is UTC and deterministic (no locale, no time zone of the
// machine), so the server render and the browser agree and screenshots are reproducible.

const DASH = String.fromCodePoint(0x2014);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses an ISO string, or the `2026-10-12 04:27:16.394+00` shape Postgres can send. */
function parse(value: string | null): Date | null {
  if (value === null) return null;
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDay(value: string | null): string {
  const d = parse(value);
  return d === null ? DASH : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatDateTime(value: string | null): string {
  const d = parse(value);
  if (d === null) return DASH;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** 0.9667 -> "96.7%". Never rounds up to 100% for a rate below it. */
export function formatPercent(rate: number | null): string {
  if (rate === null) return DASH;
  let pct = Math.round(rate * 1000) / 10;
  if (pct >= 100 && rate < 1) pct = 99.9; // a rate below 1 is never shown as a perfect 100%
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000)
    return `${Number.isInteger(ms / 1000) ? ms / 1000 : (Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function relativeTime(value: string | null, now: Date): string {
  const d = parse(value);
  if (d === null) return DASH;
  const s = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return formatDay(value);
}

/** 1536 -> "1.5 KB". Binary units, as the free-tier limits are quoted. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const shortId = (id: string): string => id.slice(0, 8);

export const EM_DASH = DASH;
