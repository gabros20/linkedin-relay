// ─── Response classification ──────────────────────────────────────────────────
//
// Every response passes through here BEFORE any parsing. That ordering is the
// point: a parser asked to read a challenge page or a 410 envelope will happily
// return an empty array, and an empty array is indistinguishable from "there
// was nothing". Classification is what keeps those two apart.
//
// Nothing classified here is ever retried automatically. On LinkedIn a 429 is
// the warning shot on a documented escalation ladder, so a `retry-after` is
// information to print for a human — never permission for the process to go
// again. The `retry` field exists so that rule is asserted in tests.

import type { CooldownReason } from './budget.ts';

export interface RawResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface Classification {
  outcome: 'ok' | 'error';
  code?: string;
  message?: string;
  hint?: string;
  /** Which cooldown to open, if any. */
  cooldown?: CooldownReason;
  retryAfterMs?: number;
  retry: boolean;
  /** Parsed body, when it was JSON and we already did the work. */
  json?: unknown;
}

const CHALLENGE_MARKERS = /checkpoint|challenge|captcha|security verification|unusual activity/i;
const LOGIN_REDIRECT = /\/login|\/uas\/login|session_redirect/i;

function fail(code: string, message: string, extra: Partial<Classification> = {}): Classification {
  return { outcome: 'error', code, message, retry: false, ...extra };
}

const CHALLENGE_HINT =
  'Open LinkedIn in a real browser, clear the challenge, then `lnrelay budget --reset-cooldown --confirm`.';

/** Redirects carry two very different meanings; confusing them costs a day. */
function classifyRedirect(location: string): Classification {
  if (CHALLENGE_MARKERS.test(location)) {
    return fail('CHALLENGE_DETECTED', `redirected to a challenge: ${location}`, {
      cooldown: 'CHALLENGE_DETECTED',
      hint: CHALLENGE_HINT,
    });
  }
  if (LOGIN_REDIRECT.test(location)) {
    return fail('AUTH_FAILED', 'redirected to the login page', {
      hint: 'This signature means expired cookies, NOT bot detection. Re-run `lnrelay login`.',
    });
  }
  return fail('FETCH_FAILED', `unexpected redirect to ${location || '(none)'}`);
}

/** A 200 can still be a failure. Everything here inspects the body. */
function classifyBody(body: string): Classification {
  if (CHALLENGE_MARKERS.test(body.slice(0, 4000))) {
    return fail('CHALLENGE_DETECTED', 'a challenge page was returned with status 200', {
      cooldown: 'CHALLENGE_DETECTED',
      hint: CHALLENGE_HINT,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fail('SCHEMA_DRIFT', 'response was 200 but not JSON', {
      hint: 'LinkedIn may have served HTML — inspect the raw body.',
    });
  }

  const envelope = json as { data?: Record<string, unknown>; included?: unknown[] };

  // An inner status can contradict the HTTP one.
  const innerStatus = (envelope.data as { status?: number } | undefined)?.status;
  if (typeof innerStatus === 'number' && innerStatus >= 400) {
    return fail('SCHEMA_DRIFT', `body carries an inner status ${innerStatus}`, {
      hint: 'The endpoint answered but reported a failure. Re-capture the operation.',
    });
  }

  // The 336-analogue: `data` names URNs that `included` does not contain at
  // all. The decoration failed wholesale — this is a failed fetch wearing the
  // costume of an empty result.
  if (referencesUrns(envelope.data) && (envelope.included?.length ?? 0) === 0) {
    return fail('SCHEMA_DRIFT', 'data references entities but included[] is empty', {
      hint: 'Decoration failed wholesale — this is a failed fetch, not an empty result.',
    });
  }

  return { outcome: 'ok', retry: false, json };
}

export function classify(res: RawResponse): Classification {
  const headers = res.headers ?? {};

  if (res.status >= 300 && res.status < 400) {
    return classifyRedirect(headers.location ?? '');
  }

  // ── Hard blocks ────────────────────────────────────────────────────────────
  if (res.status === 999) {
    return fail('REQUEST_DENIED', 'LinkedIn returned HTTP 999 (Request Denied)', {
      cooldown: 'REQUEST_DENIED',
      hint: 'A network-layer bot block that lifts only as traffic normalises. Stop making requests.',
    });
  }

  if (res.status === 429) {
    const retryAfter = Number(headers['retry-after']);
    const out = fail('RATE_LIMITED', 'LinkedIn throttled this request', {
      cooldown: 'RATE_LIMITED',
      hint: 'Not retried automatically — a throttle is the warning shot before a restriction.',
    });
    if (Number.isFinite(retryAfter)) out.retryAfterMs = retryAfter * 1000;
    return out;
  }

  if (res.status === 401 || res.status === 403) {
    return fail('AUTH_FAILED', `LinkedIn rejected the session (${res.status})`, {
      hint: 'Usually expired cookies. Re-run `lnrelay login`.',
    });
  }

  // ── Endpoint drift ─────────────────────────────────────────────────────────
  // 410 is the shape profileView returned on 2026-08-01: the endpoint existed,
  // answered, and told us it is gone.
  if (res.status === 410) {
    return fail('SCHEMA_DRIFT', 'endpoint returned 410 Gone — it no longer exists', {
      hint: 'Re-capture the operation with scripts/observe.ts and update src/engine/contracts.ts.',
    });
  }

  if (res.status === 400) {
    const hint = /queryid/i.test(res.body)
      ? 're-capture the queryId with scripts/observe.ts and update src/engine/contracts.ts'
      : 'check the encoded variables against a live capture';
    return fail('SCHEMA_DRIFT', `LinkedIn rejected the request shape (400)`, { hint });
  }

  if (res.status === 404) {
    return fail('NOT_FOUND', 'no such resource');
  }

  if (res.status !== 200) {
    return fail('FETCH_FAILED', `unexpected status ${res.status}`);
  }

  return classifyBody(res.body);
}

/** Whether `data` names any URN we would expect `included[]` to resolve. */
function referencesUrns(data: Record<string, unknown> | undefined): boolean {
  if (data === undefined) return false;
  let found = false;

  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      // `*`-prefixed keys are Voyager's reference convention.
      if (key.startsWith('*') && Array.isArray(value) && value.length > 0) {
        found = true;
        return;
      }
      if (typeof value === 'string' && value.startsWith('urn:li:')) {
        found = true;
        return;
      }
      walk(value);
    }
  };

  walk(data);
  return found;
}
