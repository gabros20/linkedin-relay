// Write command runners. Every one of these stops and asks a human before it
// sends anything, and makes zero network calls on the path where it doesn't.

import { createLiveClient } from '../engine/index.ts';
import type { OAuthToken } from '../engine/oauth-write.ts';
import { comment as sendComment, share as sendShare } from '../engine/oauth-write.ts';
import {
  type Reaction,
  reactionLabel,
  REACTIONS as SDUI_REACTIONS,
  react as sduiReact,
} from '../engine/sdui-write.ts';
import { loadSession } from '../engine/session.ts';
import { share as voyagerShare } from '../engine/voyager-write.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { gateWrite, reserve, terminalDeps } from './gate.ts';
import { loadToken, OAUTH_SETUP } from './token.ts';
import { chooseTransport, type Transport } from './transport.ts';

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
  const refused = reserve(command, now);
  if (refused !== null) return refused;
  const ctx: WriteContext = { transport: choice.transport, now };
  if (choice.note !== undefined) ctx.note = choice.note;
  return ctx;
}

/** OAuth-only operations — currently just `comment`. See requireOauth. */
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
    'Commenting was captured from the live client on 2026-08-13 and is NOT replayable as a ' +
      'single request: com.linkedin.sdui.comments.createComment carries a trackingId from the ' +
      'feed render and an opaque binding key that only exists once a page has been rendered. ' +
      'Reaching it means fetching the SDUI screen first to harvest both. `share`, `delete` and ' +
      '`react` work over the private API. See docs/research/W5-sdui-writes.md.',
  );
}

async function gate<T>(
  command: string,
  plan: WritePlan<T>,
  ctx: WriteContext,
  deps: ConfirmDeps,
): Promise<{ confirmed: Parameters<typeof sendShare>[0] } | Envelope> {
  // Only the OAuth transport issues its own fetch; everything else goes
  // through the client, which does its own accounting.
  const gated = await gateWrite(command, plan, ctx.now, deps, {
    commitSpend: ctx.transport.kind === 'oauth',
  });
  if ('ok' in gated) return gated;
  return { confirmed: gated.confirmed as never };
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
    reversibility:
      'deletable with `lnrelay delete <urn>`, but it is public under your name the moment it ' +
      'lands and anyone who saw it cannot un-see it',
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

const REACTIONS: readonly string[] = SDUI_REACTIONS;

export async function runReact(
  postUrn: string | undefined,
  type: string,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  remove = false,
): Promise<Envelope> {
  const reaction = type.toUpperCase();
  if (postUrn === undefined) {
    return err(
      'react',
      'INVALID_INPUT',
      'a post or comment urn is required',
      'lnrelay react <urn> [--type LIKE] [--remove]',
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
  const ctx = prepare('react', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('react', 'NOT_IMPLEMENTED', 'reacting is only implemented over the private API');
  }

  const plan: WritePlan<{ urn: string; type: Reaction; remove: boolean }> = {
    action: remove ? 'remove a reaction' : 'react to a post',
    payload: { urn: postUrn, type: reaction as Reaction, remove },
    summary: [
      authorLine(ctx.transport),
      `on       ${postUrn}`,
      `reaction ${reaction} — shows as "${reactionLabel(reaction as Reaction)}"${remove ? ' (REMOVING)' : ''}`,
    ],
    reversibility: remove
      ? 'you can react again; the author may have been notified the first time'
      : `removable with \`lnrelay react ${postUrn} --remove --type ${reaction}\` — the type is ` +
        'required, LinkedIn deletes a specific reaction; the author is notified immediately',
    transport: 'voyager',
  };

  const gated = await gate('react', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await sduiReact(gated.confirmed as never, createLiveClient(ctx.transport.session));
  return result.ok
    ? ok('react', { id: result.id, removed: remove })
    : err('react', result.code, result.message, result.hint);
}
