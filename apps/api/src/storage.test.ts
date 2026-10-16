import { describe, expect, it } from 'vitest';
import { createSupabaseStorage, StorageError } from './storage.js';

// The Supabase Storage REST client, against a fake fetch: the right URLs, the service key only in headers,
// and every failure as a StorageError that does not leak the key.

const KEY = 'service-role-key-value-0123456789';
const URL_BASE = 'https://abc.supabase.co';

function make(replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const storage = createSupabaseStorage({
    url: `${URL_BASE}/`,
    serviceRoleKey: KEY,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  return { storage, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createSignedUpload', () => {
  it('asks Storage for a signed upload URL and returns an absolute one', async () => {
    const { storage, calls } = make([
      json({ url: '/object/upload/sign/public-artifacts/logs/a b/x.gz?token=T1', token: 'T1' }),
    ]);
    const r = await storage.createSignedUpload('public-artifacts', 'logs/a b/x.gz');
    expect(r).toEqual({
      signedUrl: `${URL_BASE}/storage/v1/object/upload/sign/public-artifacts/logs/a b/x.gz?token=T1`,
      token: 'T1',
    });
    expect(calls[0]?.url).toBe(
      `${URL_BASE}/storage/v1/object/upload/sign/public-artifacts/logs/a%20b/x.gz`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${KEY}`,
    );
  });

  it('asks for an upsert, so a retried report can sign the same path again', async () => {
    const { storage, calls } = make([json({ url: '/object/upload/sign/b/p?token=T', token: 'T' })]);
    await storage.createSignedUpload('b', 'p');
    expect((calls[0]?.init.headers as Record<string, string>)['x-upsert']).toBe('true');
  });

  it('keeps an absolute URL that Storage returns', async () => {
    const { storage } = make([json({ url: 'https://other.example/up?token=T', token: 'T' })]);
    expect((await storage.createSignedUpload('b', 'p')).signedUrl).toBe(
      'https://other.example/up?token=T',
    );
  });

  it('a malformed answer is a StorageError', async () => {
    const { storage } = make([json({ nope: true })]);
    await expect(storage.createSignedUpload('b', 'p')).rejects.toThrow(/unexpected response/);
  });
});

describe('put, remove and list', () => {
  it('uploads with upsert and the content type', async () => {
    const { storage, calls } = make([json({})]);
    await storage.put('public-artifacts', 'diffs/x.diff', 'hello', 'text/x-diff');
    expect(calls[0]?.url).toBe(`${URL_BASE}/storage/v1/object/public-artifacts/diffs/x.diff`);
    expect(calls[0]?.init.body).toBe('hello');
    expect(calls[0]?.init.headers).toMatchObject({
      'Content-Type': 'text/x-diff',
      'x-upsert': 'true',
    });
  });

  it('uploads binary bodies', async () => {
    const { storage, calls } = make([json({})]);
    await storage.put('b', 'p', new Uint8Array([1, 2, 3]), 'application/gzip');
    expect(Buffer.isBuffer(calls[0]?.init.body)).toBe(true);
  });

  it('removes many paths in one call, and nothing at all for an empty list', async () => {
    const { storage, calls } = make([json([])]);
    await storage.remove('public-artifacts', []);
    expect(calls).toHaveLength(0);
    await storage.remove('public-artifacts', ['a', 'b']);
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ prefixes: ['a', 'b'] });
  });

  it('lists a prefix across pages, returning FULL paths with their age and size', async () => {
    const page = (n: number, start = 0) =>
      json(
        Array.from({ length: n }, (_, i) => ({
          name: `f${start + i}.zip`,
          updated_at: '2026-10-01T00:00:00Z',
          metadata: { size: 5 },
        })),
      );
    const { storage, calls } = make([page(100), page(2, 100)]);
    const out = await storage.list('private-artifacts', 'traces');
    expect(out).toHaveLength(102);
    expect(out[0]).toEqual({ name: 'traces/f0.zip', updatedAt: '2026-10-01T00:00:00Z', size: 5 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      prefix: 'traces',
      offset: 100,
    });
  });

  it('a missing updated_at / size is treated as very old / empty, and an empty prefix gives bare names', async () => {
    const { storage } = make([json([{ name: 'x.zip' }])]);
    expect(await storage.list('b', '')).toEqual([
      { name: 'x.zip', updatedAt: new Date(0).toISOString(), size: 0 },
    ]);
  });
});

describe('failures', () => {
  it('an HTTP error and a network error are StorageErrors that never contain the key', async () => {
    const { storage } = make([
      new Response('denied', { status: 403 }),
      new Error(`connect failed with ${KEY}`.replace(KEY, 'host')),
    ]);
    const a = await storage.put('b', 'p', 'x', 'text/plain').catch((e: unknown) => e);
    expect(a).toBeInstanceOf(StorageError);
    expect(String(a)).toContain('403');
    expect(String(a)).not.toContain(KEY);
    const b = await storage.remove('b', ['p']).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(StorageError);
    expect(String(b)).not.toContain(KEY);
  });
});
