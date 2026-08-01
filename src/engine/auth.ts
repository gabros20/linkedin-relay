// ─── Session and headers ──────────────────────────────────────────────────────
//
// Verified live on 2026-08-01: the auth surface is exactly two cookies. `li_at`
// is the session; `JSESSIONID` exists pre-login too, so its presence alone
// means nothing. The `csrf-token` header is JSESSIONID with quotes stripped —
// a derivation, not a second secret.
//
// Everything the research listed as a "cargo-cult candidate" — x-li-track,
// x-li-page-instance, x-li-deviceId, li_rm, bcookie, bscookie — was confirmed
// unnecessary. We do not send them. An unexplained header is as likely to be a
// fingerprint mismatch as a fix.
//
// The User-Agent is stored with the session rather than hardcoded, because a
// stale UA measurably raises the challenge rate; hardcoding is exactly how the
// reference client ended up shipping a Chrome 83 string into 2026.

export interface Session {
  liAt: string;
  jsessionId: string;
  userAgent: string;
  /** ISO date the cookies were minted, so `doctor` can flag staleness. */
  capturedAt: string;
  /** The owner this session is sealed to. A mismatch opens the circuit. */
  ownerUrn?: string;
}

export function csrfToken(jsessionId: string): string {
  return jsessionId.replace(/"/g, '');
}

/** The complete, minimal header set for an authenticated Voyager call. */
export function buildHeaders(session: Session): Record<string, string> {
  return {
    cookie: `li_at=${session.liAt}; JSESSIONID=${session.jsessionId}`,
    'csrf-token': csrfToken(session.jsessionId),
    'x-restli-protocol-version': '2.0.0',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'x-li-lang': 'en_US',
    'user-agent': session.userAgent,
  };
}

export interface SessionCheck {
  ok: boolean;
  detail: string;
}

/**
 * Validate a session's SHAPE without touching the network, and without ever
 * revealing a credential value — lengths only, so `doctor` output is safe to
 * paste into a bug report.
 */
export function checkSession(session: Partial<Session> | null): SessionCheck {
  if (session === null || session.liAt === undefined || session.liAt === '') {
    return { ok: false, detail: 'no li_at — run `lnrelay login`' };
  }
  if (session.jsessionId === undefined || session.jsessionId === '') {
    return { ok: false, detail: 'no JSESSIONID — run `lnrelay login`' };
  }
  if (session.userAgent === undefined || session.userAgent === '') {
    return { ok: false, detail: 'no user-agent recorded with the session' };
  }
  const age = sessionAgeDays(session.capturedAt);
  const staleness =
    age !== undefined && age > 90 ? `; UA is ${age} days old, consider re-login` : '';
  return {
    ok: true,
    detail: `li_at present (len ${session.liAt.length}); JSESSIONID present (len ${session.jsessionId.length})${staleness}`,
  };
}

export function sessionAgeDays(
  capturedAt: string | undefined,
  now = Date.now(),
): number | undefined {
  if (capturedAt === undefined) return undefined;
  const then = Date.parse(capturedAt);
  if (Number.isNaN(then)) return undefined;
  return Math.floor((now - then) / 86_400_000);
}
