import { describe, expect, test } from 'bun:test';
import {
  authorizationUrl,
  exchange,
  fetchMemberUrn,
  parseCallback,
  REDIRECT_URI,
  SCOPES,
} from '../src/engine/oauth.ts';

const T0 = 1_800_000_000_000;

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('authorization URL', () => {
  test('targets LinkedIn and carries the client id', () => {
    const url = new URL(authorizationUrl('client-123', 'nonce'));
    expect(url.origin).toBe('https://www.linkedin.com');
    expect(url.searchParams.get('client_id')).toBe('client-123');
  });

  test('requests the write scope and the two identity scopes', () => {
    const scope = new URL(authorizationUrl('c', 's')).searchParams.get('scope') ?? '';
    expect(scope).toContain('w_member_social');
    expect(scope).toContain('openid');
  });

  // An unused scope is a permission granted for nothing.
  test('does not request email, which the tool has no use for', () => {
    expect(SCOPES).not.toContain('email');
  });

  test('carries the state nonce so the callback can be checked', () => {
    expect(new URL(authorizationUrl('c', 'abc123')).searchParams.get('state')).toBe('abc123');
  });

  test('redirect matches the one the user registers in the app', () => {
    expect(new URL(authorizationUrl('c', 's')).searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });
});

describe('callback parsing', () => {
  test('extracts the code when the state matches', () => {
    const r = parseCallback('/callback?code=abc&state=nonce', 'nonce');
    expect(r).toEqual({ ok: true, code: 'abc' });
  });

  // A callback whose state differs did not originate from this run — a stale
  // tab, or something worse. Either way it must not yield a token.
  test('rejects a state mismatch', () => {
    const r = parseCallback('/callback?code=abc&state=other', 'nonce');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('state mismatch');
  });

  test('surfaces the reason when the user declines consent', () => {
    const r = parseCallback(
      '/callback?error=user_cancelled_login&error_description=declined&state=nonce',
      'nonce',
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('user_cancelled_login');
  });

  test('an error is reported even before the state is compared', () => {
    // LinkedIn may omit state on some error paths; the error is the real news.
    const r = parseCallback('/callback?error=invalid_request', 'nonce');
    expect(r.ok).toBe(false);
  });

  test('a callback with no code fails rather than yielding an empty one', () => {
    expect(parseCallback('/callback?state=nonce', 'nonce').ok).toBe(false);
  });
});

describe('code exchange', () => {
  const config = { clientId: 'id', clientSecret: 'secret' };

  test('returns the token and an absolute expiry', async () => {
    const r = await exchange('code', config, {
      fetch: (async () => jsonResponse(200, { access_token: 'tok', expires_in: 5184000 })) as never,
      now: () => T0,
    });
    expect(r).toEqual({ ok: true, accessToken: 'tok', expiresAt: T0 + 5_184_000_000 });
  });

  test('posts the code as form-encoded, which is what LinkedIn accepts', async () => {
    let init: RequestInit | undefined;
    await exchange('the-code', config, {
      fetch: (async (_u: string, i: RequestInit) => {
        init = i;
        return jsonResponse(200, { access_token: 't', expires_in: 1 });
      }) as never,
      now: () => T0,
    });
    expect(String(init?.body)).toContain('grant_type=authorization_code');
    expect(String(init?.body)).toContain('the-code');
  });

  // The two things that actually go wrong when someone sets this up.
  test('a rejected exchange points at the products and the redirect URL', async () => {
    const r = await exchange('bad', config, {
      fetch: (async () => jsonResponse(400, { error: 'invalid_redirect_uri' })) as never,
      now: () => T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.hint).toContain(REDIRECT_URI);
    expect(r.hint).toContain('products');
  });

  test('a response without a token is a failure, not a token of undefined', async () => {
    const r = await exchange('c', config, {
      fetch: (async () => jsonResponse(200, { token_type: 'Bearer' })) as never,
      now: () => T0,
    });
    expect(r.ok).toBe(false);
  });

  test("a missing expires_in falls back to LinkedIn's documented 60 days", async () => {
    const r = await exchange('c', config, {
      fetch: (async () => jsonResponse(200, { access_token: 'tok' })) as never,
      now: () => T0,
    });
    if (!r.ok) throw new Error('expected success');
    expect(r.expiresAt).toBe(T0 + 60 * 86_400_000);
  });

  test('a network failure is reported rather than thrown', async () => {
    const r = await exchange('c', config, {
      fetch: (async () => {
        throw new Error('socket hang up');
      }) as never,
      now: () => T0,
    });
    expect(r.ok).toBe(false);
  });
});

describe('member urn', () => {
  test('builds a person urn from the OIDC subject claim', async () => {
    const r = await fetchMemberUrn('tok', {
      fetch: (async () => jsonResponse(200, { sub: 'ABC123' })) as never,
    });
    expect(r).toEqual({ ok: true, memberUrn: 'urn:li:person:ABC123' });
  });

  test('sends the token as a bearer credential', async () => {
    let init: RequestInit | undefined;
    await fetchMemberUrn('tok', {
      fetch: (async (_u: string, i: RequestInit) => {
        init = i;
        return jsonResponse(200, { sub: 'X' });
      }) as never,
    });
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer tok');
  });

  test('a 403 names the missing scopes rather than failing opaquely', async () => {
    const r = await fetchMemberUrn('tok', {
      fetch: (async () => jsonResponse(403, {})) as never,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('openid');
  });

  test('a response without a subject claim fails', async () => {
    const r = await fetchMemberUrn('tok', {
      fetch: (async () => jsonResponse(200, { name: 'Someone' })) as never,
    });
    expect(r.ok).toBe(false);
  });
});
