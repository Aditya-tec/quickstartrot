// Values shared by the Playwright config and the specs. Test-only: none of these is a real credential.

export const WEB_PORT = 3100;
export const WEB_PORT_REVALIDATE = 3101;
export const WEB_PORT_API_DOWN = 3102;
export const STUB_PORT = 4010;
export const BLACKHOLE_PORT = 4011;

export const ADMIN_TOKEN = [
  'e2e',
  'admin',
  'token',
  'for',
  'local',
  'tests',
  'only',
  '0000000000',
].join('-');
export const ADMIN_SESSION_SECRET = [
  'e2e',
  'session',
  'secret',
  'for',
  'local',
  'tests',
  'only',
  '1111111111',
].join('-');
export const REVALIDATE_SECRET = ['e2e', 'revalidate', 'secret', 'for', 'tests'].join('-');
export const SITE_URL = `http://localhost:${WEB_PORT}`;
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
/** An API that accepts connections and never answers. */
export const BLACKHOLE_URL = `http://127.0.0.1:${BLACKHOLE_PORT}`;
