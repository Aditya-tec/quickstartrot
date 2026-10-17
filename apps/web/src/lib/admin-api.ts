import { AdminQueueResponse, type ConfirmBody, type FalsePositiveBody } from '@qsr/core/public';
import { z } from 'zod';
import { isUuid } from './service';

// The admin pages call the API from the server with the bearer token. The token and the API address never reach
// the browser, and neither appears in an error message. Each answer is parsed with the schema from @qsr/core.

export type AdminResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface AdminApiDeps {
  fetch: typeof fetch;
  apiBaseUrl: string;
  token: string;
}

const Ok = z.object({ ok: z.literal(true) });
const Problem = z.object({ detail: z.string().optional() });
const TIMEOUT_MS = 55_000; // a sleeping API can take most of a minute to answer the first request

const fail = (status: number, message: string): { ok: false; status: number; message: string } => ({
  ok: false,
  status,
  message,
});

export function createAdminApi(deps: AdminApiDeps) {
  async function call<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  ): Promise<AdminResult<T>> {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.apiBaseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${deps.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail(0, 'The API could not be reached. It may be waking up; try again in a minute.');
    }
    if (res.status === 401 || res.status === 403)
      return fail(
        res.status,
        'The API rejected the admin token. Check ADMIN_TOKEN on the web app.',
      );
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const parsed = Problem.safeParse(await res.json());
        detail = parsed.success ? parsed.data.detail?.slice(0, 300) : undefined;
      } catch {
        detail = undefined;
      }
      return fail(res.status, detail ?? `The API answered with status ${res.status}.`);
    }
    try {
      const parsed = schema.safeParse(await res.json());
      if (parsed.success) return { ok: true, data: parsed.data };
    } catch {
      /* fall through */
    }
    return fail(res.status, 'The API answered with data in an unexpected shape.');
  }

  const incidentPath = (id: string, action: string): string | null =>
    isUuid(id) ? `/admin/incidents/${id}/${action}` : null;

  return {
    queue: () => call('/admin/queue', AdminQueueResponse),
    async confirm(id: string, body: z.input<typeof ConfirmBody>): Promise<AdminResult<unknown>> {
      const path = incidentPath(id, 'confirm');
      return path === null
        ? fail(400, 'That is not a valid incident id.')
        : call(path, Ok, { method: 'POST', body });
    },
    async falsePositive(
      id: string,
      body: z.input<typeof FalsePositiveBody>,
    ): Promise<AdminResult<unknown>> {
      const path = incidentPath(id, 'false-positive');
      return path === null
        ? fail(400, 'That is not a valid incident id.')
        : call(path, Ok, { method: 'POST', body });
    },
  };
}
