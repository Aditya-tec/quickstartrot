import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Health, Ready } from '@qsr/core';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';

/**
 * GET /health: liveness, and nothing else. Render calls it every few seconds and restarts the instance when it does not answer within five
 * seconds, and the workflow's wake-up poll uses it. So it touches no database, storage, model or secret: it must not queue behind the 5
 * connection pool that real work shares (a burst of requests waiting for a connection delayed Render's own probe, twice on 2026-10-18).
 * It writes no log line (the probe calls it all day); it is still behind the rate limiter.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      // 'warn' hides the two request lines Fastify writes at info for every request; an error still logs
      logLevel: 'warn',
      schema: { response: { 200: Health } },
    },
    async () => ({ status: 'ok' as const, time: ctx.deps.now().toISOString() }),
  );
}

/**
 * GET /admin/ready: the database check that /health used to do, behind the admin token (registered with the admin routes, so it is under
 * the bearer hook). For the deploy smoke test and for a person, never for Render.
 */
export function registerReadyRoute(app: FastifyInstance, ctx: Ctx): void {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/admin/ready', { schema: { response: { 200: Ready } } }, async () => {
      try {
        await ctx.db.execute(sql`select 1`);
      } catch {
        throw new HttpError(503, 'Service Unavailable', 'The database is unreachable.');
      }
      return { status: 'ok' as const, db: true as const, time: ctx.deps.now().toISOString() };
    });
}
