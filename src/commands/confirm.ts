// ─── The write gate ───────────────────────────────────────────────────────────
//
// `--confirm` is not a human confirmation. In this family the agent IS the
// process invoking the CLI — Claude Code shells out — so a flag is written by
// the acting party about its own action. It documents intent and obtains
// consent from nobody.
//
// So a write stops and asks, at the moment of the write, having first shown
// exactly what it will do and what it risks. The properties that make this a
// real boundary:
//
//   * No TTY, no write. Run non-interactively — which is how an agent invokes
//     the CLI — and it returns CONFIRMATION_REQUIRED having made ZERO network
//     calls. This is the load-bearing one.
//   * A short token derived from the payload, so `yes | lnrelay share …` fails.
//   * Only this module can mint a ConfirmedWrite, so the guarantee lives in the
//     type system rather than in a forgettable `if`.
//   * No --yes, no env var, no config setting.
//
// Stated honestly: a TTY check is an ACCIDENT-PREVENTION barrier, not proof of
// human identity — an agent with terminal control can allocate a pty. Its real
// value is moving circumvention from accidental (append a flag) to deliberate
// (construct a pty and echo a payload-specific token). Overclaiming
// unforgeability is how a guard stops being maintained.

import { createHash } from 'node:crypto';

/** Proof a human saw and approved this exact payload. Unforgeable by construction. */
export interface ConfirmedWrite<T> {
  readonly __brand: unique symbol;
  action: string;
  payload: T;
  token: string;
}

export interface WritePlan<T> {
  action: string;
  payload: T;
  /** Human-readable rendering of exactly what will happen. */
  summary: string[];
  /** Whether the action can be undone, and how. */
  reversibility: string;
  transport: 'oauth' | 'voyager';
}

/**
 * The token a human must type. Derived from the payload, so it changes if the
 * content changes — a token captured from one prompt cannot approve a different
 * write.
 */
export function confirmToken(action: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${action}:${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 4);
}

/**
 * The risk sentence, which differs by transport because the truth differs.
 *
 * An OAuth write really is sanctioned — saying otherwise would be crying wolf,
 * and a warning shown identically on every action stops being read. A Voyager
 * write really does breach §8.2, and the person approving it should be told
 * that at the moment they approve it, not in a README they read once.
 */
function riskLines(transport: 'oauth' | 'voyager'): string[] {
  return transport === 'oauth'
    ? [
        "  This write itself is sanctioned — it uses LinkedIn's own",
        '  w_member_social scope. The reads this tool performs are not.',
      ]
    : [
        '  This goes over the PRIVATE API, not a sanctioned one. It breaches',
        '  LinkedIn User Agreement §8.2 and can permanently restrict this',
        '  account. It is public under your name and cannot be un-seen.',
      ];
}

export function renderPlan<T>(plan: WritePlan<T>, budgetLine: string): string {
  const token = confirmToken(plan.action, plan.payload);
  const lines = [
    '',
    `  ABOUT TO ${plan.action.toUpperCase()} ON LINKEDIN`,
    `  ${'─'.repeat(58)}`,
    ...plan.summary.map((l) => `  ${l}`),
    `  via      ${plan.transport === 'oauth' ? 'official OAuth (w_member_social)' : 'Voyager (private API)'}`,
    `  undo     ${plan.reversibility}`,
    '',
    ...riskLines(plan.transport),
    `  ${budgetLine}`,
    '',
    `  Type ${token} to confirm, anything else to abort: `,
  ];
  return lines.join('\n');
}

export interface ConfirmDeps {
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
  write: (s: string) => void;
}

export type ConfirmOutcome<T> =
  | { ok: true; confirmed: ConfirmedWrite<T> }
  | { ok: false; code: 'CONFIRMATION_REQUIRED'; message: string; hint: string };

/**
 * Ask a human. Returns a ConfirmedWrite only on an exact token match typed at an
 * interactive terminal. Makes no network call either way — the caller cannot
 * reach the write transport without the value this returns.
 */
export async function confirmWrite<T>(
  plan: WritePlan<T>,
  budgetLine: string,
  deps: ConfirmDeps,
): Promise<ConfirmOutcome<T>> {
  if (!deps.isTty) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `'${plan.action}' needs a human to confirm it at an interactive terminal`,
      hint:
        'No terminal is attached, so nothing was sent and no network call was made. Run this ' +
        'command yourself in a shell. There is deliberately no --yes flag: an agent that could ' +
        'set one would not be confirming anything.',
    };
  }

  const token = confirmToken(plan.action, plan.payload);
  const answer = (await deps.prompt(renderPlan(plan, budgetLine))).trim();

  if (answer !== token) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'aborted — the confirmation token did not match',
      hint: 'Nothing was sent. Re-run and type the token shown in the prompt.',
    };
  }

  return {
    ok: true,
    confirmed: { action: plan.action, payload: plan.payload, token } as ConfirmedWrite<T>,
  };
}
