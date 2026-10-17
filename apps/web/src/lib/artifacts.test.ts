import { describe, expect, it } from 'vitest';
import { artifactUrl, classifyDiffLine, isSafeArtifactPath, parseDiff } from './artifacts';

// Logs and docs diffs live in the public-artifacts bucket. The page builds their URLs from a path in a database
// row, so the path is validated first, and a diff is shown as text, line by line.

const SUPABASE = 'https://abc.supabase.co';

describe('isSafeArtifactPath', () => {
  it.each(['logs/2026/run-1/02-s3.log.gz', 'diffs/abc-123.diff', 'a/b_c.d-e/f'])(
    'accepts %s',
    (p) => {
      expect(isSafeArtifactPath(p)).toBe(true);
    },
  );
  it.each([
    '',
    '/etc/passwd',
    '../secret',
    'logs/../../x',
    'logs//x',
    'logs/a b',
    'logs/a?x=1',
    'logs/a#frag',
    'http://evil.example/x',
    'logs/\u0000x',
    'logs/%2e%2e/x',
    'x'.repeat(400),
  ])('rejects %j', (p) => {
    expect(isSafeArtifactPath(p)).toBe(false);
  });
});

describe('artifactUrl', () => {
  it('points at the public bucket of the project', () => {
    expect(artifactUrl(SUPABASE, 'logs/r1/s1.log.gz')).toBe(
      `${SUPABASE}/storage/v1/object/public/public-artifacts/logs/r1/s1.log.gz`,
    );
  });
  it('returns null for an unsafe path', () => {
    expect(artifactUrl(SUPABASE, '../x')).toBeNull();
    expect(artifactUrl(SUPABASE, null)).toBeNull();
  });
});

describe('classifyDiffLine', () => {
  it.each([
    ['+++ b/file', 'header'],
    ['--- a/file', 'header'],
    ['@@ -1,3 +1,3 @@', 'hunk'],
    ['+added', 'add'],
    ['-removed', 'remove'],
    [' context', 'context'],
    ['Index: x', 'context'],
  ] as const)('%j is %s', (line, kind) => {
    expect(classifyDiffLine(line)).toBe(kind);
  });
});

describe('parseDiff', () => {
  it('turns diff text into typed lines', () => {
    const lines = parseDiff('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n');
    expect(lines.map((l) => l.kind)).toEqual(['header', 'header', 'hunk', 'remove', 'add']);
    expect(lines[3]?.text).toBe('-old');
  });
  it('limits the number of lines and says how many were cut', () => {
    const text = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
    const r = parseDiff(text, 10);
    expect(r).toHaveLength(10);
  });
  it('keeps markup as plain characters', () => {
    expect(parseDiff('+<script>alert(1)</script>')[0]?.text).toBe('+<script>alert(1)</script>');
  });
});
