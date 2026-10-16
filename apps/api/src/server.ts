import { createGroqClient, resolveConfig } from '@qsr/compiler';
import { createDb } from '@qsr/db';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createSupabaseStorage } from './storage.js';

// The process Render runs: `node apps/api/dist/server.js`. Wiring only; everything with logic is in buildApp.

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Names the variables that are wrong, never their values.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Supabase transaction pooler: a small pool and no prepared statements (createDb sets prepare: false).
  const handle = createDb(config.databaseUrl, { max: 5 });
  const llm = config.groqApiKey
    ? createGroqClient({
        apiKey: config.groqApiKey,
        config: resolveConfig(config.compilerModel ? { model: config.compilerModel } : {}),
        // Honour Retry-After once, then give up: the compile endpoint answers `deferred` instead of waiting.
        maxRetries: 1,
      })
    : null;
  const storage =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createSupabaseStorage({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
        })
      : null;

  const app = await buildApp({ config, handle, llm, storage, fetch, now: () => new Date() });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    { port: config.port, llm: llm !== null, storage: storage !== null, nodeEnv: config.nodeEnv },
    'api listening',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
