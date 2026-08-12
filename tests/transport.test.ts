import { describe, expect, test } from 'bun:test';
import { chooseTransport } from '../src/commands/transport.ts';
import type { Session } from '../src/engine/auth.ts';
import type { OAuthToken } from '../src/engine/oauth-write.ts';

const T0 = 1_800_000_000_000;

const TOKEN: OAuthToken = {
  accessToken: 'tok',
  memberUrn: 'urn:li:person:ME',
  expiresAt: T0 + 86_400_000,
};
const EXPIRED: OAuthToken = { ...TOKEN, expiresAt: T0 - 1 };
const SESSION: Session = {
  liAt: 'a'.repeat(40),
  jsessionId: '"ajax:1"',
  userAgent: 'Mozilla/5.0',
  capturedAt: '2026-08-01',
};

describe('preferring the sanctioned surface', () => {
  test('a live OAuth token wins even when a session exists', () => {
    const c = chooseTransport({ token: TOKEN, session: SESSION, now: T0 });
    if (!c.ok) throw new Error('expected a transport');
    expect(c.transport.kind).toBe('oauth');
  });

  test('with no token, a session falls back to Voyager', () => {
    const c = chooseTransport({ token: null, session: SESSION, now: T0 });
    if (!c.ok) throw new Error('expected a transport');
    expect(c.transport.kind).toBe('voyager');
  });

  // "Never fall back SILENTLY" — the fallback is allowed, the silence is not.
  test('the Voyager fallback is announced in the result', () => {
    const c = chooseTransport({ token: null, session: SESSION, now: T0 });
    if (!c.ok) throw new Error('expected a transport');
    expect(c.note).toContain('private API');
  });
});

// The substitution that would actually betray the user: they chose the
// sanctioned path, a token quietly aged out, and their next post goes over the
// private API without them ever deciding that.
describe('an expired token never silently demotes', () => {
  test('refuses rather than switching to Voyager behind the user', () => {
    const c = chooseTransport({ token: EXPIRED, session: SESSION, now: T0 });
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error('unreachable');
    expect(c.message).toContain('expired');
  });

  test('the refusal offers renewal first and the private API only explicitly', () => {
    const c = chooseTransport({ token: EXPIRED, session: SESSION, now: T0 });
    if (c.ok) throw new Error('unreachable');
    expect(c.hint).toContain('oauth login');
    expect(c.hint).toContain('--via voyager');
  });

  test('a token expiring one millisecond from now still counts as live', () => {
    const c = chooseTransport(
      { token: { ...TOKEN, expiresAt: T0 + 1 }, session: SESSION, now: T0 },
      undefined,
    );
    if (!c.ok) throw new Error('expected a transport');
    expect(c.transport.kind).toBe('oauth');
  });
});

describe('an explicit request is honoured', () => {
  test('--via voyager uses the session even when a live token exists', () => {
    const c = chooseTransport({ token: TOKEN, session: SESSION, now: T0 }, 'voyager');
    if (!c.ok) throw new Error('expected a transport');
    expect(c.transport.kind).toBe('voyager');
  });

  test('--via voyager without a session fails rather than using OAuth instead', () => {
    const c = chooseTransport({ token: TOKEN, session: null, now: T0 }, 'voyager');
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error('unreachable');
    expect(c.hint).toContain('lnrelay login');
  });

  test('--via oauth without a token fails rather than using Voyager instead', () => {
    const c = chooseTransport({ token: null, session: SESSION, now: T0 }, 'oauth');
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error('unreachable');
    expect(c.hint).toContain('oauth login');
  });
});

describe('no credentials at all', () => {
  test('names both routes rather than only the one the user cannot use', () => {
    const c = chooseTransport({ token: null, session: null, now: T0 });
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error('unreachable');
    expect(c.hint).toContain('oauth login');
    expect(c.hint).toContain('lnrelay login');
  });

  test('the unsanctioned route is labelled as such, not presented as equivalent', () => {
    const c = chooseTransport({ token: null, session: null, now: T0 });
    if (c.ok) throw new Error('unreachable');
    expect(c.hint).toContain('§8.2');
  });
});
