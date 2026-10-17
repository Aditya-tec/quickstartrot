// How a gzipped log reaches a signed Supabase Storage upload URL. `qsr report` (every probe run) and
// `pnpm smoke:storage` both call this, so the smoke test exercises exactly the production request.

export interface SignedUpload {
  fetch: typeof fetch;
  /** The URL from /internal/uploads (it carries its own token). */
  signedUrl: string;
  /** The gzipped bytes. */
  data: Buffer | Uint8Array;
  /** The PUBLIC anon key, sent as `apikey` only when the project's gateway wants one (it does not today). */
  anonKey?: string | null;
}

/**
 * Same shape as supabase-js `uploadToSignedUrl`: a multipart PUT with the file under an empty field name,
 * `cacheControl`, and `x-upsert` so a re-run of the report can write the same path again. The response is
 * returned as is: the caller decides what a refusal means.
 */
export async function putToSignedUrl(upload: SignedUpload): Promise<Response> {
  const form = new FormData();
  form.append('cacheControl', '3600');
  form.append('', new Blob([new Uint8Array(upload.data)], { type: 'application/gzip' }));
  return upload.fetch(upload.signedUrl, {
    method: 'PUT',
    headers: {
      'x-upsert': 'true',
      ...(upload.anonKey ? { apikey: upload.anonKey } : {}),
    },
    body: form,
  });
}
