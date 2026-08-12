// ─── Obtaining the write credential ───────────────────────────────────────────
//
// The three-legged dance, with the parts that touch the world isolated behind
// `LoginDeps`: a socket on localhost, a browser, a terminal prompt, and fetch.
// The ordering constraint that matters is that the listener must be up BEFORE
// the browser is sent anywhere, or a fast consent lands on a closed port.
//
// This command is CLI-only and always will be. It opens a browser and stores a
// bearer credential; neither belongs on an agent-facing surface.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { CAPS } from '../engine/budget.ts';
import {
  authorizationUrl,
  CALLBACK_PORT,
  exchange,
  fetchMemberUrn,
  parseCallback,
  SCOPES,
} from '../engine/oauth.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import { deleteToken, loadToken, OAUTH_SETUP, saveToken, tokenPath } from './token.ts';

export type CodeResult = { ok: true; code: string } | { ok: false; message: string };

export type Listener =
  | { ok: true; code: Promise<CodeResult>; close: () => void }
  | { ok: false; message: string };

const CALLBACK_TIMEOUT_MS = 300_000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>lnrelay</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>Authorised.</h1><p>You can close this tab and go back to the terminal.</p>`;

/**
 * Listen on the loopback callback port for exactly one consent redirect.
 *
 * Resolves as soon as the socket is bound, so the caller can open the browser
 * knowing there is something to land on; the code arrives later on `.code`.
 */
export function listenForCallback(
  state: string,
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<Listener> {
  return new Promise<Listener>((ready) => {
    let settle: (r: CodeResult) => void = () => {};
    const code = new Promise<CodeResult>((r) => {
      settle = r;
    });

    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      // Browsers ask for /favicon.ico unprompted. Answering that is not consent.
      if (!url.startsWith('/callback')) {
        res.writeHead(404, { connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(DONE_PAGE);
      settle(parseCallback(url, state));
    });

    const timer = setTimeout(() => {
      settle({
        ok: false,
        message: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the LinkedIn callback`,
      });
    }, timeoutMs);
    timer.unref?.();

    const close = (): void => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    };

    server.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const why =
        e.code === 'EADDRINUSE'
          ? `port ${CALLBACK_PORT} is already in use — close whatever holds it and retry`
          : `could not open the callback listener: ${e.message}`;
      ready({ ok: false, message: why });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      ready({ ok: true, code, close });
    });
  });
}

/** Best effort. The URL is always printed too, so a failure here is survivable. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The printed URL is the fallback.
  }
}

export interface LoginDeps {
  state: () => string;
  listen: (state: string) => Promise<Listener>;
  open: (url: string) => void;
  write: (s: string) => void;
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
  now: () => number;
  fetch: typeof globalThis.fetch;
}

export function loginDeps(): LoginDeps {
  return {
    state: () => crypto.randomUUID(),
    listen: (state) => listenForCallback(state),
    open: openBrowser,
    write: (s) => process.stderr.write(s),
    isTty: process.stdin.isTTY === true && process.stderr.isTTY === true,
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(question);
      rl.close();
      return answer;
    },
    now: Date.now,
    fetch: globalThis.fetch,
  };
}

interface Credentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Flag, then environment, then — for the secret only — a prompt. The secret is
 * prompted rather than required as a flag because argv lands in shell history.
 */
async function credentials(
  opts: { clientId?: string; clientSecret?: string },
  deps: LoginDeps,
): Promise<Credentials | Envelope> {
  const clientId = opts.clientId ?? process.env.LINKEDIN_CLIENT_ID;
  if (clientId === undefined || clientId === '') {
    return err('oauth', 'INVALID_INPUT', 'a client id is required', OAUTH_SETUP);
  }

  let clientSecret = opts.clientSecret ?? process.env.LINKEDIN_CLIENT_SECRET;
  if ((clientSecret === undefined || clientSecret === '') && deps.isTty) {
    clientSecret = (await deps.prompt('client secret (not echoed to argv or logs): ')).trim();
  }
  if (clientSecret === undefined || clientSecret === '') {
    return err(
      'oauth',
      'INVALID_INPUT',
      'a client secret is required, and there is no terminal to ask on',
      `Set LINKEDIN_CLIENT_SECRET, or run this at an interactive terminal.\n\n${OAUTH_SETUP}`,
    );
  }
  return { clientId, clientSecret };
}

/** Run the consent flow and store the resulting token. Never prints it. */
export async function runOauthLogin(
  opts: { clientId?: string; clientSecret?: string },
  deps: LoginDeps = loginDeps(),
): Promise<Envelope> {
  const creds = await credentials(opts, deps);
  if ('ok' in creds) return creds;

  const state = deps.state();
  const listener = await deps.listen(state);
  if (!listener.ok) {
    return err('oauth', 'AUTH_FAILED', listener.message);
  }

  try {
    const url = authorizationUrl(creds.clientId, state);
    deps.write(`Opening LinkedIn for consent. If nothing opens, visit:\n\n  ${url}\n\n`);
    deps.open(url);

    const callback = await listener.code;
    if (!callback.ok) return err('oauth', 'AUTH_FAILED', callback.message);

    const token = await exchange(callback.code, creds, { fetch: deps.fetch, now: deps.now });
    if (!token.ok) return err('oauth', 'AUTH_FAILED', token.message, token.hint);

    const member = await fetchMemberUrn(token.accessToken, { fetch: deps.fetch });
    // A token we cannot attribute to a member cannot author anything, so it is
    // not worth storing — every write needs the author urn.
    if (!member.ok) return err('oauth', 'AUTH_FAILED', member.message, OAUTH_SETUP);

    saveToken({
      accessToken: token.accessToken,
      memberUrn: member.memberUrn,
      expiresAt: token.expiresAt,
    });

    return ok('oauth', {
      memberUrn: member.memberUrn,
      scopes: SCOPES,
      expiresAt: new Date(token.expiresAt).toISOString(),
      storedAt: tokenPath(),
      // Refresh tokens are partner-gated, so renewal is re-running this.
      renewal: 'run `lnrelay oauth login` again when it expires',
    });
  } finally {
    listener.close();
  }
}

/** Remove the stored credential. Local only — LinkedIn is never contacted. */
export function runOauthLogout(): Envelope {
  const removed = deleteToken();
  return ok('oauth', {
    removed,
    note: removed
      ? `deleted ${tokenPath()} — the token stays valid on LinkedIn's side until it expires`
      : 'no token was stored',
  });
}

/** Report OAuth setup state. Never prints the token. */
export function runOauthStatus(): Envelope {
  const token = loadToken();
  if (token === null) return err('oauth', 'AUTH_FAILED', 'no OAuth token stored', OAUTH_SETUP);
  return ok('oauth', {
    memberUrn: token.memberUrn,
    expiresAt: new Date(token.expiresAt).toISOString(),
    expired: token.expiresAt <= Date.now(),
    scopes: SCOPES,
    storedAt: tokenPath(),
    writeCap: CAPS.write.perDay,
  });
}
