import type {
  PublicIncidentRow,
  PublicRunHistoryRow,
  PublicRunRow,
  PublicToolRow,
} from '@qsr/core/public';

/**
 * Where the public data comes from. Two implementations: SupabaseDataSource (the four public views, anon key,
 * server side only) and FixtureDataSource (seeded in-repo data for development and tests, QSR_DATA=fixtures).
 * Pages never import supabase-js; they get a DataSource and, above it, view models.
 *
 * Rows are the shape of the public views, already parsed with the Zod schemas from @qsr/core. The app still
 * treats them as untrusted for the one rule that matters (see confirmedOnly and sanitizeRun in core).
 */
export interface DataSource {
  listTools(): Promise<PublicToolRow[]>;
  /** The newest `limit` final runs of every tool (public_run_history, rn <= limit). */
  listHistory(limit: number): Promise<PublicRunHistoryRow[]>;
  listToolHistory(slug: string, limit: number): Promise<PublicRunHistoryRow[]>;
  /** What public_incidents returns: confirmed incidents. The app filters again. */
  listIncidents(): Promise<PublicIncidentRow[]>;
  getRun(id: string): Promise<PublicRunRow | null>;
}

export class DataError extends Error {
  override readonly name = 'DataError';
}
