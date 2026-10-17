import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/admin-session';

// Protects /admin/*: only a request with a valid, unexpired session cookie gets past, and everything under
// /admin is marked no-store and noindex. The login page itself is open. Runs on the Edge runtime, which is why
// the session check uses Web Crypto only. Every server action checks the session again.
export const config = { matcher: ['/admin', '/admin/:path*'] };

const LOGIN = '/admin/login';

function guarded(response: NextResponse): NextResponse {
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (pathname === LOGIN) return guarded(NextResponse.next());

  const secret = process.env['ADMIN_SESSION_SECRET'] ?? '';
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? '';
  const valid =
    secret !== '' &&
    cookie !== '' &&
    (await verifySession(secret, cookie, Math.floor(Date.now() / 1000)));
  if (valid) return guarded(NextResponse.next());

  const url = req.nextUrl.clone();
  url.pathname = LOGIN;
  url.search = '';
  return guarded(NextResponse.redirect(url, 303));
}
