import { createClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';
import {
  PublicIncidentRow,
  PublicRunHistoryRow,
  PublicRunRow,
  PublicToolRow,
} from '@qsr/core/public';
import { DataError, type DataSource } from './source';

export { DataError };

/** The only relations the anon role may read (spec section 5). Nothing else is ever queried. */
export const PUBLIC_VIEWS = [
  'public_tools',
  'public_run_history',
  'public_incidents',
  'public_runs',
] as const;
type View = (typeof PUBLIC_VIEWS)[number];

/** The part of supabase-js the data source uses; the tests substitute a fake. */
export interface ViewQuery extends PromiseLike<{
  data: unknown[] | null;
  error: { message: string } | null;
}> {
  select(columns: string): ViewQuery;
  eq(column: string, value: unknown): ViewQuery;
  lte(column: string, value: number): ViewQuery;
  order(column: string, options?: { ascending: boolean }): ViewQuery;
  range(from: number, to: number): ViewQuery;
}
export interface ViewClient {
  from(view: string): ViewQuery;
}

/** PostgREST returns at most this many rows per request unless asked for a range. */
const PAGE = 1000;

export class SupabaseDataSource implements DataSource {
  constructor(private readonly client: ViewClient) {}

  private async read<T>(
    view: View,
    schema: ZodType<T>,
    build: (q: ViewQuery) => ViewQuery,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(this.client.from(view).select('*')).range(
        from,
        from + PAGE - 1,
      );
      // The error text can quote the request; it never reaches a page or a log with the key in it.
      if (error) throw new DataError(`could not read ${view}`);
      const rows = data ?? [];
      rows.forEach((row, i) => {
        const parsed = schema.safeParse(row);
        if (!parsed.success) {
          const fields = [
            ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(row)')),
          ];
          throw new DataError(
            `${view} row ${from + i} does not match its schema (${fields.join(', ')})`,
          );
        }
        out.push(parsed.data);
      });
      if (rows.length < PAGE) return out;
    }
  }

  listTools(): Promise<PublicToolRow[]> {
    return this.read('public_tools', PublicToolRow, (q) => q.order('slug'));
  }

  listHistory(limit: number): Promise<PublicRunHistoryRow[]> {
    return this.read('public_run_history', PublicRunHistoryRow, (q) =>
      q.lte('rn', limit).order('tool_slug').order('rn'),
    );
  }

  listToolHistory(slug: string, limit: number): Promise<PublicRunHistoryRow[]> {
    return this.read('public_run_history', PublicRunHistoryRow, (q) =>
      q.eq('tool_slug', slug).lte('rn', limit).order('rn'),
    );
  }

  listIncidents(): Promise<PublicIncidentRow[]> {
    return this.read('public_incidents', PublicIncidentRow, (q) =>
      q.order('opened_at', { ascending: false }),
    );
  }

  async getRun(id: string): Promise<PublicRunRow | null> {
    const rows = await this.read('public_runs', PublicRunRow, (q) => q.eq('id', id));
    return rows[0] ?? null;
  }
}

/** A client with the PUBLIC anon key, no session, and no Next.js fetch caching (caching is done above). */
export function createSupabaseDataSource(url: string, anonKey: string): SupabaseDataSource {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
  });
  return new SupabaseDataSource(client as unknown as ViewClient);
}
