// Smoke test for a deployed API:  pnpm smoke:api --url https://<service>.onrender.com
//
// Reads INGEST_HMAC_SECRET from the environment (the same value that is set on Render; never passed on the
// command line, so it stays out of shell history). Prints one line per check and exits non-zero if any fails.
// Run with Node >= 22.6 type stripping (the pnpm script passes the flag); it imports the built CLI client.

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signRequest } from '../packages/core/dist/index.js';
import { ApiWakeError, createApiClient } from '../packages/cli/dist/api-client.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1) return process.argv[i + 1];
  const joined = process.argv.find((a) => a.startsWith(`${name}=`));
  return joined?.slice(name.length + 1);
}

const url = argValue('--url');
const secret = process.env['INGEST_HMAC_SECRET'];
if (!url || !/^https?:\/\//.test(url)) {
  console.error(
    'usage: INGEST_HMAC_SECRET=... pnpm smoke:api --url https://<service>.onrender.com',
  );
  process.exit(2);
}
if (!secret) {
  console.error('INGEST_HMAC_SECRET is not set in this shell (use the same value as on Render).');
  process.exit(2);
}
const base = url.replace(/\/+$/, '');

let failed = 0;
function report(ok: boolean, name: string, detail: string): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} - ${detail}`);
}

// A signed request to /internal/cycles built by hand so the timestamp and signature can be falsified.
// Idempotent: the fixed gh_run_id means repeated smoke runs share one cycle row (real GitHub run ids are far larger).
const body = JSON.stringify({
  trigger: 'manual',
  gitSha: 'smoke-test',
  ghRunId: 1,
  ghRunAttempt: 1,
});
async function rawPost(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${base}/internal/cycles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  await res.arrayBuffer();
  return res.status;
}
const sign = (timestamp: number, key: string): Record<string, string> => ({
  [TIMESTAMP_HEADER]: String(timestamp),
  [SIGNATURE_HEADER]: signRequest(key, timestamp, Buffer.from(body, 'utf8')),
});

async function main(): Promise<void> {
  const client = createApiClient({ baseUrl: base, secret: secret as string });

  // 1. wake (a Render free instance that slept takes 30-60 s)
  const started = Date.now();
  try {
    const woke = await client.wakeApi();
    report(
      true,
      'wake',
      `answered after ${Math.round(woke.waitedMs / 1000)} s (${woke.attempts} tries)`,
    );
  } catch (err) {
    report(false, 'wake', err instanceof ApiWakeError ? err.message : String(err));
    return;
  }

  // 2. health
  try {
    const h = await client.health();
    report(true, '/health', `status=${h.status} db=${String(h.db)} time=${h.time}`);
  } catch (err) {
    report(false, '/health', String(err));
  }

  // 3. a correctly signed POST succeeds
  try {
    const r = await client.post<{ cycleId: string; created: boolean; tools: unknown[] }>(
      '/internal/cycles',
      JSON.parse(body) as unknown,
    );
    report(
      typeof r.cycleId === 'string',
      'signed POST /internal/cycles',
      `cycle ${r.cycleId} (created=${String(r.created)}, ${r.tools.length} enabled tools)`,
    );
  } catch (err) {
    report(false, 'signed POST /internal/cycles', String(err));
  }

  // 4. a wrong signature is refused
  const now = Math.floor(Date.now() / 1000);
  const bad = await rawPost(sign(now, `${secret}-wrong`));
  report(bad === 401, 'bad signature', `expected 401, got ${bad}`);

  // 5. a correctly signed but stale request is refused
  const stale = await rawPost(sign(now - 1000, secret as string));
  report(stale === 401, 'stale timestamp', `expected 401, got ${stale}`);

  // 6. the admin API without a token is refused
  const admin = await fetch(`${base}/admin/queue`, { signal: AbortSignal.timeout(30_000) });
  await admin.arrayBuffer();
  report(admin.status === 401, 'admin without token', `expected 401, got ${admin.status}`);

  console.log(
    `\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`} in ${Math.round((Date.now() - started) / 1000)} s.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(`smoke test crashed: ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  })
  .finally(() => {
    process.exit(failed === 0 ? 0 : 1);
  });
