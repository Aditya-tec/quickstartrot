import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AdminQueueResponse,
  ConfirmBody,
  FalsePositiveBody,
  LaunchExport,
  PlanImportBody,
  PlanImportResponse,
  StatsResponse,
} from '@qsr/core';
import type { Ctx } from '../deps.js';
import { confirmIncident, disableTool, markFalsePositive } from '../services/admin-actions.js';
import { loadQueue } from '../services/admin.js';
import { importPlan } from '../services/plans-import.js';
import { loadLaunchExport } from '../services/launch-export.js';
import { loadStats } from '../services/stats.js';

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

  // The numbers the calibration review reads (see services/stats.ts).
  r.get(
    '/admin/stats',
    {
      schema: {
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
        response: { 200: StatsResponse },
      },
    },
    async (request) => loadStats(ctx, request.query.days),
  );

  // The numbers a launch post needs: confirmed incidents only (see services/launch-export.ts).
  r.get('/admin/export/launch', { schema: { response: { 200: LaunchExport } } }, async () =>
    loadLaunchExport(ctx),
  );

  // A checked plan from a developer machine goes into the cache (see services/plans-import.ts). Extractions can be
  // large pages, so the body limit is higher than the default.
  r.post(
    '/admin/plans/import',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: { body: PlanImportBody, response: { 200: PlanImportResponse } },
    },
    async (request) => importPlan(ctx, request.body, request.log),
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
