import { describe, expect, test } from 'bun:test';
import {
  activeCooldown,
  CAPS,
  emptyLedger,
  type Ledger,
  MIN_GAP_MS,
  openCooldown,
  spend,
  summarise,
} from '../src/engine/budget.ts';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000; // fixed clock; never Date.now() in tests

function ledgerWith(entries: Record<string, number[]>): Ledger {
  return { ...emptyLedger(), spends: entries };
}

describe('spend', () => {
  test('issues a permit when under the cap', () => {
    const result = spend(emptyLedger(), 'profile', T0);
    expect('permit' in result).toBe(true);
  });

  test('the permit carries its spend class', () => {
    const result = spend(emptyLedger(), 'profile', T0);
    if (!('permit' in result)) throw new Error('expected a permit');
    expect(result.permit.class).toBe('profile');
  });

  test('records the spend so the next call sees it', () => {
    const first = spend(emptyLedger(), 'profile', T0);
    if (!('permit' in first)) throw new Error('expected a permit');
    expect(first.ledger.spends.profile).toHaveLength(1);
  });

  test('refuses once the daily cap is reached', () => {
    const at = Array.from(
      { length: CAPS.profile.perDay },
      (_, i) => T0 - MIN_GAP_MS - 1 - i * 1000,
    );
    const result = spend(ledgerWith({ profile: at }), 'profile', T0);
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected refusal');
    expect(result.error.code).toBe('BUDGET_EXHAUSTED');
  });

  test('a refusal makes no state change — nothing is charged for a denied call', () => {
    const at = Array.from(
      { length: CAPS.profile.perDay },
      (_, i) => T0 - MIN_GAP_MS - 1 - i * 1000,
    );
    const before = ledgerWith({ profile: at });
    const result = spend(before, 'profile', T0);
    if (!('error' in result)) throw new Error('expected refusal');
    expect(before.spends.profile).toHaveLength(CAPS.profile.perDay);
  });

  test('spends older than the rolling window no longer count', () => {
    const stale = Array.from({ length: CAPS.profile.perDay }, () => T0 - DAY - 1);
    const result = spend(ledgerWith({ profile: stale }), 'profile', T0);
    expect('permit' in result).toBe(true);
  });

  test('classes are independent — exhausting one does not block another', () => {
    const at = Array.from(
      { length: CAPS.profile.perDay },
      (_, i) => T0 - MIN_GAP_MS - 1 - i * 1000,
    );
    const result = spend(ledgerWith({ profile: at }), 'search', T0);
    expect('permit' in result).toBe(true);
  });

  test('the global cap applies across every class', () => {
    const at = Array.from({ length: CAPS.global.perDay }, (_, i) => T0 - MIN_GAP_MS - 1 - i * 1000);
    const result = spend(ledgerWith({ search: at }), 'profile', T0);
    if (!('error' in result)) throw new Error('expected refusal');
    expect(result.error.message).toContain('global');
  });

  test('enforces the minimum gap between consecutive calls', () => {
    const justNow = ledgerWith({ search: [T0 - 500] });
    const result = spend(justNow, 'profile', T0);
    if (!('error' in result)) throw new Error('expected refusal');
    expect(result.error.code).toBe('BUDGET_EXHAUSTED');
    expect(result.error.message).toContain('gap');
  });
});

// Every cap in the design is a guess or transplanted vendor lore, because the
// field research found no corroborated numbers. The provenance is carried in
// the data so `lnrelay budget` can print it and nobody mistakes it for fact.
describe('cap provenance', () => {
  test('every cap declares where its number came from', () => {
    for (const [name, cap] of Object.entries(CAPS)) {
      expect(['guessed', 'vendor-lore', 'measured']).toContain(cap.provenance);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('no cap claims to be measured — we have measured nothing yet', () => {
    for (const cap of Object.values(CAPS)) {
      expect(cap.provenance).not.toBe('measured');
    }
  });
});

describe('summarise', () => {
  test('reports remaining against the cap for a class', () => {
    const s = summarise(ledgerWith({ profile: [T0 - 1000, T0 - 2000] }), 'profile', T0);
    expect(s.spentInWindow).toBe(2);
    expect(s.remaining).toBe(CAPS.profile.perDay - 2);
    expect(s.capProvenance).toBe(CAPS.profile.provenance);
  });

  test('warns once less than a quarter of the budget remains', () => {
    const used = CAPS.profile.perDay - 2;
    const at = Array.from({ length: used }, (_, i) => T0 - MIN_GAP_MS - 1 - i * 1000);
    expect(summarise(ledgerWith({ profile: at }), 'profile', T0).warning).toBeDefined();
  });

  test('stays quiet while the budget is healthy', () => {
    expect(summarise(emptyLedger(), 'profile', T0).warning).toBeUndefined();
  });
});

// The breaker is a FILE, not process state: a CLI is a swarm of short-lived
// processes, so an in-memory circuit breaker protects nothing.
describe('cooldown', () => {
  test('a 429 opens a one-hour cooldown', () => {
    const c = openCooldown('RATE_LIMITED', T0);
    expect(c.until).toBe(T0 + 3_600_000);
  });

  test('a 999 block opens a six-hour cooldown', () => {
    expect(openCooldown('REQUEST_DENIED', T0).until).toBe(T0 + 6 * 3_600_000);
  });

  test('a challenge opens an indefinite cooldown that only a human clears', () => {
    const c = openCooldown('CHALLENGE_DETECTED', T0);
    expect(c.until).toBeNull();
    expect(c.clearRequires).toBe('human');
  });

  test('an active cooldown blocks work', () => {
    expect(activeCooldown(openCooldown('RATE_LIMITED', T0), T0 + 1000)).toBe(true);
  });

  test('an expired cooldown does not', () => {
    expect(activeCooldown(openCooldown('RATE_LIMITED', T0), T0 + 3_600_001)).toBe(false);
  });

  test('an indefinite cooldown never expires on its own', () => {
    const c = openCooldown('CHALLENGE_DETECTED', T0);
    expect(activeCooldown(c, T0 + 365 * DAY)).toBe(true);
  });

  test('no cooldown means no block', () => {
    expect(activeCooldown(null, T0)).toBe(false);
  });
});
