import { PUBLIC_FIXTURE_PATHS, fixtureDiff, fixtureLog } from '@/lib/data/fixtures';
import { dataMode } from '@/lib/env';

// Test-only: serves the fixture logs and diffs when QSR_DATA=fixtures, so the log viewer can be tested without a
// storage bucket. Only artifacts of confirmed items are served; everything else (and every request outside
// fixtures mode) is a 404.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const key = path.join('/');
  if (dataMode() !== 'fixtures' || !PUBLIC_FIXTURE_PATHS.includes(key))
    return new Response('Not found', { status: 404 });
  const log = fixtureLog(key);
  if (log) {
    return new Response(new Uint8Array(log), {
      headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' },
    });
  }
  const diff = fixtureDiff(key);
  if (diff !== null)
    return new Response(diff, {
      headers: { 'content-type': 'text/x-diff; charset=utf-8', 'cache-control': 'no-store' },
    });
  return new Response('Not found', { status: 404 });
}
