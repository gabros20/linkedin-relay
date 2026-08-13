// ─── The gate every write passes through ──────────────────────────────────────
//
// Shared by every write command so there is exactly ONE place that decides a
// human approved something. A second copy of this logic would be a second
// policy, agreeing with the first only by luck and diverging on the first edit.
//
// The ordering is the safety design:
//
//   1. account for the spend BEFORE asking, so a refused budget never reaches
//      a prompt the user cannot act on
//   2. ask, and require a token derived from the payload
//   3. commit the spend only after approval — an aborted write costs nothing

import { createInterface } from 'node:readline/promises';
import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { emptyLedger, type Ledger, spend, summarise } from '../engine/budget.ts';
import { err } from '../output.ts';
import type { Envelope } from '../types.ts';
import { type ConfirmDeps, confirmWrite, type WritePlan } from './confirm.ts';

export function ledger(): Ledger {
  const result = loadJson<Ledger>(cachePath('budget.json'));
  return result.state === 'ok' ? result.value : emptyLedger();
}

export function budgetLine(now: number): string {
  const s = summarise(ledger(), 'write', now);
  return `${s.remaining} of ${s.cap} writes left today.`;
}

/** Real terminal I/O. Injected in tests so the gate is exercised without one. */
export function terminalDeps(): ConfirmDeps {
  return {
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(question);
      rl.close();
      return answer;
    },
    write: (s: string) => process.stderr.write(s),
  };
}

/**
 * Account for the comment harvest, which does not go through the client.
 *
 * Charged to `page` rather than `write`: it is a read, just an unusually heavy
 * one at ~2.8 MB. It gets a ledger entry so the traffic is visible in
 * `lnrelay budget` instead of being free and invisible.
 */
export function recordHarvestSpend(now: number): void {
  const attempt = spend(ledger(), 'page', now);
  if ('permit' in attempt) saveJson(cachePath('budget.json'), attempt.ledger);
}

/** Reserve the write against today's budget before a human is ever asked. */
export function reserve(command: string, now: number): Envelope | null {
  const attempt = spend(ledger(), 'write', now);
  return 'error' in attempt
    ? err(command, attempt.error.code, attempt.error.message, attempt.error.hint)
    : null;
}

export type Gated<T> = { confirmed: unknown; payload: T } | Envelope;

export interface GateOpts {
  /**
   * Whether this gate is the thing that accounts for the write.
   *
   * client.ts is documented as "the only place that spends budget", and for
   * any transport that goes through it that is true — so the gate must only
   * ASK, never account, or the same write is billed twice. It was: every
   * Voyager and SDUI write cost two, and the prompt counted 6 → 4 → 2 across
   * three reactions until the daily cap locked the user out of their own tool.
   *
   * Defaults to true because the OAuth transport issues its own fetch and
   * never reaches the client, so there the gate is the only place that can.
   */
  commitSpend?: boolean;
}

/** Ask a human. Makes no network call either way. */
export async function gateWrite<T>(
  command: string,
  plan: WritePlan<T>,
  now: number,
  deps: ConfirmDeps,
  opts: GateOpts = {},
): Promise<Gated<T>> {
  const outcome = await confirmWrite(plan, budgetLine(now), deps);
  if (!outcome.ok) return err(command, outcome.code, outcome.message, outcome.hint);
  // Only after approval is anything committed — an aborted write costs nothing.
  if (opts.commitSpend !== false) {
    const attempt = spend(ledger(), 'write', now);
    if ('permit' in attempt) saveJson(cachePath('budget.json'), attempt.ledger);
  }
  return { confirmed: outcome.confirmed, payload: plan.payload };
}
