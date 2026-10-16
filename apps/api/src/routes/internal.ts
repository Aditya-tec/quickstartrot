import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CompileBody,
  CompileResponse,
  CycleBody,
  CycleResponse,
  FinishResponse,
  GcResponse,
  RunBody,
  RunResponse,
  SyncBody,
  SyncResponse,
  UploadsBody,
  UploadsResponse,
} from '@qsr/core';
import type { Ctx } from '../deps.js';
import { compileForTool } from '../services/compile.js';
import { createCycle } from '../services/cycles.js';
import { syncTargets } from '../services/targets.js';
import { finishCycle } from '../services/finish.js';
import { collectGarbage } from '../services/gc.js';
import { ingestRun } from '../services/runs.js';
import { createUploads } from '../services/uploads.js';

/** Everything under /internal/* plus /admin/gc: all behind the HMAC hook registered by buildApp. */
export function registerInternalRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/internal/targets/sync',
    { schema: { body: SyncBody, response: { 200: SyncResponse } } },
    async (request) => syncTargets(ctx.db, request.body.targets),
  );

  r.post(
    '/internal/cycles',
    { schema: { body: CycleBody, response: { 200: CycleResponse } } },
    async (request) => createCycle(ctx.db, request.body, ctx.deps.now()),
  );

  r.post(
    '/internal/compile',
    {
      bodyLimit: 2 * 1024 * 1024,
      schema: { body: CompileBody, response: { 200: CompileResponse } },
    },
    async (request) => compileForTool(ctx, request.body, request.log),
  );

  r.post(
    '/internal/uploads',
    { schema: { body: UploadsBody, response: { 200: UploadsResponse } } },
    async (request) => createUploads(ctx, request.body, request.log),
  );

  // 5 MB: a RunResult with many steps and 4 KB tails each is big; every other route is capped at 1 MB.
  r.post(
    '/internal/runs',
    { bodyLimit: 5 * 1024 * 1024, schema: { body: RunBody, response: { 200: RunResponse } } },
    async (request) => ingestRun(ctx, request.body),
  );

  r.post(
    '/internal/cycles/:id/finish',
    { schema: { params: z.object({ id: z.uuid() }), response: { 200: FinishResponse } } },
    async (request) => finishCycle(ctx, request.params.id, request.log),
  );

  // Nightly storage retention. HMAC like the other machine-to-machine calls, though it lives under /admin.
  r.post('/admin/gc', { schema: { response: { 200: GcResponse } } }, async (request) =>
    collectGarbage(ctx, request.log),
  );
}
