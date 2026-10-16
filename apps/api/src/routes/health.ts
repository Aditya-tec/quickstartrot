import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Health } from '@qsr/core';
import type { Ctx } from '../deps.js';
import { HttpError } from '../problem.js';

/** GET /health: liveness plus a database ping. Render's health check and the workflow's wake-up poll use it. */
export function registerHealthRoutes(app: FastifyInstance, ctx: Ctx): void {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/health', { schema: { response: { 200: Health } } }, async () => {
      try {
        await ctx.db.execute(sql`select 1`);
      } catch {
        throw new HttpError(503, 'Service Unavailable', 'The database is unreachable.');
      }
      return { status: 'ok' as const, db: true as const, time: ctx.deps.now().toISOString() };
    });
}
