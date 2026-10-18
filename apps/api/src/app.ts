import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from '@qsr/core';
import { authorizeAdmin, FailureLimiter } from './admin-auth.js';
import type { AppDeps, Ctx } from './deps.js';
import { HttpError, problem, PROBLEM_CONTENT_TYPE, titleFor } from './problem.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerSubmissionRoutes } from './routes/submissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact bytes of the body, for the HMAC check (set on /internal/* only). */
    rawBody: Buffer | null;
  }
}

const MB = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;
/** Sent by the parser when the body is not JSON; reported only AFTER the signature has been checked. */
const INVALID_JSON = Symbol('invalid json');

const ADMIN_FAILURES = 5;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

/** The request line plus every header; credentials are removed by `redact`, not by omission, so a leak is a config bug that a test sees. */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-qsr-signature"]',
  'res.headers["set-cookie"]',
];

const FRAMEWORK_DETAIL: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'The request body is not valid JSON.',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'The request body is empty.',
  FST_ERR_CTP_BODY_TOO_LARGE: 'The request body is too large.',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Unsupported content type.',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'The request body does not match its Content-Length.',
};

const first = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACT, censor: '[Redacted]' },
      serializers: {
        req(req: FastifyRequest) {
          return {
            method: req.method,
            url: req.url,
            host: req.hostname,
            remoteAddress: req.ip,
            headers: req.headers,
          };
        },
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    bodyLimit: 1 * MB,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('rawBody', null);

  const ctx: Ctx = { deps, db: deps.handle.db };

  // ---- security plugins
  await app.register(helmet);
  await app.register(cors, {
    origin: [...config.corsOrigins, ...config.devOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', TIMESTAMP_HEADER, SIGNATURE_HEADER],
    credentials: false,
    maxAge: 600,
  });
  // The routes behind the HMAC check (/internal/* and the two /admin routes the probe calls). A request to one of them that carries a valid
  // signature is the probe's own report and is never rate limited; one that does not is counted against the limiter in the HMAC hook below.
  const hmacRoutes = new Set<string>();
  const routeKey = (method: string, url: string): string => `${method}:${url}`;
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (request) =>
      hmacRoutes.has(routeKey(request.method, request.routeOptions.url ?? '')),
    errorResponseBuilder: (_req, context) =>
      new HttpError(
        429,
        'Too Many Requests',
        `Rate limit exceeded; retry in ${Math.ceil(context.ttl / 1000)} seconds.`,
        {
          headers: { 'retry-after': String(Math.max(1, Math.ceil(context.ttl / 1000))) },
        },
      ),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // ---- errors: always application/problem+json, never a stack trace
  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    let status = 500;
    let detail: string | undefined;
    let errors: { path: string; message: string }[] | undefined;

    if (error instanceof HttpError) {
      status = error.status;
      detail = error.detail;
      errors = error.extra.errors;
      for (const [k, v] of Object.entries(error.extra.headers ?? {})) reply.header(k, v);
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      status = 400;
      detail = 'The request does not match the expected shape.';
      errors = error.validation.map((v) => ({
        path: v.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(body)',
        message: v.message ?? 'invalid',
      }));
    } else if (isResponseSerializationError(error)) {
      status = 500;
    } else if (
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      detail = FRAMEWORK_DETAIL[error.code ?? ''];
    }

    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.info({ status, code: (error as FastifyError).code }, 'request rejected');

    return reply
      .code(status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(
        problem(status, request.id, {
          ...(detail ? { detail } : {}),
          ...(errors ? { errors } : {}),
        }),
      );
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem(404, request.id)),
  );

  // ---- public
  registerHealthRoutes(app, ctx);
  registerSubmissionRoutes(app, ctx);

  // ---- /internal/* and /admin/gc: HMAC over the raw body
  await app.register(async (scope) => {
    scope.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) hmacRoutes.add(routeKey(method, route.url));
    });
    // what an unverified request costs: it counts against the limiter like any anonymous request, so the exemption below cannot be a way in
    // (its own, empty allow-list: it inherits the global one, which would wave these very routes through uncounted)
    const unverifiedLimit = app.createRateLimit({
      max: config.rateLimitPerMinute,
      timeWindow: '1 minute',
      allowList: () => false,
    });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
      const raw = body as Buffer;
      request.rawBody = raw;
      if (raw.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch {
        done(null, INVALID_JSON);
      }
    });
    scope.addHook('preValidation', async (request: FastifyRequest) => {
      const result = verifyRequest({
        secret: config.ingestHmacSecret,
        timestampHeader: first(request.headers[TIMESTAMP_HEADER]),
        signatureHeader: first(request.headers[SIGNATURE_HEADER]),
        rawBody: request.rawBody ?? Buffer.alloc(0),
        nowSeconds: Math.floor(deps.now().getTime() / 1000),
      });
      if (!result.ok) {
        const used = await unverifiedLimit(request);
        if (!used.isAllowed && used.isExceeded)
          throw new HttpError(
            429,
            'Too Many Requests',
            `Rate limit exceeded; retry in ${Math.ceil(used.ttl / 1000)} seconds.`,
            {
              headers: { 'retry-after': String(Math.max(1, Math.ceil(used.ttl / 1000))) },
            },
          );
        request.log.warn({ reason: result.reason }, 'internal request rejected');
        // The reason stays in our log; the caller learns only that the request was not accepted.
        throw new HttpError(401, 'Unauthorized', 'The request signature is missing or invalid.');
      }
      if (request.body === INVALID_JSON)
        throw new HttpError(400, 'Bad Request', 'The request body is not valid JSON.');
    });
    registerInternalRoutes(scope, ctx);
  });

  // ---- /admin/*: bearer token, constant-time compare, strict failure limit
  const limiter = new FailureLimiter({ max: ADMIN_FAILURES, windowMs: ADMIN_WINDOW_MS });
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const verdict = authorizeAdmin({
        header: request.headers.authorization,
        token: config.adminToken,
        limiter,
        key: request.ip,
      });
      if (verdict === 'rate_limited')
        throw new HttpError(
          429,
          'Too Many Requests',
          'Too many failed attempts; try again later.',
          {
            headers: { 'retry-after': String(ADMIN_WINDOW_MS / 1000) },
          },
        );
      if (verdict === 'unauthorized') {
        reply.header('www-authenticate', 'Bearer');
        throw new HttpError(401, 'Unauthorized', 'A valid admin token is required.');
      }
    });
    registerAdminRoutes(scope, ctx);
  });

  return app;
}

export { titleFor };
