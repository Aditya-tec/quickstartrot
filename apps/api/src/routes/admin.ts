import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AdminQueueResponse,
  ConfirmBody,
  FalsePositiveBody,
  L3ShadowReportResponse,
  LaunchExport,
  OptOutBody,
  OptOutResponse,
  PlanImportBody,
  PlanImportResponse,
  ShadowReportResponse,
  StatsResponse,
} from '@qsr/core';
import type { Ctx } from '../deps.js';
import {
  confirmIncident,
  disableTool,
  hideToolHistory,
  markFalsePositive,
  optOutTool,
} from '../services/admin-actions.js';
import { loadQueue } from '../services/admin.js';
import { registerReadyRoute } from './health.js';
import { importPlan } from '../services/plans-import.js';
import { loadLaunchExport } from '../services/launch-export.js';
import { loadL3ShadowReport } from '../services/l3-shadow.js';
import { loadShadowReport } from '../services/shadow.js';
import { loadStats } from '../services/stats.js';

const Id = z.object({ id: z.uuid() });
const Ok = z.object({ ok: z.literal(true) });

/** /admin/*: behind the bearer-token hook registered by buildApp. */
export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  registerReadyRoute(app, ctx); // the database check: GET /admin/ready

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

  // What the shadow export check said (see services/shadow.ts): recorded, never acted on.
  r.get(
    '/admin/shadow',
    {
      schema: {
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
        response: { 200: ShadowReportResponse },
      },
    },
    async (request) => loadShadowReport(ctx, request.query.days),
  );

  // What the L3 step of each shadow-L3 target said (see services/l3-shadow.ts): recorded, never acted on.
  r.get(
    '/admin/l3-shadow',
    {
      schema: {
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
        response: { 200: L3ShadowReportResponse },
      },
    },
    async (request) => loadL3ShadowReport(ctx, request.query.days),
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

  const Slug = z.object({ slug: z.string().min(1).max(64) });
  r.post(
    '/admin/tools/:slug/opt-out',
    { schema: { params: Slug, body: OptOutBody.nullish(), response: { 200: OptOutResponse } } },
    async (request) =>
      optOutTool(ctx, request.params.slug, request.body ?? { hideHistory: false }, request.log),
  );

  r.post(
    '/admin/tools/:slug/hide-history',
    { schema: { params: Slug, response: { 200: OptOutResponse } } },
    async (request) => hideToolHistory(ctx, request.params.slug, request.log),
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
