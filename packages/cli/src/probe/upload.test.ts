import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { putToSignedUrl } from './upload.js';

// The one place that knows how a gzipped log goes to a signed Supabase Storage URL. `qsr report` and
// `pnpm smoke:storage` both use it, so the smoke test exercises exactly what production does.

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: FormData;
}
function fake(status = 200) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      form: init?.body as FormData,
    });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { seen, fetchFn };
}

describe('putToSignedUrl', () => {
  it('PUTs the file as multipart under an empty field name, with cacheControl and an upsert header', async () => {
    const { seen, fetchFn } = fake();
    const data = gzipSync(Buffer.from('hello log\n'));
    const res = await putToSignedUrl({
      fetch: fetchFn,
      signedUrl: 'https://abc.supabase.co/storage/v1/object/upload/sign/b/p.log.gz?token=T',
      data,
    });
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.url).toBe(
      'https://abc.supabase.co/storage/v1/object/upload/sign/b/p.log.gz?token=T',
    );
    expect(seen[0]?.headers['x-upsert']).toBe('true');
    expect(seen[0]?.form.get('cacheControl')).toBe('3600');
    const file = seen[0]?.form.get('') as Blob;
    expect(file.type).toBe('application/gzip');
    expect(gunzipSync(Buffer.from(await file.arrayBuffer())).toString()).toBe('hello log\n');
  });

  it('sends the public anon key as `apikey` only when it has one', async () => {
    const a = fake();
    await putToSignedUrl({
      fetch: a.fetchFn,
      signedUrl: 'https://x/y',
      data: gzipSync('a'),
      anonKey: 'anon',
    });
    expect(a.seen[0]?.headers['apikey']).toBe('anon');
    const b = fake();
    await putToSignedUrl({ fetch: b.fetchFn, signedUrl: 'https://x/y', data: gzipSync('a') });
    expect(b.seen[0]?.headers['apikey']).toBeUndefined();
  });

  it('returns the response, so the caller decides what a refusal means', async () => {
    const { fetchFn } = fake(403);
    const res = await putToSignedUrl({
      fetch: fetchFn,
      signedUrl: 'https://x/y',
      data: gzipSync('a'),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});
