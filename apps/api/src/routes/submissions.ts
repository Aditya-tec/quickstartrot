import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SubmissionBody, SubmissionResponse } from '@qsr/core';
import type { Ctx } from '../deps.js';
import { createSubmission } from '../services/submissions.js';

/** POST /submissions: public, no token. Rate limited per IP hash (5 a day) and, when configured, by Turnstile. */
export function registerSubmissionRoutes(app: FastifyInstance, ctx: Ctx): void {
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/submissions',
      { schema: { body: SubmissionBody, response: { 201: SubmissionResponse } } },
      async (request, reply) => {
        const created = await createSubmission(ctx.db, {
          body: request.body,
          ip: request.ip,
          config: ctx.deps.config,
          now: ctx.deps.now(),
          fetch: ctx.deps.fetch,
        });
        return reply.code(201).send(created);
      },
    );
}
