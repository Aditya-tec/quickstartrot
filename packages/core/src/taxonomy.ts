import { z } from 'zod';

// Spec section 5: enums shared by the database, API payloads and every service.
export const TOOL_STATUSES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'BROKEN'] as const;
export const ToolStatus = z.enum(TOOL_STATUSES);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const RUN_OUTCOMES = ['PASS', 'FAIL', 'HARNESS_ERROR', 'SKIPPED'] as const;
export const RunOutcome = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const FAILURE_CLASSES = [
  'DOCS_SNIPPET_ERROR',
  'API_DRIFT',
  'DEPENDENCY_RESOLUTION',
  'RUNTIME_VERSION',
  'NEEDS_CREDENTIALS',
  'NETWORK_TRANSIENT',
  'TIMEOUT',
  'COMPILER_ERROR',
  'CRAWL_ERROR',
  'HARNESS_ERROR',
  'UNKNOWN',
] as const;
export const FailureClass = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClass>;

export const INCIDENT_STATES = ['OPEN', 'RESOLVED'] as const;
export const IncidentState = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentState>;

export const REVIEW_STATES = ['PENDING_REVIEW', 'CONFIRMED', 'FALSE_POSITIVE'] as const;
export const ReviewState = z.enum(REVIEW_STATES);
export type ReviewState = z.infer<typeof ReviewState>;

export const LANGUAGES = ['node', 'python'] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;

export const STEP_OUTCOMES = ['PASS', 'FAIL', 'SKIPPED'] as const;
export const StepOutcome = z.enum(STEP_OUTCOMES);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const INCIDENT_EVENT_TYPES = [
  'opened',
  'confirmed',
  'false_positive',
  'recurred',
  'resolved',
  'note',
  'signature_changed',
] as const;
export const IncidentEventType = z.enum(INCIDENT_EVENT_TYPES);
export type IncidentEventType = z.infer<typeof IncidentEventType>;

/** Failure classes the vendor owns: the only ones that can degrade a tool or open an incident. */
export const VENDOR_FAILURE_CLASSES = [
  'DEPENDENCY_RESOLUTION',
  'API_DRIFT',
  'DOCS_SNIPPET_ERROR',
  'RUNTIME_VERSION',
] as const satisfies readonly FailureClass[];

/** Transient classes: retried once inside the cycle, and only 4 in a row open an incident. */
export const TRANSIENT_FAILURE_CLASSES = [
  'NETWORK_TRANSIENT',
  'TIMEOUT',
] as const satisfies readonly FailureClass[];
