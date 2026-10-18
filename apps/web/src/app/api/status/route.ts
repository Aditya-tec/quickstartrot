import { getHome } from '@/lib/cached';
import { buildStatusSummary } from '@/lib/status-summary';

// GET /api/status: the counts behind the home headline, as JSON. The README table is generated from it and the launch check compares
// the README with it. The same loader as the home page (so the same "verifying" for an unreviewed failure), cached like the pages.
export const revalidate = 300;

export async function GET(): Promise<Response> {
  try {
    return Response.json(buildStatusSummary(await getHome()), {
      headers: { 'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' },
    });
  } catch {
    // the data source is down: say so briefly, and do not let a CDN keep the answer
    return Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'cache-control': 'public, max-age=0, s-maxage=30' } },
    );
  }
}
