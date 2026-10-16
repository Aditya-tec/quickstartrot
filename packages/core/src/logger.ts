/**
 * Minimal structured-logger contract (spec section 4: every log line is JSON via pino with runId,
 * toolSlug, stepId where applicable). pino loggers satisfy it, so pure libraries such as the
 * crawler can log without depending on pino.
 */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
