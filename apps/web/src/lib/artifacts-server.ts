import { artifactUrl, parseDiff, isSafeArtifactPath, type DiffLine } from './artifacts';
import { fixtureDiff } from './data/fixtures';
import { dataMode, supabaseConfig } from './env';

// Server-side access to artifacts: where a log lives (for the browser to fetch) and the docs diff text.
// In fixtures mode the artifacts come from the test-only route /api/fixtures/..., never from the network.

/** The URL the browser fetches a log from, or null when the path is missing or unsafe. */
export function logHref(path: string | null): string | null {
  if (path === null || !isSafeArtifactPath(path)) return null;
  if (dataMode() === 'fixtures') return `/api/fixtures/${path}`;
  return artifactUrl(supabaseConfig().url, path);
}

export type DiffResult = { ok: true; lines: DiffLine[]; truncated: boolean } | { ok: false };

const MAX_DIFF_BYTES = 256 * 1024;

export async function loadDiff(path: string | null): Promise<DiffResult> {
  if (path === null || !isSafeArtifactPath(path)) return { ok: false };
  let text: string | null = null;
  if (dataMode() === 'fixtures') {
    text = fixtureDiff(path);
  } else {
    const url = artifactUrl(supabaseConfig().url, path);
    if (url === null) return { ok: false };
    try {
      const res = await fetch(url, { next: { revalidate: 3600, tags: ['qsr-data'] } });
      if (res.ok) text = (await res.text()).slice(0, MAX_DIFF_BYTES);
    } catch {
      text = null;
    }
  }
  if (text === null) return { ok: false };
  const total = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  const lines = parseDiff(text);
  return { ok: true, lines, truncated: total > lines.length };
}
