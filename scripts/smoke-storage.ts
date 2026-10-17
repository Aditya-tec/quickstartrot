// pnpm smoke:storage - proves the log path works against a REAL Supabase project, end to end, in about a second:
//   1. sign an upload URL the way POST /internal/uploads does (the API's own Storage client, a real log path shape)
//   2. upload a small gzipped file the way `qsr report` does (the shared putToSignedUrl)
//   3. read it back through the PUBLIC URL the website will use, the way a browser would (Accept-Encoding sent)
//   4. check the bytes arrive as raw gzip (no Content-Encoding the browser would undo) and decode to what we sent
//   5. delete it, and check it is gone
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (the package script loads ./.env).
// The object is removed in a `finally`, so a failed check leaves nothing behind.

import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PUBLIC_BUCKET, createSupabaseStorage } from '../apps/api/dist/storage.js';
import { logPathFor } from '../apps/api/dist/log-paths.js';
import { putToSignedUrl } from '../packages/cli/dist/probe/upload.js';

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
if (!url || !key) {
  console.error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (they are in your local .env).',
  );
  process.exit(2);
}

let failed = 0;
const check = (ok: boolean, name: string, detail: string): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} - ${detail}`);
};

const storage = createSupabaseStorage({ url, serviceRoleKey: key });
// A path with the real shape (logs/<cycle>/<tool>-<attempt>-<token>/NN-<step>.log.gz) in a throwaway run directory.
const cycleId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
const path = logPathFor('smoke-storage-throwaway-secret', cycleId, 'smoke-storage', 1, {
  stepId: 'smoke',
  ordinal: 0,
});
const text = `qsr smoke:storage ${new Date().toISOString()}\nline two: café ✓\n`;

async function main(): Promise<void> {
  // 1. sign
  const signed = await storage.createSignedUpload(PUBLIC_BUCKET, path);
  const host = new URL(signed.signedUrl).host;
  check(signed.signedUrl.includes('token='), 'sign', `got a signed upload URL on ${host}`);

  // 2. upload
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  const put = await putToSignedUrl({ fetch, signedUrl: signed.signedUrl, data: gz });
  check(put.ok, 'upload', `PUT ${put.status} (${gz.length} bytes gzipped)`);
  if (!put.ok) return;

  // 3. read back through the public URL, like the browser's log viewer
  const publicUrl = `${url.replace(/\/+$/, '')}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;
  const res = await fetch(publicUrl, {
    headers: { 'Accept-Encoding': 'gzip, deflate, br', Origin: 'https://quickstartrot.vercel.app' },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  check(res.status === 200, 'public read', `GET ${res.status}, ${bytes.length} bytes`);

  // 4. raw gzip, nothing double-encoded
  check(
    res.headers.get('content-encoding') === null,
    'no Content-Encoding',
    `content-encoding: ${res.headers.get('content-encoding') ?? '(none)'}`,
  );
  check(
    bytes[0] === 0x1f && bytes[1] === 0x8b,
    'raw gzip bytes',
    'the body starts with the gzip magic 1f 8b',
  );
  check(
    Buffer.compare(bytes, gz) === 0,
    'identical bytes',
    'what came back is byte-for-byte what was uploaded',
  );
  check(
    (res.headers.get('content-type') ?? '').startsWith('application/gzip'),
    'content type',
    res.headers.get('content-type') ?? '(none)',
  );
  check(
    res.headers.get('access-control-allow-origin') !== null,
    'CORS',
    `access-control-allow-origin: ${res.headers.get('access-control-allow-origin') ?? '(none)'}`,
  );
  let decoded = '';
  try {
    decoded = gunzipSync(bytes).toString('utf8');
  } catch {
    /* reported below */
  }
  check(
    decoded === text,
    'decodes',
    decoded === text
      ? 'gunzip gives the original text, accents included'
      : 'gunzip did not give the original text',
  );
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.log(
    `FAIL  smoke crashed - ${err instanceof Error ? err.message.replace(key, '[key]') : String(err)}`,
  );
} finally {
  // 5. delete, and prove it is gone. The authenticated endpoint is not cached; the PUBLIC url is served from a CDN
  // with `Cache-Control: public, max-age=3600`, so it may keep answering for a while after a delete (information only).
  try {
    await storage.remove(PUBLIC_BUCKET, [path]);
    const base = `${url.replace(/\/+$/, '')}/storage/v1`;
    const direct = await fetch(`${base}/object/authenticated/${PUBLIC_BUCKET}/${path}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    await direct.arrayBuffer();
    check(
      direct.status === 400 || direct.status === 404,
      'delete',
      `after removal Storage itself answers ${direct.status} for the object`,
    );
    const cdn = await fetch(`${base}/object/public/${PUBLIC_BUCKET}/${path}`);
    await cdn.arrayBuffer();
    console.log(
      `INFO  public URL after delete answers ${cdn.status} (a CDN may serve its cached copy up to Cache-Control max-age, 3600 s)`,
    );
  } catch (err) {
    failed += 1;
    console.log(
      `FAIL  delete - ${err instanceof Error ? err.message.replace(key, '[key]') : String(err)}`,
    );
  }
}
console.log(failed === 0 ? '\nAll storage checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
