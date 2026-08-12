// ─── Where the OAuth credential lives ─────────────────────────────────────────
//
// Its own module so that the command that OBTAINS a token and the commands that
// SPEND one can share the storage without importing each other.
//
// The file is written 0600 under ~/.lnrelay (see cache/store.ts). That is the
// whole protection: no keychain, no encryption. It is a 60-day bearer token for
// posting as you, so treat the directory accordingly and keep it out of cloud
// sync. `lnrelay oauth logout` removes it.

import { existsSync, rmSync } from 'node:fs';
import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { REDIRECT_URI } from '../engine/oauth.ts';
import type { OAuthToken } from '../engine/oauth-write.ts';

const TOKEN_FILE = 'oauth.json';

export const OAUTH_SETUP = [
  "Writes go over LinkedIn's OWN self-serve scope rather than the private API, which is the one",
  'legitimacy wedge an individual actually has — but the app has to be registered by you; it',
  'cannot be created on your behalf.',
  '',
  '  1. https://www.linkedin.com/developers/apps/new — create an app (any LinkedIn Page works).',
  '  2. Products tab → add "Sign In with LinkedIn using OpenID Connect" AND "Share on LinkedIn".',
  '     Both are self-serve: no partner review, no verification, no screencast.',
  `  3. Auth tab → add redirect URL ${REDIRECT_URI}`,
  '  4. Run: lnrelay oauth login --client-id <id>',
  '     (the secret is prompted for; or set LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET)',
].join('\n');

export function tokenPath(): string {
  return cachePath(TOKEN_FILE);
}

export function loadToken(): OAuthToken | null {
  const result = loadJson<OAuthToken>(tokenPath());
  return result.state === 'ok' ? result.value : null;
}

export function saveToken(token: OAuthToken): void {
  saveJson(tokenPath(), token);
}

/** Returns whether there was anything to remove — silence would be ambiguous. */
export function deleteToken(): boolean {
  const path = tokenPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
