import { describe, expect, test } from 'bun:test';
import type { Session } from '../src/engine/auth.ts';
import { buildHeaders, checkSession, csrfToken } from '../src/engine/auth.ts';
import { type Cooldown, emptyLedger, type Ledger, openCooldown } from '../src/engine/budget.ts';
import { createClient } from '../src/engine/client.ts';
import { CONTRACTS, contractFor, RETIRED, shippableContracts } from '../src/engine/contracts.ts';

const T0 = 1_800_000_000_000;

const SESSION: Session = {
  liAt: 'a'.repeat(40),
  jsessionId: '"ajax:1234567890"',
  userAgent: 'Mozilla/5.0 Chrome/150.0.0.0',
  capturedAt: '2026-08-01',
};

interface Harness {
  calls: string[];
  ledger: Ledger;
  cooldown: Cooldown | null;
  slept: number[];
}

/**
 * A duck-typed response. The real `Response` constructor rejects any status
 * outside 200-599, so it literally cannot represent LinkedIn's HTTP 999 — the
 * one status we most need to test.
 */
function res(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    text: async () => body,
    headers: {
      forEach: (fn: (v: string, k: string) => void) => {
        for (const [k, v] of Object.entries(headers)) fn(v, k);
      },
    },
  };
}

function harness(
  respond: () => unknown,
  overrides: Partial<{ cooldown: Cooldown | null; ledger: Ledger }> = {},
) {
  const state: Harness = {
    calls: [],
    ledger: overrides.ledger ?? emptyLedger(),
    cooldown: overrides.cooldown ?? null,
    slept: [],
  };
  const client = createClient(SESSION, {
    fetch: (async (url: string) => {
      state.calls.push(String(url));
      return respond();
    }) as unknown as typeof fetch,
    now: () => T0,
    sleep: async (ms: number) => {
      state.slept.push(ms);
    },
    random: () => 0,
    loadLedger: () => state.ledger,
    saveLedger: (l) => {
      state.ledger = l;
    },
    loadCooldown: () => state.cooldown,
    saveCooldown: (c) => {
      state.cooldown = c;
    },
  });
  return { client, state };
}

const okResponse = () =>
  res(200, JSON.stringify({ data: {}, included: [{ entityUrn: 'urn:li:a:1' }] }));

describe('auth', () => {
  test('csrf-token is JSESSIONID with the quotes stripped', () => {
    expect(csrfToken('"ajax:123"')).toBe('ajax:123');
  });

  test('sends exactly the verified minimal header set', () => {
    const headers = buildHeaders(SESSION);
    expect(Object.keys(headers).sort()).toEqual([
      'accept',
      'cookie',
      'csrf-token',
      'user-agent',
      'x-li-lang',
      'x-restli-protocol-version',
    ]);
  });

  // Confirmed unnecessary on live traffic. Sending an unexplained header is as
  // likely to be a fingerprint mismatch as a fix.
  test('does not send the cargo-cult headers', () => {
    const keys = Object.keys(buildHeaders(SESSION)).join(' ');
    for (const h of ['x-li-track', 'x-li-page-instance', 'x-li-deviceId']) {
      expect(keys).not.toContain(h);
    }
  });

  test('checkSession never reveals a credential value', () => {
    const detail = checkSession(SESSION).detail;
    expect(detail).not.toContain(SESSION.liAt);
    expect(detail).toContain('len 40');
  });

  test('JSESSIONID without li_at is not a session — it exists pre-login', () => {
    expect(checkSession({ jsessionId: 'x', userAgent: 'ua' }).ok).toBe(false);
  });
});

