import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@host:6543/db',
  INGEST_HMAC_SECRET: 'h'.repeat(32),
  ADMIN_TOKEN: 'a'.repeat(32),
  SUBMISSION_IP_SECRET: 's'.repeat(32),
};

describe('loadConfig', () => {
  it('reads the required variables and defaults the rest', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      ingestHmacSecret: base.INGEST_HMAC_SECRET,
      adminToken: base.ADMIN_TOKEN,
      submissionIpSecret: base.SUBMISSION_IP_SECRET,
      port: 3000,
      nodeEnv: 'development',
      groqDailyTokenBudget: 150_000,
      compileTimeoutMs: 100_000,
      rateLimitPerMinute: 120,
      corsOrigins: [],
      groqApiKey: undefined,
      supabaseUrl: undefined,
      revalidateUrl: undefined,
      turnstileSecret: undefined,
    });
  });

  it('parses the optional ones', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'production',
      PORT: '10000',
      GROQ_API_KEY: 'gsk',
      GROQ_DAILY_TOKEN_BUDGET: '90000',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      WEB_ORIGIN: 'https://qsr.vercel.app, https://www.example.com',
      REVALIDATE_URL: 'https://qsr.vercel.app/api/revalidate',
      REVALIDATE_SECRET: 'r'.repeat(16),
      TURNSTILE_SECRET: 't',
      LOG_LEVEL: 'debug',
      COMPILER_MODEL: 'some/model',
    });
    expect(c).toMatchObject({
      nodeEnv: 'production',
      port: 10000,
      groqApiKey: 'gsk',
      groqDailyTokenBudget: 90_000,
      supabaseUrl: 'https://abc.supabase.co',
      supabaseServiceRoleKey: 'srv',
      corsOrigins: ['https://qsr.vercel.app', 'https://www.example.com'],
      revalidateUrl: 'https://qsr.vercel.app/api/revalidate',
      logLevel: 'debug',
      compilerModel: 'some/model',
    });
  });

  it('in production localhost origins are NOT allowed; in development they are', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://a.example' }).corsOrigins,
    ).toEqual(['https://a.example']);
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', WEB_ORIGIN: 'https://a.example' }).devOrigins,
    ).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).devOrigins).toEqual([]);
  });

  it('a missing required variable is reported BY NAME, never by value', () => {
    for (const name of Object.keys(base)) {
      const env = Object.fromEntries(Object.entries(base).filter(([key]) => key !== name));
      try {
        loadConfig(env);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).toContain(name);
        for (const value of Object.values(base)) expect((e as Error).message).not.toContain(value);
      }
    }
  });

  it('secrets must be long enough to be secrets', () => {
    expect(() => loadConfig({ ...base, INGEST_HMAC_SECRET: 'short' })).toThrow(
      /INGEST_HMAC_SECRET/,
    );
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...base, SUBMISSION_IP_SECRET: 'short' })).toThrow(
      /SUBMISSION_IP_SECRET/,
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['GROQ_DAILY_TOKEN_BUDGET', '-1'],
    ['GROQ_DAILY_TOKEN_BUDGET', 'lots'],
    ['NODE_ENV', 'staging'],
    ['SUPABASE_URL', 'not a url'],
    ['REVALIDATE_URL', 'ftp://x'],
    ['WEB_ORIGIN', 'not-an-origin'],
  ])('rejects a bad %s=%s', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
  });

  it('treats empty strings as unset (Render passes blank values for variables left empty)', () => {
    const c = loadConfig({ ...base, GROQ_API_KEY: '', SUPABASE_URL: '', WEB_ORIGIN: '', PORT: '' });
    expect(c.groqApiKey).toBeUndefined();
    expect(c.supabaseUrl).toBeUndefined();
    expect(c.corsOrigins).toEqual([]);
    expect(c.port).toBe(3000);
  });
});
