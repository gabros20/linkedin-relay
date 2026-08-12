// ─── The request driver ───────────────────────────────────────────────────────
//
// The only place in the program that issues a network request, and the only
// place that spends budget. `fetch`, the clock and the sleeper are all injected
// so this whole file is testable without touching the network.
//
// Order of operations is the safety design, and it is deliberate:
//
//   1. cooldown check   — refuse before spending anything, in every process
//   2. permit           — no Permit, no call; unaccounted traffic is impossible
//   3. jittered pace    — never two calls back to back
//   4. fetch
//   5. classify         — before parsing, always
//   6. open a cooldown  — on any throttle/block/challenge signal
//
// Nothing here retries. That is the point.

import { buildHeaders, type Session } from './auth.ts';
import type { Ledger, SpendClass } from './budget.ts';
import { activeCooldown, type Cooldown, MIN_GAP_MS, openCooldown, spend } from './budget.ts';
import { type Classification, classify } from './classify.ts';

export interface ClientDeps {
  fetch: typeof globalThis.fetch;
  /** Human-facing progress, on stderr. Optional so tests stay silent. */
  progress?: (message: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** [0,1). Injected so jitter is deterministic in tests. */
  random: () => number;
  loadLedger: () => Ledger;
  saveLedger: (l: Ledger) => void;
  loadCooldown: () => Cooldown | null;
  saveCooldown: (c: Cooldown | null) => void;
}

export interface RequestSpec {
  url: string;
  spendClass: SpendClass;
  operation: string;
  method?: string;
  /** Serialised as JSON when present. Reads carry none and must stay that way. */
  body?: unknown;
}

export type ClientResult =
  | { ok: true; json: unknown; classification: Classification }
  | { ok: false; code: string; message: string; hint?: string; retryAfterMs?: number };

/** Upper bound of the jittered gap. Lower bound is MIN_GAP_MS. */
const MAX_GAP_MS = 15_000;

export function createClient(session: Session, deps: ClientDeps) {
  async function request(spec: RequestSpec): Promise<ClientResult> {
    const now = deps.now();

    // 1. The breaker, first and in every process. A cooldown lives in a file
    //    precisely so a fresh CLI invocation cannot walk straight back into the
    //    throttle that opened it.
    const cooldown = deps.loadCooldown();
    if (activeCooldown(cooldown, now)) {
      const until =
        cooldown?.until === null
          ? 'indefinitely'
          : `until ${new Date(cooldown?.until ?? 0).toISOString()}`;
      return {
        ok: false,
        code: 'COOLDOWN_ACTIVE',
        message: `refusing to call LinkedIn: ${cooldown?.reason} cooldown is active ${until}`,
        hint:
          cooldown?.clearRequires === 'human'
            ? 'Log in through a real browser, clear the challenge, then `lnrelay budget --reset-cooldown --confirm`.'
            : 'Wait for it to lift, or inspect `lnrelay risk`.',
      };
    }

    // 2. Account for the call BEFORE making it. A denied call spends nothing.
    const ledger = deps.loadLedger();
    const result = spend(ledger, spec.spendClass, now);
    if ('error' in result) {
      return {
        ok: false,
        code: result.error.code,
        message: result.error.message,
        hint: result.error.hint,
      };
    }
    deps.saveLedger(result.ledger);

    // 3. Pace. Reads are paced as conservatively as writes, because the field
    //    evidence shows restrictions triggered by read velocity alone.
    //    That wait is 3-15s and silence during it reads as a hang, so say so.
    const gap = MIN_GAP_MS + Math.floor(deps.random() * (MAX_GAP_MS - MIN_GAP_MS));
    deps.progress?.(`${spec.operation}: pacing ${Math.round(gap / 1000)}s before the request…`);
    await deps.sleep(gap);
    deps.progress?.(`${spec.operation}: requesting…`);

    // 4-5. Fetch, then classify before anyone parses anything.
    const raw = await fetchRaw(spec, session, deps);
    if (raw === null) {
      return { ok: false, code: 'FETCH_FAILED', message: 'the request could not be completed' };
    }
    const classification = classify(raw);

    // 6. A throttle, block or challenge opens the breaker for every process.
    if (classification.cooldown !== undefined) {
      deps.saveCooldown(openCooldown(classification.cooldown, deps.now()));
    }

    if (classification.outcome === 'error') {
      const out: ClientResult = {
        ok: false,
        code: classification.code ?? 'FETCH_FAILED',
        message: classification.message ?? 'request failed',
      };
      if (classification.hint !== undefined) out.hint = classification.hint;
      if (classification.retryAfterMs !== undefined) out.retryAfterMs = classification.retryAfterMs;
      return out;
    }

    return { ok: true, json: classification.json, classification };
  }

  return { request };
}

async function fetchRaw(
  spec: RequestSpec,
  session: Session,
  deps: ClientDeps,
): Promise<{ status: number; body: string; headers: Record<string, string> } | null> {
  // A body is added only when there is one, so the read path keeps sending
  // exactly the six headers that were verified against live traffic.
  const requestHeaders = buildHeaders(session);
  if (spec.body !== undefined) requestHeaders['content-type'] = 'application/json; charset=UTF-8';

  try {
    const res = await deps.fetch(spec.url, {
      method: spec.method ?? 'GET',
      headers: requestHeaders,
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      // Manual, so a login or checkpoint redirect is classified rather than
      // silently followed into an HTML page that parses as "no data".
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, body: await res.text(), headers };
  } catch {
    return null;
  }
}

export type Client = ReturnType<typeof createClient>;
