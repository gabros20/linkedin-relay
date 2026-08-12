// Write command runners. Every one of these stops and asks a human before it
// sends anything, and makes zero network calls on the path where it doesn't.

import { createInterface } from 'node:readline/promises';
import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { emptyLedger, type Ledger, spend, summarise } from '../engine/budget.ts';
import { createLiveClient } from '../engine/index.ts';
import type { OAuthToken } from '../engine/oauth-write.ts';
import {
  comment as sendComment,
  react as sendReact,
  share as sendShare,
} from '../engine/oauth-write.ts';
import { loadSession } from '../engine/session.ts';
import { share as voyagerShare } from '../engine/voyager-write.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import { type ConfirmDeps, confirmWrite, type WritePlan } from './confirm.ts';
import { loadToken, OAUTH_SETUP } from './token.ts';
import { chooseTransport, type Transport } from './transport.ts';

function ledger(): Ledger {
  const result = loadJson<Ledger>(cachePath('budget.json'));
  return result.state === 'ok' ? result.value : emptyLedger();
}

function budgetLine(now: number): string {
  const s = summarise(ledger(), 'write', now);
  return `${s.remaining} of ${s.cap} writes left today.`;
}

/** Real terminal I/O. Injected in tests so the gate is exercised without one. */
function terminalDeps(): ConfirmDeps {
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

interface WriteContext {
  transport: Transport;
  now: number;
  note?: string;
}

/** The urn a write is authored as, for the confirmation summary. */
function authorLine(transport: Transport): string {
  return transport.kind === 'oauth'
    ? `as       ${transport.token.memberUrn}`
    : `as       ${transport.session.ownerUrn ?? 'you (browser session)'}`;
}

function prepare(command: string, now: number, via?: 'oauth' | 'voyager'): WriteContext | Envelope {
  const session = loadSession();
  const choice = chooseTransport(
    { token: loadToken(), session: session.state === 'ok' ? session.session : null, now },
    via,
  );
  if (!choice.ok) {
    return err(command, 'AUTH_FAILED', choice.message, `${choice.hint}\n\n${OAUTH_SETUP}`);
  }
  // Account for the write BEFORE asking, so a refused budget never reaches a
  // prompt the user cannot act on.
  const attempt = spend(ledger(), 'write', now);
  if ('error' in attempt) {
    return err(command, attempt.error.code, attempt.error.message, attempt.error.hint);
  }
  const ctx: WriteContext = { transport: choice.transport, now };
  if (choice.note !== undefined) ctx.note = choice.note;
  return ctx;
}

/**
 * OAuth-only operations. `comment` and `react` exist over Voyager, but the one
 * OSS sample for each contradicts this project's own verified read-side
 * findings on which urn identifies the target (docs/research/W1 §2-3). Shipping
 * a guessed urn contract would fail silently or comment on the wrong post, so
 * they refuse until a real capture settles it.
 */
function oauthToken(ctx: WriteContext): OAuthToken {
  if (ctx.transport.kind !== 'oauth') {
    // Unreachable: requireOauth runs first. Throwing beats a cast that would
    // let a future edit silently send a Voyager write down the OAuth path.
    throw new Error('oauthToken called on a non-oauth transport');
  }
  return ctx.transport.token;
}

function requireOauth(command: string, ctx: WriteContext): Envelope | null {
  if (ctx.transport.kind === 'oauth') return null;
  return err(
    command,
    'NOT_IMPLEMENTED',
    `'${command}' is not implemented over the private API`,
    `Only 'share' is. The one available sample for ${command} disagrees with this tool's own ` +
      "verified read-side finding about which urn identifies the target, and a wrong urn doesn't " +
      'error — it acts on the wrong post. Run `bun run scripts/observe-write.ts`, perform the ' +
      'action by hand once, and the capture settles it. See docs/research/W1-voyager-writes.md.',
  );
}

async function gate<T>(
  command: string,
  plan: WritePlan<T>,
  ctx: WriteContext,
  deps: ConfirmDeps,
): Promise<{ confirmed: Parameters<typeof sendShare>[0] } | Envelope> {
  const outcome = await confirmWrite(plan, budgetLine(ctx.now), deps);
  if (!outcome.ok) return err(command, outcome.code, outcome.message, outcome.hint);
  // Only now is the spend committed — an aborted write costs nothing.
  const attempt = spend(ledger(), 'write', ctx.now);
  if ('permit' in attempt) saveJson(cachePath('budget.json'), attempt.ledger);
  return { confirmed: outcome.confirmed as never };
}

export async function runShare(
  text: string | undefined,
  visibility: string,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  via?: 'oauth' | 'voyager',
): Promise<Envelope> {
  if (text === undefined || text.trim() === '') {
    return err('share', 'INVALID_INPUT', 'text is required', 'lnrelay share "<text>"');
  }
  const vis = visibility === 'connections' ? 'CONNECTIONS' : 'PUBLIC';
  const ctx = prepare('share', now, via);
  if ('ok' in ctx) return ctx;

  const plan: WritePlan<{ text: string; visibility: 'PUBLIC' | 'CONNECTIONS' }> = {
    action: 'post to your feed',
    payload: { text, visibility: vis },
    summary: [authorLine(ctx.transport), `content  "${text}"`, `audience ${vis}`],
    reversibility: 'deletable from the LinkedIn UI; the post may be seen first',
    transport: ctx.transport.kind,
  };

  const gated = await gate('share', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result =
    ctx.transport.kind === 'oauth'
      ? await sendShare(gated.confirmed, ctx.transport.token, {
          fetch: globalThis.fetch,
          now: () => now,
        })
      : await voyagerShare(gated.confirmed, createLiveClient(ctx.transport.session));

  if (!result.ok) return err('share', result.code, result.message, result.hint);
  return ok('share', {
    id: result.id ?? null,
    transport: ctx.transport.kind,
    url: 'url' in result ? result.url : undefined,
    note: 'note' in result ? result.note : ctx.note,
  });
}

export async function runComment(
  postUrn: string | undefined,
  text: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
): Promise<Envelope> {
  if (postUrn === undefined || text === undefined || text.trim() === '') {
    return err(
      'comment',
      'INVALID_INPUT',
      'a post urn and text are required',
      'lnrelay comment <urn> "<text>"',
    );
  }
  const ctx = prepare('comment', now);
  if ('ok' in ctx) return ctx;
  const unsupported = requireOauth('comment', ctx);
  if (unsupported !== null) return unsupported;

  const plan: WritePlan<{ postUrn: string; text: string }> = {
    action: 'comment on a post',
    payload: { postUrn, text },
    summary: [authorLine(ctx.transport), `on       ${postUrn}`, `content  "${text}"`],
    reversibility: 'deletable from the LinkedIn UI; the author is notified immediately',
    transport: 'oauth',
  };

  const gated = await gate('comment', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await sendComment(gated.confirmed as never, oauthToken(ctx), {
    fetch: globalThis.fetch,
    now: () => now,
  });
  return result.ok
    ? ok('comment', { id: result.id })
    : err('comment', result.code, result.message, result.hint);
}

const REACTIONS = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];

export async function runReact(
  postUrn: string | undefined,
  type: string,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
): Promise<Envelope> {
  const reaction = type.toUpperCase();
  if (postUrn === undefined) {
    return err(
      'react',
      'INVALID_INPUT',
      'a post urn is required',
      'lnrelay react <urn> [--type LIKE]',
    );
  }
  if (!REACTIONS.includes(reaction)) {
    return err(
      'react',
      'INVALID_INPUT',
      `unknown reaction '${type}'`,
      `one of: ${REACTIONS.join(', ')}`,
    );
  }
  const ctx = prepare('react', now);
  if ('ok' in ctx) return ctx;
  const unsupported = requireOauth('react', ctx);
  if (unsupported !== null) return unsupported;

  const plan: WritePlan<{ postUrn: string; type: string }> = {
    action: 'react to a post',
    payload: { postUrn, type: reaction },
    summary: [authorLine(ctx.transport), `on       ${postUrn}`, `reaction ${reaction}`],
    reversibility: 'removable from the LinkedIn UI; the author is notified immediately',
    transport: 'oauth',
  };

  const gated = await gate('react', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await sendReact(gated.confirmed as never, oauthToken(ctx), {
    fetch: globalThis.fetch,
    now: () => now,
  });
  return result.ok
    ? ok('react', { id: result.id })
    : err('react', result.code, result.message, result.hint);
}
