import { revalidatePath, revalidateTag } from 'next/cache';
import { DATA_TAG } from '@/lib/cached';
import { ConfigError, revalidateSecret } from '@/lib/env';
import { compareSecrets } from '@/lib/secret-compare';

// POST /api/revalidate: the API calls this at the end of each probe cycle so new results show up at once.
// Authenticated with REVALIDATE_SECRET in the x-revalidate-secret header (what apps/api sends), compared in constant time.
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request): Promise<Response> {
  let expected: string;
  try {
    expected = revalidateSecret();
  } catch (err) {
    return json(
      { ok: false, error: err instanceof ConfigError ? err.message : 'not configured' },
      503,
    );
  }
  const given = req.headers.get('x-revalidate-secret') ?? '';
  if (given === '' || !compareSecrets(given, expected)) return json({ ok: false }, 401);

  revalidateTag(DATA_TAG);
  revalidatePath('/', 'layout');
  return json({ ok: true, revalidated: true }, 200);
}
