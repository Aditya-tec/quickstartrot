// Logs and docs diffs live in the public-artifacts bucket (public read, unguessable paths). A path comes from a
// database row, so it is validated before it becomes a URL, and a diff is shown as plain text.

export const PUBLIC_BUCKET = 'public-artifacts';
const SAFE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function isSafeArtifactPath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  if (!SAFE_PATH.test(path)) return false;
  return !path.split('/').some((part) => part === '.' || part === '..');
}

export function artifactUrl(supabaseOrigin: string, path: string | null): string | null {
  if (path === null || !isSafeArtifactPath(path)) return null;
  return `${supabaseOrigin}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;
}

export type DiffKind = 'header' | 'hunk' | 'add' | 'remove' | 'context';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export function classifyDiffLine(line: string): DiffKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

export const MAX_DIFF_LINES = 400;

export function parseDiff(text: string, maxLines: number = MAX_DIFF_LINES): DiffLine[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(0, maxLines).map((line) => ({ kind: classifyDiffLine(line), text: line }));
}
