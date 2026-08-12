// ─── Three-legged OAuth ───────────────────────────────────────────────────────
//
// The only sanctioned path an individual has. Both products this needs are
// self-serve — no partner review, no company verification, no screencast:
//
//   Sign In with LinkedIn using OpenID Connect  → openid, profile  (member urn)
//   Share on LinkedIn                           → w_member_social  (the writes)
//
// Everything here is pure except `exchange` and `fetchMemberUrn`, which take an
// injected fetch. The local callback server lives in commands/oauth.ts, so this
// module stays testable without opening a socket.

const AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO = 'https://api.linkedin.com/v2/userinfo';

/** Port chosen to be memorable and unlikely to collide with a dev server. */
export const CALLBACK_PORT = 53682;
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

/**
 * `openid` + `profile` identify the member (we need their urn to author
 * anything); `w_member_social` is the write scope. `email` is deliberately NOT
 * requested — the tool has no use for it, and an unused scope is a permission
 * granted for nothing.
 */
export const SCOPES = ['openid', 'profile', 'w_member_social'];

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Build the consent URL. `state` is a CSRF nonce: LinkedIn echoes it back, and
 * a callback carrying a different one did not originate from this run.
 */
export function authorizationUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTHORIZE}?${params.toString()}`;
}

export type ExchangeResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; message: string; hint?: string };

/** Swap the authorization code for an access token. */
export async function exchange(
  code: string,
  config: OAuthConfig,
  deps: { fetch: typeof globalThis.fetch; now: () => number },
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let res: Response;
  try {
    res = await deps.fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, message: `could not reach LinkedIn: ${(e as Error).message}` };
  }

  const text = await res.text();
  if (res.status !== 200) {
    return {
      ok: false,
      message: `LinkedIn rejected the code exchange (${res.status})`,
      // The most common causes, in the order they actually happen.
      hint:
        'Check that the app has BOTH products added, and that its Auth tab lists ' +
        `exactly ${REDIRECT_URI} as an authorized redirect URL. Response: ${text.slice(0, 200)}`,
    };
  }

  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, message: 'token response was not JSON' };
  }

  const accessToken = parsed.access_token;
  const expiresIn = parsed.expires_in;
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, message: 'token response carried no access_token' };
  }

  // LinkedIn access tokens last ~60 days. Refresh tokens are partner-gated, so
  // re-running `oauth login` is the renewal path — recorded rather than hidden.
  const lifetimeMs = typeof expiresIn === 'number' ? expiresIn * 1000 : 60 * 86_400_000;
  return { ok: true, accessToken, expiresAt: deps.now() + lifetimeMs };
}

export type MemberResult = { ok: true; memberUrn: string } | { ok: false; message: string };

/**
 * The member urn to author as. `/v2/userinfo` returns OIDC claims; `sub` is the
 * member id, and `urn:li:person:<sub>` is what the write APIs expect as author.
 */
export async function fetchMemberUrn(
  accessToken: string,
  deps: { fetch: typeof globalThis.fetch },
): Promise<MemberResult> {
  let res: Response;
  try {
    res = await deps.fetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return { ok: false, message: `could not reach userinfo: ${(e as Error).message}` };
  }

  if (res.status !== 200) {
    return {
      ok: false,
      message: `userinfo returned ${res.status} — the 'openid'/'profile' scopes may not be granted`,
    };
  }

  const parsed = (await res.json()) as { sub?: unknown };
  if (typeof parsed.sub !== 'string' || parsed.sub === '') {
    return { ok: false, message: 'userinfo carried no subject claim' };
  }
  return { ok: true, memberUrn: `urn:li:person:${parsed.sub}` };
}

/** Extract `code`/`state`, or the error LinkedIn sent instead. */
export function parseCallback(
  rawUrl: string,
  expectedState: string,
): { ok: true; code: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl, `http://localhost:${CALLBACK_PORT}`);
  } catch {
    return { ok: false, message: 'callback URL was unparseable' };
  }

  const error = url.searchParams.get('error');
  if (error !== null) {
    const description = url.searchParams.get('error_description') ?? '';
    return { ok: false, message: `LinkedIn denied the request: ${error} ${description}`.trim() };
  }

  const state = url.searchParams.get('state');
  if (state !== expectedState) {
    // Either a stale browser tab or something that did not come from this run.
    return { ok: false, message: 'state mismatch — this callback did not come from this login' };
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') return { ok: false, message: 'callback carried no code' };

  return { ok: true, code };
}
