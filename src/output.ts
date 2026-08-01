import type { Envelope, Err, Ok } from './types.ts';

export function ok<T>(command: string, data: T): Ok<T> {
  return { ok: true, command, data };
}

export function err(
  command: string,
  code: string,
  message: string,
  hint?: string,
  status?: number,
  retryAfterMs?: number,
): Err {
  const error: Err['error'] = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (status !== undefined) error.status = status;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return { ok: false, command, error };
}

export function toJson(envelope: unknown): string {
  return JSON.stringify(envelope, null, 2);
}

// ─── Error taxonomy ───────────────────────────────────────────────────────────

export const ERROR_CODES = [
  // Raised before any network call is made.
  'INVALID_INPUT',
  'UNKNOWN_COMMAND',
  'CONFIRMATION_REQUIRED',
  'BUDGET_EXHAUSTED',
  'COOLDOWN_ACTIVE',
  'CACHE_CORRUPT',
  'NOT_IMPLEMENTED',
  // Raised from a response.
  'AUTH_FAILED',
  'RATE_LIMITED',
  'REQUEST_DENIED', // HTTP 999 — LinkedIn's non-standard bot block
  'CHALLENGE_DETECTED',
  'SCHEMA_DRIFT',
  'NOT_FOUND',
  'FETCH_FAILED',
  'FETCH_TIMEOUT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Whether a failure may be retried automatically.
 *
 * Almost everything is `false`, and that is the point. On LinkedIn a 429 is the
 * warning shot on a documented escalation ladder — retrying into it is the
 * mechanism by which a throttle becomes a restriction. A `retryAfterMs` is
 * information to print for a human, never permission for the process to try
 * again. The single exception is a timeout where no response was received at
 * all, which carries no signal about our standing with LinkedIn.
 *
 * This is a deliberate break with x-relay, which retries 429 three times. That
 * is correct on a platform where the worst case is a temporary block.
 */
export function isRetryable(code: ErrorCode | string): boolean {
  return code === 'FETCH_TIMEOUT';
}

/** 0 success · 1 command error · 2 unknown command. */
export function exitCodeFor(envelope: Envelope): number {
  if (envelope.ok) return 0;
  return envelope.error.code === 'UNKNOWN_COMMAND' ? 2 : 1;
}
