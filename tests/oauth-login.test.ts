import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath } from '../src/cache/store.ts';
import {
  type LoginDeps,
  listenForCallback,
  runOauthLogin,
  runOauthLogout,
} from '../src/commands/oauth.ts';
import { loadToken, saveToken } from '../src/commands/token.ts';
import { CALLBACK_PORT } from '../src/engine/oauth.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-oauth-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
  delete process.env.LINKEDIN_CLIENT_ID;
  delete process.env.LINKEDIN_CLIENT_SECRET;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** A run where every network hop succeeds. Individual tests override one part. */
function deps(over: Partial<LoginDeps> = {}): LoginDeps & { opened: string[]; said: string[] } {
  const opened: string[] = [];
  const said: string[] = [];
  return {
    opened,
    said,
    state: () => 'NONCE',
    listen: async () => ({
      ok: true as const,
      code: Promise.resolve({ ok: true as const, code: 'auth-code' }),
      close: () => {},
    }),
    open: (url: string) => {
      opened.push(url);
    },
    write: (s: string) => {
      said.push(s);
    },
    isTty: true,
    prompt: async () => '',
    now: () => T0,
    fetch: (async (url: string) =>
      String(url).includes('userinfo')
        ? jsonResponse(200, { sub: 'MEMBER1' })
        : jsonResponse(200, { access_token: 'SECRET-TOKEN', expires_in: 5_184_000 })) as never,
    ...over,
  };
}

describe('oauth login — arguments', () => {
  test('a missing client id refuses before opening anything', async () => {
    const d = deps();
    const e = await runOauthLogin({ clientSecret: 's' }, d);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('INVALID_INPUT');
    expect(d.opened).toEqual([]);
  });

  test('the refusal explains how to register the app', async () => {
    const e = await runOauthLogin({}, deps());
    if (e.ok) throw new Error('expected failure');
    expect(e.error.hint).toContain('linkedin.com/developers');
  });

  test('credentials may come from the environment instead of argv', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'env-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'env-secret';
    const d = deps();
    const e = await runOauthLogin({}, d);
    expect(e.ok).toBe(true);
    expect(d.opened[0]).toContain('client_id=env-id');
  });

  // argv lands in shell history; a prompt does not.
  test('a missing secret is prompted for at a terminal', async () => {
    let asked = '';
    const d = deps({
      prompt: async (q: string) => {
        asked = q;
        return 'typed-secret';
      },
    });
    const e = await runOauthLogin({ clientId: 'id' }, d);
    expect(e.ok).toBe(true);
    expect(asked.toLowerCase()).toContain('secret');
  });

  test('without a terminal a missing secret fails rather than hanging', async () => {
    const e = await runOauthLogin({ clientId: 'id' }, deps({ isTty: false }));
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('INVALID_INPUT');
  });
});

describe('oauth login — the flow', () => {
  test('stores a token and reports the member it authorises', async () => {
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 's' }, deps());
    if (!e.ok) throw new Error(`expected ok, got ${JSON.stringify(e.error)}`);
    expect((e.data as { memberUrn: string }).memberUrn).toBe('urn:li:person:MEMBER1');
    expect(loadToken()?.accessToken).toBe('SECRET-TOKEN');
  });

  test('the consent URL carries the same state the callback is checked against', async () => {
    let checked = '';
    const d = deps({
      listen: async (state: string) => {
        checked = state;
        return {
          ok: true as const,
          code: Promise.resolve({ ok: true as const, code: 'c' }),
          close: () => {},
        };
      },
    });
    await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    expect(checked).toBe('NONCE');
    expect(d.opened[0]).toContain('state=NONCE');
  });

  // The browser must have somewhere to land before it is sent anywhere.
  test('the listener is up before the browser is opened', async () => {
    const order: string[] = [];
    const d = deps({
      listen: async () => {
        order.push('listen');
        return {
          ok: true as const,
          code: Promise.resolve({ ok: true as const, code: 'c' }),
          close: () => {},
        };
      },
      open: () => order.push('open'),
    });
    await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    expect(order).toEqual(['listen', 'open']);
  });

  test('the URL is also printed, so a headless box can still finish by hand', async () => {
    const d = deps({ open: () => {} });
    await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    expect(d.said.join('')).toContain('https://www.linkedin.com/oauth/v2/authorization');
  });

  test('the listener is closed even when the exchange fails', async () => {
    let closed = false;
    const d = deps({
      listen: async () => ({
        ok: true as const,
        code: Promise.resolve({ ok: true as const, code: 'c' }),
        close: () => {
          closed = true;
        },
      }),
      fetch: (async () => jsonResponse(400, { error: 'bad' })) as never,
    });
    await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    expect(closed).toBe(true);
  });
});

