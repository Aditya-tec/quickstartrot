import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AdminQueueResponse, ConfirmBody, FalsePositiveBody } from '@qsr/core';
import type { Ctx } from '../deps.js';
import { confirmIncident, disableTool, markFalsePositive } from '../services/admin-actions.js';
import { loadQueue } from '../services/admin.js';

const Id = z.object({ id: z.uuid() });
const Ok = z.object({ ok: z.literal(true) });

/** /admin/*: behind the bearer-token hook registered by buildApp. */
export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/queue', { schema: { response: { 200: AdminQueueResponse } } }, async () =>
    loadQueue(ctx.db),
  );

  r.post(
    '/admin/incidents/:id/confirm',
    { schema: { params: Id, body: ConfirmBody, response: { 200: Ok } } },
    async (request) => {
      await confirmIncident(ctx, request.params.id, request.body, request.log);
      return { ok: true as const };
    },
  );

  r.post(
    '/admin/incidents/:id/false-positive',
    { schema: { params: Id, body: FalsePositiveBody, response: { 200: Ok } } },
    async (request) => {
      await markFalsePositive(ctx, request.params.id, request.body, request.log);
      return { ok: true as const };
    },
  );

  r.post(
    '/admin/tools/:slug/disable',
    { schema: { params: z.object({ slug: z.string().min(1).max(64) }), response: { 200: Ok } } },
    async (request) => {
      await disableTool(ctx, request.params.slug, request.log);
      return { ok: true as const };
    },
  );
}
