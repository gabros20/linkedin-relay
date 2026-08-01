// The three commands that work today. All are local: they make no network call
// and need no LinkedIn session, so they are useful before the Phase 0 gate has
// even run.

import { existsSync } from 'node:fs';
import { version as nodeVersion } from 'node:process';
import { cacheDir, cachePath, loadJson, saveJson } from '../cache/store.ts';
import {
  activeCooldown,
  CAPS,
  type Cooldown,
  emptyLedger,
  type Ledger,
  type SpendClass,
  summarise,
} from '../engine/budget.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';

const LEDGER_FILE = 'budget.json';
const COOLDOWN_FILE = 'cooldown.json';

interface StateLoad<T> {
  value: T | null;
  corrupt: { path: string; quarantinedTo: string; reason: string } | null;
}

function loadState<T>(file: string, fallback: T): StateLoad<T> {
  const path = cachePath(file);
  const result = loadJson<T>(path);
  if (result.state === 'ok') return { value: result.value, corrupt: null };
  if (result.state === 'missing') return { value: fallback, corrupt: null };
  return {
    value: null,
    corrupt: { path, quarantinedTo: result.quarantinedTo, reason: result.reason },
  };
}

export function loadLedger(): StateLoad<Ledger> {
  return loadState<Ledger>(LEDGER_FILE, emptyLedger());
}

export function loadCooldown(): StateLoad<Cooldown | null> {
  return loadState<Cooldown | null>(COOLDOWN_FILE, null);
}

// ─── risk ─────────────────────────────────────────────────────────────────────

/**
 * The breaker's current state. Exposed over MCP deliberately, so an agent can
 * check standing BEFORE deciding to spend budget on research rather than
 * discovering the lockout one wasted call at a time.
 */
export function runRisk(now: number): Envelope {
  const { value: cooldown, corrupt } = loadCooldown();
  if (corrupt !== null) {
    return err(
      'risk',
      'CACHE_CORRUPT',
      `cooldown state was unreadable and has been quarantined: ${corrupt.reason}`,
      `moved to ${corrupt.quarantinedTo}. Inspect it, then re-run — a fresh cooldown file will be created.`,
    );
  }

  const blocked = activeCooldown(cooldown ?? null, now);
  return ok('risk', {
    state: blocked ? 'blocked' : 'ok',
    cooldown: cooldown ?? null,
    tosNotice:
      'Voyager reads breach LinkedIn User Agreement §8.2. This tool is not ToS-compliant and ' +
      'any account it touches can be restricted or permanently banned.',
  });
}

// ─── budget ───────────────────────────────────────────────────────────────────

export function runBudget(now: number, resetCooldown: boolean, confirmed: boolean): Envelope {
  if (resetCooldown && !confirmed) {
    return err(
      'budget',
      'CONFIRMATION_REQUIRED',
      'clearing a cooldown requires --confirm',
      'A cooldown means LinkedIn signalled a throttle, block or challenge. Log in through a real ' +
        'browser and confirm you are unblocked before clearing it. Re-run with --confirm.',
    );
  }

  if (resetCooldown) {
    saveJson(cachePath(COOLDOWN_FILE), null);
  }

  const { value: ledger, corrupt } = loadLedger();
  if (corrupt !== null) {
    return err(
      'budget',
      'CACHE_CORRUPT',
      `the spend ledger was unreadable and has been quarantined: ${corrupt.reason}`,
      `moved to ${corrupt.quarantinedTo}. A corrupt ledger is NOT treated as an empty one — that ` +
        'would silently restore a full budget. Inspect it, then re-run.',
    );
  }

  const classes: SpendClass[] = ['profile', 'search', 'page', 'write', 'global'];
  const { value: cooldown } = loadCooldown();

  return ok('budget', {
    classes: classes.map((c) => ({
      ...summarise(ledger ?? emptyLedger(), c, now),
      note: CAPS[c].note,
    })),
    cooldown: cooldown ?? null,
    caveat:
      'Every cap is guessed or transplanted vendor lore — the field research found no corroborated ' +
      'LinkedIn rate limits. These are starting knobs, not safe thresholds. They also cannot see ' +
      'your manual browser activity.',
  });
}

// ─── doctor ───────────────────────────────────────────────────────────────────

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Diagnose setup. Always returns ok:true at the envelope level — a diagnostic
 * that fails to report because something is broken is useless. Individual checks
 * carry their own pass/fail. Never prints a credential value.
 */
export function runDoctor(now: number, offline: boolean): Envelope {
  const checks: Check[] = [];

  checks.push({
    name: 'runtime',
    ok: true,
    detail: `node ${nodeVersion}; cache dir ${cacheDir()}${existsSync(cacheDir()) ? '' : ' (not created yet)'}`,
  });

  const { value: cooldown, corrupt: cooldownCorrupt } = loadCooldown();
  if (cooldownCorrupt !== null) {
    checks.push({
      name: 'cooldown',
      ok: false,
      detail: `state file was corrupt; quarantined to ${cooldownCorrupt.quarantinedTo}`,
    });
  } else {
    const blocked = activeCooldown(cooldown ?? null, now);
    checks.push({
      name: 'cooldown',
      ok: !blocked,
      detail: blocked
        ? `BLOCKED — ${cooldown?.reason}, clears by ${cooldown?.clearRequires}${
            cooldown?.until === null
              ? ' (indefinite)'
              : ` at ${new Date(cooldown?.until ?? 0).toISOString()}`
          }`
        : 'clear',
    });
  }

  const { value: ledger, corrupt: ledgerCorrupt } = loadLedger();
  if (ledgerCorrupt !== null) {
    checks.push({
      name: 'budget',
      ok: false,
      detail: `ledger was corrupt; quarantined to ${ledgerCorrupt.quarantinedTo}`,
    });
  } else {
    const g = summarise(ledger ?? emptyLedger(), 'global', now);
    checks.push({
      name: 'budget',
      ok: g.remaining > 0,
      detail: `${g.spentInWindow}/${g.cap} global calls used in the last 24h (cap provenance: ${g.capProvenance})`,
    });
  }

  // Credentials are checked for PRESENCE and LENGTH only — never printed.
  const cookiePath = cachePath('cookies.json');
  checks.push({
    name: 'session',
    ok: false,
    detail: existsSync(cookiePath)
      ? 'a cookie file exists, but the engine is not implemented yet (Phase 2)'
      : 'no session yet — the Phase 0 capture gate has not been run. See docs/PLAN.md.',
  });

  checks.push({
    name: 'engine',
    ok: false,
    detail:
      'not implemented. Phase 0 (three human-paced requests from a residential IP) must pass ' +
      'before engine code is written — see docs/PLAN.md.',
  });

  if (!offline) {
    checks.push({
      name: 'live',
      ok: false,
      detail: 'no live checks available yet; --offline is currently the only meaningful mode',
    });
  }

  return ok('doctor', {
    healthy: checks.every((c) => c.ok),
    phase: 'Phase 1 — local scaffolding. No network capability exists yet, by design.',
    checks,
  });
}