describe('oauth login — failures', () => {
  test('a declined consent is reported, not swallowed', async () => {
    const d = deps({
      listen: async () => ({
        ok: true as const,
        code: Promise.resolve({
          ok: false as const,
          message: 'LinkedIn denied: user_cancelled_login',
        }),
        close: () => {},
      }),
    });
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.message).toContain('user_cancelled_login');
    expect(loadToken()).toBeNull();
  });

  test('a busy callback port is named rather than failing obscurely', async () => {
    const d = deps({
      listen: async () => ({
        ok: false as const,
        message: `port ${CALLBACK_PORT} is already in use`,
      }),
    });
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.message).toContain(String(CALLBACK_PORT));
  });

  // A token we cannot attribute to a member is useless: every write needs the
  // author urn. Storing it would leave a credential on disk that cannot work.
  test('a token whose member cannot be resolved is not stored', async () => {
    const d = deps({
      fetch: (async (url: string) =>
        String(url).includes('userinfo')
          ? jsonResponse(403, {})
          : jsonResponse(200, { access_token: 'tok', expires_in: 1 })) as never,
    });
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    expect(e.ok).toBe(false);
    expect(loadToken()).toBeNull();
  });

  test('an exchange failure keeps the hint that names the two usual causes', async () => {
    const d = deps({
      fetch: (async () => jsonResponse(400, { error: 'invalid_redirect_uri' })) as never,
    });
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 's' }, d);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('AUTH_FAILED');
    expect(e.error.hint).toContain('/callback');
  });
});

// Credentials must not leak into a JSON envelope an agent may log verbatim.
describe('oauth login — secrecy', () => {
  test('neither the access token nor the client secret appears in the output', async () => {
    const d = deps();
    const e = await runOauthLogin({ clientId: 'id', clientSecret: 'CLIENT-SECRET' }, d);
    const printed = JSON.stringify(e) + d.said.join('');
    expect(printed).not.toContain('SECRET-TOKEN');
    expect(printed).not.toContain('CLIENT-SECRET');
  });
});

describe('oauth logout', () => {
  test('removes a stored token', async () => {
    saveToken({ accessToken: 'x', memberUrn: 'urn:li:person:ME', expiresAt: T0 });
    const e = runOauthLogout();
    expect(e.ok).toBe(true);
    expect(existsSync(cachePath('oauth.json'))).toBe(false);
  });

  test('says so plainly when there was nothing to remove', async () => {
    const e = runOauthLogout();
    if (!e.ok) throw new Error('expected ok');
    expect((e.data as { removed: boolean }).removed).toBe(false);
  });
});

// The one part that owns a socket. Exercised for real — a callback server that
// resolves in a mock but not on a port is worth nothing.
describe('the callback listener', () => {
  test('hands back the code the browser arrives with', async () => {
    const l = await listenForCallback('NONCE', 5_000);
    if (!l.ok) throw new Error(l.message);
    const res = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?code=abc&state=NONCE`);
    expect(res.status).toBe(200);
    expect(await l.code).toEqual({ ok: true, code: 'abc' });
    l.close();
  });

  test('the browser is told to go back to the terminal', async () => {
    const l = await listenForCallback('NONCE', 5_000);
    if (!l.ok) throw new Error(l.message);
    const body = await (
      await fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?code=a&state=NONCE`)
    ).text();
    await l.code;
    l.close();
    expect(body.toLowerCase()).toContain('terminal');
  });

  test('a stray request on another path does not end the login', async () => {
    const l = await listenForCallback('NONCE', 800);
    if (!l.ok) throw new Error(l.message);
    await fetch(`http://127.0.0.1:${CALLBACK_PORT}/favicon.ico`);
    const result = await l.code; // falls through to the timeout instead
    l.close();
    if (result.ok) throw new Error('a favicon request must not complete a login');
    expect(result.message).toContain('timed out');
  });

  test('a second listener reports the port is taken rather than throwing', async () => {
    const first = await listenForCallback('NONCE', 5_000);
    if (!first.ok) throw new Error(first.message);
    const second = await listenForCallback('NONCE', 5_000);
    first.close();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.message).toContain(String(CALLBACK_PORT));
  });
});
