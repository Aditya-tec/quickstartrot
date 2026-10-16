import type { Problem } from '@qsr/core';

// Errors are returned as RFC 9457 `application/problem+json`: a stable shape, a request id to quote, and
// NEVER a stack trace, a query, a path or a value from the request. Unexpected errors say only that
// something went wrong; the details are in the server log, under the same request id.

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: {
      errors?: { path: string; message: string }[];
      headers?: Record<string, string>;
    } = {},
  ) {
    super(detail ?? title);
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  501: 'Not Implemented',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export const titleFor = (status: number): string => TITLES[status] ?? 'Error';

export function problem(
  status: number,
  requestId: string,
  fields: { title?: string; detail?: string; instance?: string; errors?: Problem['errors'] } = {},
): Problem {
  return {
    type: 'about:blank',
    title: fields.title ?? titleFor(status),
    status,
    ...(fields.detail ? { detail: fields.detail } : {}),
    ...(fields.instance ? { instance: fields.instance } : {}),
    requestId,
    ...(fields.errors ? { errors: fields.errors } : {}),
  };
}
