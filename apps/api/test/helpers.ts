import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql as dsql } from 'drizzle-orm';
import {
  signRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type Target,
  type TargetInput,
} from '@qsr/core';
import type { ChatMessage, LlmClient, LlmResponse } from '@qsr/compiler';
import { createDb, type DbHandle } from '@qsr/db';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { AppDeps } from '../src/deps.js';
import type { Storage, StoredObject } from '../src/storage.js';

export const HMAC_SECRET = 'test-hmac-secret-0123456789abcdef';
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
export const FIXED_NOW = new Date('2026-10-16T12:00:00.000Z');

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    INGEST_HMAC_SECRET: HMAC_SECRET,
    ADMIN_TOKEN,
    SUBMISSION_IP_SECRET: 'test-ip-secret-0123456789abcdef',
    WEB_ORIGIN: 'https://qsr.example.vercel.app',
    LOG_LEVEL: 'info',
    // The suites send thousands of requests; the rate-limit tests set their own low limit.
    RATE_LIMIT_PER_MINUTE: '1000000',
    ...over,
  });
}

// ---- fakes

export class FakeLlm implements LlmClient {
  readonly requests: ChatMessage[][] = [];
  constructor(
    private readonly replies: (string | Error | LlmResponse)[] = [],
    private readonly tokens = { in: 1000, out: 300 },
  ) {}
  get calls(): number {
    return this.requests.length;
  }
  /** Forget unused replies and recorded requests: a test starts with an empty script. */
  reset(): void {
    this.replies.length = 0;
    this.requests.length = 0;
  }
  push(...replies: (string | Error | LlmResponse)[]): void {
    this.replies.push(...replies);
  }
  async complete(messages: readonly ChatMessage[]): Promise<LlmResponse> {
    this.requests.push([...messages]);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('FakeLlm: no reply left');
    if (next instanceof Error) throw next;
    if (typeof next !== 'string') return next;
    return {
      content: next,
      model: 'fake-model',
      tokensIn: this.tokens.in,
      tokensOut: this.tokens.out,
      finishReason: 'stop',
    };
  }
}

export class FakeStorage implements Storage {
  signed: { bucket: string; path: string }[] = [];
  puts: { bucket: string; path: string; body: string; contentType: string }[] = [];
  removed: { bucket: string; paths: string[] }[] = [];
  objects = new Map<string, StoredObject[]>();
  failPut = false;

  async createSignedUpload(bucket: string, path: string) {
    this.signed.push({ bucket, path });
    return { signedUrl: `https://storage.test/${bucket}/${path}?token=T`, token: 'T' };
  }
  async put(bucket: string, path: string, body: string | Uint8Array, contentType: string) {
    if (this.failPut) throw new Error('storage down');
    this.puts.push({
      bucket,
      path,
      body: typeof body === 'string' ? body : Buffer.from(body).toString(),
      contentType,
    });
  }
  async remove(bucket: string, paths: readonly string[]) {
    this.removed.push({ bucket, paths: [...paths] });
  }
  async list(bucket: string, prefix: string) {
    return this.objects.get(`${bucket}/${prefix}`) ?? [];
  }
}

// ---- the app under test

export interface TestApp {
  app: FastifyInstance;
  handle: DbHandle;
  config: Config;
  llm: FakeLlm;
  storage: FakeStorage;
  logs: string[];
  fetchCalls: { url: string; init: RequestInit | undefined }[];
  /** Mutable clock. */
  clock: { now: Date };
  /** Replies the fake `fetch` gives, in order (revalidate hook, Turnstile). */
  fetchReplies: (Response | Error)[];
  signed: (
    path: string,
    body?: unknown,
    over?: { ts?: number; secret?: string; raw?: string },
  ) => Promise<LightMyRequestResponse>;
  admin: (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function startTestApp(
  url: string,
  over: {
    config?: Record<string, string>;
    llm?: FakeLlm | null;
    storage?: FakeStorage | null;
  } = {},
): Promise<TestApp> {
  const handle = createDb(url, { max: 5 });
  const config = testConfig(over.config);
  const llm = over.llm === undefined ? new FakeLlm() : (over.llm ?? new FakeLlm());
  const storage =
    over.storage === undefined ? new FakeStorage() : (over.storage ?? new FakeStorage());
  const clock = { now: new Date(FIXED_NOW) };
  const logs: string[] = [];
  const fetchCalls: TestApp['fetchCalls'] = [];
  const fetchReplies: (Response | Error)[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const deps: AppDeps = {
    config,
    handle,
    llm: over.llm === null ? null : (over.rawLlm ?? llm),
    storage: over.storage === null ? null : storage,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      const next = fetchReplies.shift() ?? new Response('{}', { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    now: () => new Date(clock.now),
    logStream,
  };
  const app = await buildApp(deps);
  await app.ready();

  const signed: TestApp['signed'] = async (path, body, o = {}) => {
    const raw = o.raw ?? (body === undefined ? '' : JSON.stringify(body));
    const ts = o.ts ?? Math.floor(clock.now.getTime() / 1000);
    const opts: InjectOptions = {
      method: 'POST',
      url: path,
      headers: {
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(o.secret ?? HMAC_SECRET, ts, Buffer.from(raw)),
        ...(raw === '' ? {} : { 'content-type': 'application/json' }),
      },
      payload: raw,
    };
    return app.inject(opts);
  };
  const admin: TestApp['admin'] = (method, path, body, token = ADMIN_TOKEN) =>
    app.inject({
      method,
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  return {
    app,
    handle,
    config,
    llm,
    storage,
    logs,
    fetchCalls,
    clock,
    fetchReplies,
    signed,
    admin,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/** Empties every table (and restarts nothing else): each test starts from a blank database. */
export async function resetDb(handle: DbHandle): Promise<void> {
  await handle.db.execute(
    dsql`TRUNCATE admin_queue_items, incident_events, incidents, step_results, runs, probe_cycles, compiled_plans, doc_snapshots, submissions, llm_calls, tools RESTART IDENTITY CASCADE`,
  );
}

// ---- data builders

export function targetInput(slug: string, over: Partial<TargetInput> = {}): TargetInput {
  return {
    slug,
    name: `Tool ${slug}`,
    docsUrl: `https://docs.example.com/${slug}`,
    language: 'node',
    level: 2,
    runtime: { image: 'ghcr.io/aditya-tec/qsr-node:22' },
    extract: { root: 'main' },
    placeholders: { YOUR_API_KEY: 'qsr_dummy_key' },
    ...over,
  };
}

export const uuid = (): string => randomUUID();
export type { Target };
