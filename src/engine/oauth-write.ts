// ─── The write transport ──────────────────────────────────────────────────────
//
// Writes go over LinkedIn's OWN self-serve OAuth scope, never Voyager. That is
// the one legitimacy wedge an individual actually has: `w_member_social` is
// self-serve — no partner review, no company verification, no screencast — and
// it covers posting, commenting and reacting as the authenticated member.
//
// Reads have no such path (no self-serve read scope exists at all), which is
// why they accept the Voyager risk. Writes do have one, so they do not get to
// spend the same currency.
//
// The honest caveat, which belongs in the docs and not just here: OAuth makes
// these writes SANCTIONED and materially lower-risk. It does not make the
// surrounding tool ToS-compliant, and scopes and review rules can still change.
//
// A ConfirmedWrite is required to reach any function here. That value can only
// be produced by commands/confirm.ts, at an interactive terminal, so the write
// path is unreachable from a non-interactive agent by construction rather than
// by policy.

import type { ConfirmedWrite } from '../commands/confirm.ts';

const API = 'https://api.linkedin.com';

export interface OAuthToken {
  accessToken: string;
  /** The member urn this token authorises, e.g. urn:li:person:ABC. */
  memberUrn: string;
  expiresAt: number;
}

export interface WriteDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
}

export type WriteResult =
  | { ok: true; id: string; url?: string }
  | { ok: false; code: string; message: string; hint?: string };

function headers(token: OAuthToken): Record<string, string> {
  return {
    authorization: `Bearer ${token.accessToken}`,
    'content-type': 'application/json',
    'x-restli-protocol-version': '2.0.0',
    'linkedin-version': '202601',
  };
}

function expired(token: OAuthToken, now: number): boolean {
  return token.expiresAt <= now;
}

async function send(
  url: string,
  body: unknown,
  token: OAuthToken,
  deps: WriteDeps,
): Promise<WriteResult> {
  if (expired(token, deps.now())) {
    return {
      ok: false,
      code: 'AUTH_FAILED',
      message: 'the OAuth token has expired',
      hint: 'Run `lnrelay oauth` to obtain a fresh token.',
    };
  }

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, code: 'FETCH_FAILED', message: (e as Error).message };
  }

  const text = await res.text();
  if (res.status === 201 || res.status === 200) {
    const id = res.headers.get('x-restli-id') ?? extractId(text);
    return {
      ok: true,
      id: id ?? '(unknown)',
      ...(id === null ? {} : { url: `https://www.linkedin.com/feed/update/${id}/` }),
    };
  }

  // No retries here either. An OAuth 429 is a quota signal, not an invitation.
  if (res.status === 429) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: 'LinkedIn throttled the write',
      hint: 'Not retried automatically. Wait, and check `lnrelay budget`.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      code: 'AUTH_FAILED',
      message: `LinkedIn rejected the token (${res.status})`,
      hint: 'The scope may not be granted. Check the app has "Share on LinkedIn" added.',
    };
  }
  return {
    ok: false,
    code: 'FETCH_FAILED',
    message: `write failed (${res.status})`,
    hint: text.slice(0, 300),
  };
}

function extractId(body: string): string | null {
  return body.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

/** Post to the member's own feed. */
export function share(
  confirmed: ConfirmedWrite<{ text: string; visibility: 'PUBLIC' | 'CONNECTIONS' }>,
  token: OAuthToken,
  deps: WriteDeps,
): Promise<WriteResult> {
  return send(
    `${API}/rest/posts`,
    {
      author: token.memberUrn,
      commentary: confirmed.payload.text,
      visibility: confirmed.payload.visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    },
    token,
    deps,
  );
}

/** Comment on a post as the member. */
export function comment(
  confirmed: ConfirmedWrite<{ postUrn: string; text: string }>,
  token: OAuthToken,
  deps: WriteDeps,
): Promise<WriteResult> {
  const encoded = encodeURIComponent(confirmed.payload.postUrn);
  return send(
    `${API}/rest/socialActions/${encoded}/comments`,
    {
      actor: token.memberUrn,
      object: confirmed.payload.postUrn,
      message: { text: confirmed.payload.text },
    },
    token,
    deps,
  );
}

/** React to a post as the member. */
export function react(
  confirmed: ConfirmedWrite<{ postUrn: string; type: string }>,
  token: OAuthToken,
  deps: WriteDeps,
): Promise<WriteResult> {
  return send(
    `${API}/rest/reactions?actor=${encodeURIComponent(token.memberUrn)}`,
    { root: confirmed.payload.postUrn, reactionType: confirmed.payload.type },
    token,
    deps,
  );
}
