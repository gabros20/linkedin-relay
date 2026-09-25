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
//   * No --yes, no env var.
//
// APPROVAL MODES (decided 2026-09-25, docs/DECISION-writes.md §9). The owner's
// personal agents must be able to act on "post it" said in chat, and, if the
// owner chooses, to manage the account on their own. So a write is approved by
// whichever of these the OWNER has selected:
//
//   interactive  (default) a human types the token at a terminal — as above
//   agent        `--plan` returns the preview + token without sending; the agent
//                shows it to the owner and, on their word, re-runs with
//                `--confirm <token>`. The token binds the approval to the exact
//                content previewed: edit anything and it no longer matches.
//   unattended   no approval step; budget, cooldown and the audit log still apply
//
// The mode is a file only `lnrelay approval set` writes, and that command needs
// a terminal and a typed token — so an agent cannot promote itself. In agent
// mode the token is a content binding, not an authentication: the agent is
// trusted to relay the owner's word, and the audit log records what it sent.
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

export type ApprovalMode = 'interactive' | 'agent' | 'unattended';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['interactive', 'agent', 'unattended'];

export interface WritePlan<T> {
  action: string;
  payload: T;
  /**
   * What the token is derived from, when the payload holds values that change
   * between runs (a comment's per-render trackingId). Defaults to the payload.
   */
  tokenBasis?: unknown;
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
 *
 * This says nothing about CONSEQUENCE — whether the thing is public, who gets
 * notified, whether it can be undone. That varies by action, not by transport,
 * and each command states it in `reversibility`. Mixing them here produced a
 * delete prompt warning that the deletion was "public under your name".
 */
function riskLines(transport: 'oauth' | 'voyager'): string[] {
  return transport === 'oauth'
    ? [
        "  This write itself is sanctioned — it uses LinkedIn's own",
        '  w_member_social scope. The reads this tool performs are not.',
      ]
    : [
        '  This goes over the PRIVATE API, not a sanctioned one. It breaches',
        '  LinkedIn User Agreement §8.2 and can permanently restrict this account.',
      ];
}

/** The token for a plan: over its stable basis when it names one. */
export function planToken<T>(plan: WritePlan<T>): string {
  return confirmToken(plan.action, plan.tokenBasis ?? plan.payload);
}

/** The plan as lines, without the prompt — shared by the prompt and `--plan`. */
export function previewLines<T>(plan: WritePlan<T>, budgetLine: string): string[] {
  return [
    `ABOUT TO ${plan.action.toUpperCase()} ON LINKEDIN`,
    ...plan.summary,
    `via      ${plan.transport === 'oauth' ? 'official OAuth (w_member_social)' : 'Voyager (private API)'}`,
    `undo     ${plan.reversibility}`,
    ...riskLines(plan.transport).map((l) => l.trim()),
    budgetLine,
  ];
}

export function renderPlan<T>(plan: WritePlan<T>, budgetLine: string): string {
  const token = planToken(plan);
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

export interface ApprovalRequest {
  mode: ApprovalMode;
  /** `--confirm <token>`: the token `--plan` returned. */
  token?: string | undefined;
  /** `--plan`: preview and token only; nothing is sent. */
  planOnly?: boolean | undefined;
}

export interface ConfirmDeps {
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
  write: (s: string) => void;
  /** Absent means interactive with no flags — the pre-2026-09-25 behaviour. */
  approval?: ApprovalRequest;
}

export type ConfirmOutcome<T> =
  | { ok: true; confirmed: ConfirmedWrite<T> }
  | { ok: false; code: 'CONFIRMATION_REQUIRED'; message: string; hint: string }
  | { ok: false; code: 'PLANNED'; token: string; preview: string[] };

/**
 * Whether this invocation could end in an approval (or a plan). Commands that
 * must read before they can ask — comment harvests the post page — check this
 * first, so a request that can only be refused makes no network call.
 */
export function canApprove(deps: ConfirmDeps): boolean {
  const a = deps.approval ?? { mode: 'interactive' };
  if (a.planOnly === true || a.mode === 'unattended') return true;
  if (a.mode === 'agent' && a.token !== undefined) return true;
  return deps.isTty;
}

const refuse = (message: string, hint: string) =>
  ({ ok: false, code: 'CONFIRMATION_REQUIRED', message, hint }) as const;

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
  const a = deps.approval ?? { mode: 'interactive' };
  const token = planToken(plan);
  const mint = (): ConfirmOutcome<T> => ({
    ok: true,
    confirmed: { action: plan.action, payload: plan.payload, token } as ConfirmedWrite<T>,
  });

  if (a.planOnly === true) {
    return { ok: false, code: 'PLANNED', token, preview: previewLines(plan, budgetLine) };
  }

  if (a.token !== undefined) {
    if (a.mode === 'interactive') {
      return refuse(
        `--confirm is not accepted in interactive approval mode; nothing was sent`,
        'In this mode only a human at a terminal approves a write. The owner can allow agents ' +
          'to confirm on their word with `lnrelay approval set agent`, run at a terminal.',
      );
    }
    if (a.token !== token) {
      return refuse(
        'the content changed since it was previewed — the token no longer matches; nothing was sent',
        'Run again with --plan, show the new preview, and confirm with the new token.',
      );
    }
    return mint();
  }

  if (a.mode === 'unattended') return mint();

  if (!deps.isTty) {
    return a.mode === 'agent'
      ? refuse(
          `'${plan.action}' needs the owner's approval of this exact content`,
          'Nothing was sent. Run the same command with --plan, show the preview to the owner, ' +
            'and when they approve re-run it with --confirm <token>.',
        )
      : refuse(
          `'${plan.action}' needs a human to confirm it at an interactive terminal`,
          'No terminal is attached, so nothing was sent and no network call was made. Run this ' +
            'command yourself in a shell. There is no --yes flag; only the owner can change how ' +
            'writes are approved, with `lnrelay approval set`, at a terminal.',
        );
  }

  const answer = (await deps.prompt(renderPlan(plan, budgetLine))).trim();

  if (answer !== token) {
    return refuse(
      'aborted — the confirmation token did not match',
      'Nothing was sent. Re-run and type the token shown in the prompt.',
    );
  }

  return mint();
}
