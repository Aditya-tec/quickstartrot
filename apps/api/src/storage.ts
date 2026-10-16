// Supabase Storage over its REST API with the service-role key (spec sections 5 and 11). Runners never see
// that key: /internal/uploads hands them signed upload URLs. The buckets: `public-artifacts` (redacted step
// logs, docs diffs; public read, unguessable paths) and `private-artifacts` (raw HTML snapshots, traces).

export const PUBLIC_BUCKET = 'public-artifacts';
export const PRIVATE_BUCKET = 'private-artifacts';

export interface StoredObject {
  name: string;
  updatedAt: string;
  size: number;
}

export interface Storage {
  /** A URL a runner may PUT one object to, once, without credentials. */
  createSignedUpload(bucket: string, path: string): Promise<{ signedUrl: string; token: string }>;
  put(bucket: string, path: string, body: string | Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: readonly string[]): Promise<void>;
  /** Objects directly under `prefix` (one level), with their age. `name` is the FULL path, ready for remove(). */
  list(bucket: string, prefix: string): Promise<StoredObject[]>;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
}

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export function createSupabaseStorage(options: SupabaseStorageOptions): Storage {
  const base = `${options.url.replace(/\/+$/, '')}/storage/v1`;
  const doFetch = options.fetch ?? fetch;
  const headers = {
    apikey: options.serviceRoleKey,
    Authorization: `Bearer ${options.serviceRoleKey}`,
  };

  async function call(what: string, input: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(input, { ...init, headers: { ...headers, ...init.headers } });
    } catch (err) {
      throw new StorageError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new StorageError(`${what}: HTTP ${res.status}`);
    return res;
  }

  return {
    async createSignedUpload(bucket, path) {
      const res = await call(
        'create signed upload',
        `${base}/object/upload/sign/${bucket}/${encodePath(path)}`,
        {
          method: 'POST',
          // x-upsert: a retried report signs the same path again, and the object may already exist.
          headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' },
          body: '{}',
        },
      );
      const body = (await res.json()) as { url?: unknown; token?: unknown };
      if (typeof body.url !== 'string' || typeof body.token !== 'string')
        throw new StorageError('create signed upload: unexpected response');
      // Storage returns a path relative to /storage/v1 ("/object/upload/sign/<bucket>/<path>?token=...").
      const signedUrl = body.url.startsWith('http') ? body.url : `${base}${body.url}`;
      return { signedUrl, token: body.token };
    },

    async put(bucket, path, body, contentType) {
      await call('upload', `${base}/object/${bucket}/${encodePath(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: typeof body === 'string' ? body : Buffer.from(body),
      });
    },

    async remove(bucket, paths) {
      if (paths.length === 0) return;
      await call('delete', `${base}/object/${bucket}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
    },

    async list(bucket, prefix) {
      const out: StoredObject[] = [];
      for (let offset = 0; ; offset += 100) {
        const res = await call('list', `${base}/object/list/${bucket}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, limit: 100, offset }),
        });
        const page = (await res.json()) as {
          name: string;
          updated_at?: string;
          metadata?: { size?: number } | null;
        }[];
        for (const o of page)
          out.push({
            // Storage lists names relative to the prefix; remove() needs the full path.
            name: prefix === '' ? o.name : `${prefix.replace(/\/+$/, '')}/${o.name}`,
            updatedAt: o.updated_at ?? new Date(0).toISOString(),
            size: o.metadata?.size ?? 0,
          });
        if (page.length < 100) return out;
      }
    },
  };
}
