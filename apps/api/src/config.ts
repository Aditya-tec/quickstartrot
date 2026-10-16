import { z } from 'zod';
import { DEFAULT_DAILY_TOKEN_BUDGET } from './budget.js';

// Environment for the API (spec section 4 table; DEPLOY.md lists where each is set). Errors name the
// variable, never its value.

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Render passes blank values for variables left empty in the dashboard: treat them as unset. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);
const origin = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.origin === v && /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}, 'must be an origin like https://example.com (no path, no trailing slash)');

const Env = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  DATABASE_URL: z.string().min(1),
  INGEST_HMAC_SECRET: secret(16),
  ADMIN_TOKEN: secret(16),
  SUBMISSION_IP_SECRET: secret(16),
  GROQ_API_KEY: optional(z.string().min(1)),
  GROQ_DAILY_TOKEN_BUDGET: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).default(DEFAULT_DAILY_TOKEN_BUDGET),
  ),
  COMPILER_MODEL: optional(z.string().min(1)),
  SUPABASE_URL: optional(z.url({ protocol: /^https?$/ })),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(1)),
  WEB_ORIGIN: z.preprocess(
    blankToUndefined,
    z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      )
      .pipe(z.array(origin))
      .default([]),
  ),
  REVALIDATE_URL: optional(z.url({ protocol: /^https?$/ })),
  REVALIDATE_SECRET: optional(secret(16)),
  TURNSTILE_SECRET: optional(z.string().min(1)),
  COMPILE_TIMEOUT_MS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1000).default(100_000),
  ),
  RATE_LIMIT_PER_MINUTE: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).default(120),
  ),
  TRUST_PROXY: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('true')),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  ingestHmacSecret: string;
  adminToken: string;
  submissionIpSecret: string;
  groqApiKey: string | undefined;
  groqDailyTokenBudget: number;
  compilerModel: string | undefined;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  /** The Vercel domain(s) allowed by CORS (WEB_ORIGIN, comma separated). */
  corsOrigins: string[];
  /** Added to the allow-list outside production only. */
  devOrigins: string[];
  revalidateUrl: string | undefined;
  revalidateSecret: string | undefined;
  turnstileSecret: string | undefined;
  compileTimeoutMs: number;
  /** Requests per client per minute, across the whole API. */
  rateLimitPerMinute: number;
  trustProxy: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment: ${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    ingestHmacSecret: e.INGEST_HMAC_SECRET,
    adminToken: e.ADMIN_TOKEN,
    submissionIpSecret: e.SUBMISSION_IP_SECRET,
    groqApiKey: e.GROQ_API_KEY,
    groqDailyTokenBudget: e.GROQ_DAILY_TOKEN_BUDGET,
    compilerModel: e.COMPILER_MODEL,
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    corsOrigins: e.WEB_ORIGIN,
    devOrigins:
      e.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    revalidateUrl: e.REVALIDATE_URL,
    revalidateSecret: e.REVALIDATE_SECRET,
    turnstileSecret: e.TURNSTILE_SECRET,
    compileTimeoutMs: e.COMPILE_TIMEOUT_MS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    trustProxy: e.TRUST_PROXY === 'true',
  };
}
