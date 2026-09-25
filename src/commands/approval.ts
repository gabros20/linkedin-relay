// ─── How writes are approved, and the record of what was written ─────────────
//
// The mode lives in ~/.lnrelay/config.json and ONLY `lnrelay approval set`
// writes it — at a terminal, behind a typed token. That is the property the
// agent and unattended modes rest on: an agent can use whatever mode the owner
// chose, but cannot choose it. See confirm.ts for what each mode lets through.
//
// Every approval and every outcome is appended to ~/.lnrelay/writes.jsonl, so
// what an agent did under the owner's name can be read back afterwards.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import { APPROVAL_MODES, type ApprovalMode, type ConfirmDeps, confirmToken } from './confirm.ts';

const MEANING: Record<ApprovalMode, string> = {
  interactive: 'every write waits for a human to type a token at a terminal',
  agent:
    'an agent may write after the owner approves the exact content: --plan to preview, ' +
    '--confirm <token> once they say so',
  unattended:
    'agents may write without asking; budget caps, cooldowns and the audit log still apply',
};

const isMode = (v: unknown): v is ApprovalMode =>
  typeof v === 'string' && (APPROVAL_MODES as readonly string[]).includes(v);

/**
 * The owner's chosen mode. Absent means interactive. Anything unreadable is an
 * error — never a guess — because guessing wrong in the permissive direction
 * publishes under someone's name without their approval.
 */
export function loadApprovalMode():
  | { ok: true; mode: ApprovalMode }
  | { ok: false; message: string; hint: string } {
  const loaded = loadJson<{ approval?: unknown }>(cachePath('config.json'));
  if (loaded.state === 'missing') return { ok: true, mode: 'interactive' };
  if (loaded.state === 'corrupt') {
    return {
      ok: false,
      message: 'the approval setting was unreadable and has been quarantined',
      hint: `Moved to ${loaded.quarantinedTo}. Writes fall back to interactive from the next run; set another mode with \`lnrelay approval set\`.`,
    };
  }
  const mode = loaded.value.approval ?? 'interactive';
  if (!isMode(mode)) {
    return {
      ok: false,
      message: `unknown approval mode '${String(mode)}' in config.json`,
      hint: `one of: ${APPROVAL_MODES.join(', ')}. Set it with \`lnrelay approval set <mode>\`.`,
    };
  }
  return { ok: true, mode };
}

/** The token that confirms switching to a mode. Differs per mode. */
export function setToken(mode: ApprovalMode): string {
  return confirmToken('set approval mode', mode);
}

function append(entry: Record<string, unknown>): void {
  const path = cachePath('writes.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
    mode: 0o600,
  });
}

/** Whether this process approved a write — so its outcome belongs in the log. */
let approvedInThisRun = false;
export function wasApproved(): boolean {
  return approvedInThisRun;
}

export function auditApproval(
  command: string,
  mode: ApprovalMode,
  summary: string[],
  token: string,
): void {
  approvedInThisRun = true;
  append({ event: 'approved', command, mode, summary, token });
}

export function auditOutcome(command: string, mode: ApprovalMode, envelope: Envelope): void {
  append(
    envelope.ok
      ? { event: 'outcome', command, mode, ok: true, data: envelope.data }
      : { event: 'outcome', command, mode, ok: false, error: envelope.error },
  );
}

export function runApprovalShow(): Envelope {
  const loaded = loadApprovalMode();
  if (!loaded.ok) return err('approval', 'CACHE_CORRUPT', loaded.message, loaded.hint);
  return ok('approval', {
    mode: loaded.mode,
    meaning: MEANING[loaded.mode],
    audit: cachePath('writes.jsonl'),
  });
}

/** Switch mode. Needs a human at a terminal, like the writes it governs. */
export async function runApprovalSet(
  mode: string | undefined,
  deps: ConfirmDeps,
): Promise<Envelope> {
  if (!isMode(mode)) {
    return err(
      'approval',
      'INVALID_INPUT',
      `unknown approval mode '${mode ?? ''}'`,
      `one of: ${APPROVAL_MODES.map((m) => `${m} (${MEANING[m]})`).join('; ')}`,
    );
  }
  if (!deps.isTty) {
    return err(
      'approval',
      'CONFIRMATION_REQUIRED',
      'the approval mode can only be changed by a human at an interactive terminal',
      'Nothing was changed. An agent cannot choose how its own writes are approved.',
    );
  }

  const token = setToken(mode);
  const answer = (
    await deps.prompt(
      [
        '',
        `  SET LINKEDIN WRITE APPROVAL TO: ${mode.toUpperCase()}`,
        `  ${MEANING[mode]}`,
        '',
        `  Type ${token} to confirm, anything else to abort: `,
      ].join('\n'),
    )
  ).trim();
  if (answer !== token) {
    return err('approval', 'CONFIRMATION_REQUIRED', 'aborted — nothing was changed');
  }

  const current = loadJson<Record<string, unknown>>(cachePath('config.json'));
  saveJson(cachePath('config.json'), {
    ...(current.state === 'ok' ? current.value : {}),
    approval: mode,
  });
  append({ event: 'mode', mode });
  return ok('approval', { mode, meaning: MEANING[mode] });
}
