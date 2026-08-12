// ─── Choosing which surface a write goes over ─────────────────────────────────
//
// Two transports exist and they are NOT equivalent:
//
//   oauth    LinkedIn's own w_member_social scope. Sanctioned. Needs a
//            developer app, which needs a company Page.
//   voyager  The private API, with the same cookies the reads use. Breaches
//            §8.2. Needs nothing but a login.
//
// OAuth wins whenever it is available. Voyager is the fallback for the case
// that made it necessary: someone with no company has no Page, and therefore no
// sanctioned way to post to their own feed from their own tools.
//
// docs/DESIGN.md's rule was "never fall back to Voyager SILENTLY", and every
// part of that word is load-bearing here. The choice is reported in the
// envelope, rendered in the confirmation prompt before the human types the
// token, and carries a different risk sentence. What is forbidden is the user
// not knowing which surface their post went over — not the fallback itself.

import type { Session } from '../engine/auth.ts';
import type { OAuthToken } from '../engine/oauth-write.ts';

export type Transport =
  | { kind: 'oauth'; token: OAuthToken }
  | { kind: 'voyager'; session: Session };

export interface TransportInputs {
  token: OAuthToken | null;
  session: Session | null;
  now: number;
}

export type TransportChoice =
  | { ok: true; transport: Transport; note?: string }
  | { ok: false; message: string; hint: string };

const NO_CREDENTIAL_HINT = [
  'Two ways to write, and you need one of them:',
  '',
  '  Sanctioned    lnrelay oauth login --client-id <id>',
  '                Needs a developer app, which needs a LinkedIn Page.',
  '',
  '  Unsanctioned  lnrelay login',
  '                Uses the same cookies as reads. No Page needed. Breaches §8.2',
  '                and puts the account at risk — every write still asks first.',
].join('\n');

/**
 * Pick a transport, preferring the sanctioned one.
 *
 * An EXPIRED OAuth token deliberately does not silently demote to Voyager: the
 * user chose the sanctioned path, and quietly moving them onto the private API
 * because a token aged out is exactly the substitution the design forbids. They
 * are told to re-login instead, and can pass --via voyager if they mean it.
 */
export function chooseTransport(
  inputs: TransportInputs,
  requested?: 'oauth' | 'voyager',
): TransportChoice {
  const { token, session, now } = inputs;
  const tokenLive = token !== null && token.expiresAt > now;

  if (requested === 'oauth') {
    if (tokenLive) return { ok: true, transport: { kind: 'oauth', token: token as OAuthToken } };
    return {
      ok: false,
      message: token === null ? 'no OAuth token stored' : 'the OAuth token has expired',
      hint: 'Run `lnrelay oauth login --client-id <id>`.',
    };
  }

  if (requested === 'voyager') {
    if (session !== null) return { ok: true, transport: { kind: 'voyager', session } };
    return {
      ok: false,
      message: 'no LinkedIn session — a Voyager write needs one',
      hint: 'Run `lnrelay login` to mint one from your own browser.',
    };
  }

  if (tokenLive) return { ok: true, transport: { kind: 'oauth', token: token as OAuthToken } };

  if (token !== null && session !== null) {
    return {
      ok: false,
      message: 'the OAuth token has expired',
      hint:
        'Run `lnrelay oauth login --client-id <id>` to renew it. You do have a browser session, ' +
        'so `--via voyager` would also work — but that is the private API, and swapping you onto ' +
        'it because a token aged out is not a decision this tool will make for you.',
    };
  }

  if (session !== null) {
    return {
      ok: true,
      transport: { kind: 'voyager', session },
      note: 'No OAuth token, so this write goes over the private API. See the prompt.',
    };
  }

  return {
    ok: false,
    message: 'no way to write — no OAuth token and no session',
    hint: NO_CREDENTIAL_HINT,
  };
}
