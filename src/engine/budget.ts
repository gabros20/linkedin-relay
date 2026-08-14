// ─── Spend accounting and the circuit breaker ─────────────────────────────────
//
// Two structural safety mechanisms live here, both pure (a clock is always
// injected, never read):
//
//   1. Permits.  `client` cannot be called without a `Permit`, and `spend()` is
//      the only thing that can make one. "Issue a network call without
//      accounting for it" is therefore a compile error rather than a
//      code-review norm. Redirects, pagination continuations and contract
//      discovery all consume permits too — otherwise the traffic easiest to
//      forget is exactly the traffic that escapes accounting.
//
//   2. The cooldown.  A FILE, not process state. A CLI is a swarm of
//      short-lived processes, so an in-memory breaker protects nothing: the
//      next invocation would start clean and hammer straight back into the
//      throttle that opened it.
//
// About the numbers below: the field research swept 364 posts looking for
// corroborated rate ceilings and found essentially none — one secondhand vendor
// figure. So every cap is labelled with where it actually came from, and
// `lnrelay budget` prints that label. None of them is `measured`, because we
// have measured nothing. They are starting knobs, not LinkedIn facts.

import type { CapProvenance } from '../types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export type SpendClass = 'profile' | 'search' | 'page' | 'write' | 'global';

export interface Cap {
  perDay: number;
  provenance: CapProvenance;
  note: string;
}

export const CAPS: Record<SpendClass, Cap> = {
  profile: {
    perDay: 30,
    provenance: 'vendor-lore',
    note: "transplanted from jjuanrivvera/linkedin-cli's job-detail cap",
  },
  search: { perDay: 25, provenance: 'guessed', note: 'no corroborated figure exists' },
  page: { perDay: 60, provenance: 'guessed', note: 'thread/feed pagination' },
  write: {
    // Raised from 10 on 2026-08-14 by the owner's explicit decision, after 10
    // blocked ordinary development on a tool whose writes are the point — a
    // single test round of comment, reply and two deletes exceeded a whole day.
    //
    // Still a GUESS, and still below the weakly-reported ~20/day connection
    // lore. Nothing here has ever been measured against LinkedIn, and the
    // research's strongest finding stands: cadence triggers restrictions more
    // reliably than volume, and this cap does not pace anything — the client's
    // jittered 3-15s gap does. Treat a raised ceiling as more room to be
    // careful in, not permission to burst.
    perDay: 25,
    provenance: 'guessed',
    note: 'raised from 10 for development; still below the ~20/day connection lore per action type',
  },
  global: { perDay: 250, provenance: 'guessed', note: 'all classes combined' },
};

/** Minimum gap between any two calls, before jitter. */
export const MIN_GAP_MS = 3_000;

// ─── Permits ──────────────────────────────────────────────────────────────────

/**
 * Proof that a call was accounted for. The brand is unexported, so `spend()` is
 * the only thing in the program that can produce one.
 */
export interface Permit {
  readonly __brand: unique symbol;
  class: SpendClass;
  issuedAt: number;
}

export interface Ledger {
  /** Epoch-ms timestamps of each spend, keyed by class. */
  spends: Record<string, number[]>;
}

export function emptyLedger(): Ledger {
  return { spends: {} };
}

export interface BudgetError {
  code: 'BUDGET_EXHAUSTED';
  message: string;
  hint: string;
}

export type SpendResult = { permit: Permit; ledger: Ledger } | { error: BudgetError };

function within(times: number[] | undefined, now: number, window: number): number[] {
  if (times === undefined) return [];
  return times.filter((t) => now - t < window);
}

function allSpends(ledger: Ledger, now: number): number[] {
  return Object.values(ledger.spends).flatMap((times) => within(times, now, DAY));
}

/**
 * Account for one intended call. Returns a permit and the updated ledger, or a
 * refusal — and a refusal charges nothing, so a denied call never consumes
 * budget.
 */
export function spend(ledger: Ledger, cls: SpendClass, now: number): SpendResult {
  const recent = allSpends(ledger, now);

  const last = recent.length > 0 ? Math.max(...recent) : undefined;
  if (last !== undefined && now - last < MIN_GAP_MS) {
    return {
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: `minimum gap of ${MIN_GAP_MS}ms between calls not met`,
        hint: 'requests are paced deliberately; wait and retry',
      },
    };
  }

  if (recent.length >= CAPS.global.perDay) {
    return {
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: `global daily cap of ${CAPS.global.perDay} calls reached`,
        hint: 'resets on a rolling 24h window; see `lnrelay budget`',
      },
    };
  }

  const cap = CAPS[cls];
  const forClass = within(ledger.spends[cls], now, DAY);
  if (forClass.length >= cap.perDay) {
    return {
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: `daily cap of ${cap.perDay} reached for '${cls}'`,
        hint: `cap provenance: ${cap.provenance} (${cap.note}). See \`lnrelay budget\`.`,
      },
    };
  }

  return {
    permit: { class: cls, issuedAt: now } as Permit,
    ledger: { spends: { ...ledger.spends, [cls]: [...forClass, now] } },
  };
}

export interface BudgetSummary {
  class: SpendClass;
  spentInWindow: number;
  cap: number;
  remaining: number;
  capProvenance: CapProvenance;
  warning?: string;
}

export function summarise(ledger: Ledger, cls: SpendClass, now: number): BudgetSummary {
  const cap = CAPS[cls];
  const spent =
    cls === 'global' ? allSpends(ledger, now).length : within(ledger.spends[cls], now, DAY).length;
  const remaining = Math.max(0, cap.perDay - spent);

  const summary: BudgetSummary = {
    class: cls,
    spentInWindow: spent,
    cap: cap.perDay,
    remaining,
    capProvenance: cap.provenance,
  };
  if (remaining / cap.perDay < 0.25) {
    summary.warning = `only ${remaining} of ${cap.perDay} '${cls}' calls left in this 24h window — consider stopping`;
  }
  return summary;
}

// ─── The circuit breaker ──────────────────────────────────────────────────────

export type CooldownReason = 'RATE_LIMITED' | 'REQUEST_DENIED' | 'CHALLENGE_DETECTED';

export interface Cooldown {
  reason: CooldownReason;
  since: number;
  /** Epoch-ms when it lifts, or null for indefinite. */
  until: number | null;
  clearRequires: 'time' | 'human';
}

/**
 * Open a cooldown. The durations escalate with how bad the signal is: a 429 is
 * a throttle, a 999 is a network-layer bot block that lifts only as traffic
 * normalises, and a challenge means LinkedIn wants to see a human — so only a
 * human can clear it, via `lnrelay budget --reset-cooldown --confirm`.
 */
export function openCooldown(reason: CooldownReason, now: number): Cooldown {
  if (reason === 'CHALLENGE_DETECTED') {
    return { reason, since: now, until: null, clearRequires: 'human' };
  }
  const duration = reason === 'REQUEST_DENIED' ? 6 * HOUR : HOUR;
  return { reason, since: now, until: now + duration, clearRequires: 'time' };
}

export function activeCooldown(cooldown: Cooldown | null, now: number): boolean {
  if (cooldown === null) return false;
  if (cooldown.until === null) return true;
  return now < cooldown.until;
}
