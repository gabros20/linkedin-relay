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

/** Reserve the write against today's budget before a human is ever asked. */
export function reserve(command: string, now: number): Envelope | null {
  const attempt = spend(ledger(), 'write', now);
  return 'error' in attempt
    ? err(command, attempt.error.code, attempt.error.message, attempt.error.hint)
    : null;
}

export type Gated<T> = { confirmed: unknown; payload: T } | Envelope;

/** Ask a human, then commit the spend. Makes no network call either way. */
export async function gateWrite<T>(
  command: string,
  plan: WritePlan<T>,
  now: number,
  deps: ConfirmDeps,
): Promise<Gated<T>> {
  const outcome = await confirmWrite(plan, budgetLine(now), deps);
  if (!outcome.ok) return err(command, outcome.code, outcome.message, outcome.hint);
  // Only now is the spend committed — an aborted write costs nothing.
  const attempt = spend(ledger(), 'write', now);
  if ('permit' in attempt) saveJson(cachePath('budget.json'), attempt.ledger);
  return { confirmed: outcome.confirmed, payload: plan.payload };
}
