import type { Db, DbHandle } from '@qsr/db';
import type { LlmClient } from '@qsr/compiler';
import type { Config } from './config.js';
import type { Storage } from './storage.js';

/** Everything the app needs from the outside world. The server wires real ones; tests pass fakes. */
export interface AppDeps {
  config: Config;
  handle: DbHandle;
  /** The provider client (Groq). Null when there is no key: compiles are deferred, nothing crashes. */
  llm: LlmClient | null;
  /** Supabase Storage. Null when not configured: /internal/uploads answers 503. */
  storage: Storage | null;
  fetch: typeof fetch;
  now: () => Date;
  /** Where the request log goes (tests capture it). Defaults to stdout. */
  logStream?: NodeJS.WritableStream | undefined;
}

export type { Db };

/** What route handlers receive, built once in buildApp. */
export interface Ctx {
  deps: AppDeps;
  db: Db;
}
