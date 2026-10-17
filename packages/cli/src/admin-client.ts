import { createApiClient, type ApiClient } from './api-client.js';
import { ConfigError } from './commands.js';

/**
 * The client for /admin routes, from the environment: API_BASE_URL and ADMIN_TOKEN. A missing one stops the
 * command (exit 2) and names the variable, never a value.
 */
export function adminClientFromEnv(env: NodeJS.ProcessEnv = process.env): ApiClient {
  const missing = ['API_BASE_URL', 'ADMIN_TOKEN'].filter((k) => !env[k]);
  if (missing.length > 0)
    throw new ConfigError(
      `${missing.join(' and ')} must be set (put them in .env; the admin token is the same value as on Render)`,
    );
  return createApiClient({
    baseUrl: env['API_BASE_URL'] as string,
    bearerToken: env['ADMIN_TOKEN'] as string,
  });
}