describe('contracts', () => {
  test('only verified contracts are shippable', () => {
    for (const c of Object.values(shippableContracts())) {
      expect(c.provenance).toBe('verified');
    }
  });

  // `company` returns 200 but with a projection carrying no name, tagline or
  // description — the same trap as the thin profile projection. It stays
  // unverified, so the command cannot ship, which is the rule working.
  test('a merely discovered contract cannot back a command', () => {
    expect(CONTRACTS.company?.provenance).toBe('discovered');
    expect(contractFor('company')).toBeUndefined();
  });

  test('a contract promoted to verified becomes available', () => {
    expect(CONTRACTS.comments?.provenance).toBe('verified');
    expect(contractFor('comments')).toBeDefined();
  });

  test('every contract records when it was captured', () => {
    for (const c of Object.values(CONTRACTS)) {
      expect(c.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('the dead profileView endpoint is recorded so nobody re-adds it', () => {
    expect(RETIRED.profileView?.note).toContain('410');
  });
});

describe('client ordering', () => {
  test('an active cooldown refuses before any network call', async () => {
    const { client, state } = harness(okResponse, {
      cooldown: openCooldown('RATE_LIMITED', T0),
    });
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('COOLDOWN_ACTIVE');
    expect(state.calls).toHaveLength(0);
  });

  test('a challenge cooldown tells the user only a human can clear it', async () => {
    const { client } = harness(okResponse, { cooldown: openCooldown('CHALLENGE_DETECTED', T0) });
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    if (r.ok) throw new Error('unreachable');
    expect(r.hint).toContain('real browser');
  });

  test('an exhausted budget refuses before any network call', async () => {
    const spent = Array.from({ length: 250 }, (_, i) => T0 - 20_000 - i * 1000);
    const { client, state } = harness(okResponse, { ledger: { spends: { search: spent } } });
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('BUDGET_EXHAUSTED');
    expect(state.calls).toHaveLength(0);
  });

  test('a successful call is recorded in the ledger', async () => {
    const { client, state } = harness(okResponse);
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(state.ledger.spends.profile).toHaveLength(1);
  });

  test('every call is paced, never issued back to back', async () => {
    const { client, state } = harness(okResponse);
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(state.slept[0]).toBeGreaterThanOrEqual(3000);
  });

  test('redirects are not followed — they are classified', async () => {
    let opts: RequestInit | undefined;
    const client = createClient(SESSION, {
      fetch: (async (_u: string, o: RequestInit) => {
        opts = o;
        return okResponse();
      }) as unknown as typeof fetch,
      now: () => T0,
      sleep: async () => {},
      random: () => 0,
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => null,
      saveCooldown: () => {},
    });
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(opts?.redirect).toBe('manual');
  });
});

describe('client opens the breaker on hostile signals', () => {
  test('a 429 opens a cooldown for every future process', async () => {
    const { client, state } = harness(() => res(429, '{}'));
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('RATE_LIMITED');
    expect(state.cooldown?.reason).toBe('RATE_LIMITED');
  });

  test('a 999 opens the longer block cooldown', async () => {
    const { client, state } = harness(() => res(999, 'denied'));
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(state.cooldown?.reason).toBe('REQUEST_DENIED');
  });

  test('a 410 is drift and does NOT open a cooldown — the endpoint moved', async () => {
    const { client, state } = harness(() => res(410, '{"data":{"status":410},"included":[]}'));
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('SCHEMA_DRIFT');
    expect(state.cooldown).toBeNull();
  });

  test('a transport failure never opens a cooldown or crashes', async () => {
    const { client, state } = harness(() => {
      throw new Error('socket hang up');
    });
    const r = await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('FETCH_FAILED');
    expect(state.cooldown).toBeNull();
  });

  // The whole doctrine in one assertion.
  test('a throttle is never retried — exactly one call is made', async () => {
    const { client, state } = harness(() => res(429, '{}'));
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'p' });
    expect(state.calls).toHaveLength(1);
  });
});

// A paced request waits 3-15s. Silence for that long reads as a hang, so the
// client narrates — to STDERR, because stdout carries only the JSON envelope.
describe('progress reporting', () => {
  test('reports pacing and the request itself', async () => {
    const messages: string[] = [];
    const client = createClient(SESSION, {
      fetch: (async () => res(200, '{"data":{},"included":[]}')) as unknown as typeof fetch,
      now: () => T0,
      sleep: async () => {},
      random: () => 0,
      progress: (m) => messages.push(m),
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => null,
      saveCooldown: () => {},
    });
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'feed' });
    expect(messages.some((m) => /pacing/.test(m))).toBe(true);
    expect(messages.some((m) => /requesting/.test(m))).toBe(true);
  });

  test('names the operation, so a multi-call command is followable', async () => {
    const messages: string[] = [];
    const client = createClient(SESSION, {
      fetch: (async () => res(200, '{"data":{},"included":[]}')) as unknown as typeof fetch,
      now: () => T0,
      sleep: async () => {},
      random: () => 0,
      progress: (m) => messages.push(m),
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => null,
      saveCooldown: () => {},
    });
    await client.request({ url: 'https://x/', spendClass: 'search', operation: 'search' });
    expect(messages[0]).toContain('search');
  });

  // A refused call should not narrate a request it never made.
  test('says nothing when the cooldown refuses before any work', async () => {
    const messages: string[] = [];
    const client = createClient(SESSION, {
      fetch: (async () => res(200, '{}')) as unknown as typeof fetch,
      now: () => T0,
      sleep: async () => {},
      random: () => 0,
      progress: (m) => messages.push(m),
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => openCooldown('RATE_LIMITED', T0),
      saveCooldown: () => {},
    });
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'feed' });
    expect(messages).toHaveLength(0);
  });
});

// Writes need a request body, which reads never did. The risk is asymmetric:
// a malformed GET returns nothing, a malformed POST publishes something.
describe('request bodies', () => {
  function recording(status = 200) {
    const seen: RequestInit[] = [];
    const client = createClient(SESSION, {
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return res(status, '{"data":{},"included":[]}');
      }) as unknown as typeof fetch,
      now: () => T0,
      sleep: async () => {},
      random: () => 0,
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => null,
      saveCooldown: () => {},
    });
    return { client, seen };
  }

  test('serialises the body as JSON', async () => {
    const { client, seen } = recording();
    await client.request({
      url: 'https://x/',
      method: 'POST',
      body: { commentaryV2: { text: 'hi' } },
      spendClass: 'write',
      operation: 'share',
    });
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ commentaryV2: { text: 'hi' } });
  });

  test('declares the content type, which Voyager requires on a write', async () => {
    const { client, seen } = recording();
    await client.request({
      url: 'https://x/',
      method: 'POST',
      body: {},
      spendClass: 'write',
      operation: 'share',
    });
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json; charset=UTF-8');
  });

  test('a read still carries no body and no content type', async () => {
    const { client, seen } = recording();
    await client.request({ url: 'https://x/', spendClass: 'profile', operation: 'feed' });
    expect(seen[0]?.body).toBeUndefined();
    const headers = seen[0]?.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toBeUndefined();
  });

  // The auth headers are the same on a write; losing them would 401, but
  // losing them SILENTLY on the write path only is the kind of asymmetry that
  // survives a test suite that only ever exercises reads.
  test('a write still carries the session cookies and csrf token', async () => {
    const { client, seen } = recording();
    await client.request({
      url: 'https://x/',
      method: 'POST',
      body: {},
      spendClass: 'write',
      operation: 'share',
    });
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers.cookie).toContain('li_at=');
    expect(headers['csrf-token']).toBe('ajax:1234567890');
  });
});
