// Write command runners. Every one of these stops and asks a human before it
// sends anything, and makes zero network calls on the path where it doesn't.

import { buildHeaders } from '../engine/auth.ts';
import { createLiveClient } from '../engine/index.ts';
import { share as sendShare } from '../engine/oauth-write.ts';
import { type CommentTokens, comment as sduiComment } from '../engine/sdui-comment.ts';
import { extractCommentTokens } from '../engine/sdui-harvest.ts';
import {
  type CommentRef,
  parseCommentUrn,
  runCommentAction,
  UPDATE_OP,
} from '../engine/sdui-menu.ts';
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
import { gateWrite, recordHarvestSpend, reserve, terminalDeps } from './gate.ts';
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

/** The numeric id inside an activity urn, or null. */
function activityIdOf(urn: string): string | null {
  return /^urn:li:(?:activity|ugcPost|share):(\d+)$/.exec(urn)?.[1] ?? null;
}

/**
 * Fetch the rendered post page and harvest the comment tokens.
 *
 * This is a ~2.8 MB HTML GET, far heavier than any Voyager read here, and it
 * is unavoidable: the trackingId changes on every render, so it cannot be
 * cached even though the binding key can.
 */
async function harvest(
  activityId: string,
  session: Parameters<typeof createLiveClient>[0],
  now: number,
): Promise<{ ok: true; tokens: CommentTokens } | Envelope> {
  // Account for it. This is the heaviest single request the tool makes, and
  // going through raw fetch bypassed the ledger, the cooldown and the pacing —
  // the exact unaccounted traffic the Permit type exists to prevent.
  const spent = reserve('comment', now);
  if (spent !== null) return spent;
  recordHarvestSpend(now);

  const headers = buildHeaders(session);
  let html: string;
  try {
    const res = await fetch(`https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`, {
      headers: {
        cookie: headers.cookie ?? '',
        'user-agent': headers['user-agent'] ?? '',
        accept: 'text/html',
      },
      redirect: 'manual',
    });
    if (res.status !== 200) {
      return err('comment', 'FETCH_FAILED', `the post page returned ${res.status}`);
    }
    html = await res.text();
  } catch (e) {
    return err('comment', 'FETCH_FAILED', `could not load the post page: ${(e as Error).message}`);
  }

  const found = extractCommentTokens(html, activityId);
  if (!found.ok) return err('comment', 'SCHEMA_DRIFT', found.message, found.hint);
  return { ok: true, tokens: { bindingKey: found.bindingKey, trackingId: found.trackingId } };
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
  // The urn decides the operation: a post urn creates a comment, a comment urn
  // edits that comment. No flag to remember, and no way to mean one and get the
  // other — the two urn shapes are disjoint.
  const editing = parseCommentUrn(postUrn);
  const activityId = editing?.activityId ?? activityIdOf(postUrn);
  if (activityId === null) {
    return err(
      'comment',
      'INVALID_INPUT',
      `'${postUrn}' identifies neither a post nor a comment`,
      'Pass urn:li:activity:<id> to comment, or a comment urn to edit that comment.',
    );
  }

  // The TTY check comes BEFORE the harvest, not just before the send. Harvesting
  // is a network call, and this tool's guarantee is "no TTY, no write AND no
  // network call on that path" — an agent shelling out non-interactively must
  // not cause LinkedIn traffic it cannot then use.
  if (!deps.isTty) {
    return err(
      'comment',
      'CONFIRMATION_REQUIRED',
      'commenting needs a human to confirm it at an interactive terminal',
      'No terminal is attached, so nothing was sent and no network call was made.',
    );
  }

  const ctx = prepare('comment', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('comment', 'NOT_IMPLEMENTED', 'commenting is only implemented over the private API');
  }

  // Harvest after that, but before asking: a human should not approve a comment
  // we then turn out to be unable to send, and the tokens are part of what is
  // being approved.
  const harvested = await harvest(activityId, ctx.transport.session, now);
  if ('ok' in harvested && harvested.ok !== true) return harvested as Envelope;
  if (!('tokens' in harvested)) return harvested as Envelope;

  const plan: WritePlan<{
    activityId: string;
    text: string;
    tokens: CommentTokens;
    edit?: CommentRef;
  }> = {
    action: editing === null ? 'comment on a post' : 'edit your comment',
    payload: {
      activityId,
      text,
      tokens: harvested.tokens,
      ...(editing === null ? {} : { edit: editing }),
    },
    summary: [
      authorLine(ctx.transport),
      `on       ${postUrn}`,
      `${editing === null ? 'content ' : 'new text'} "${text}"`,
    ],
    reversibility:
      editing === null
        ? 'deletable with `lnrelay delete <comment-urn>`; the author is notified immediately'
        : 'editable again; LinkedIn marks the comment edited and the original is not recoverable here',
    transport: 'voyager',
  };

  const gated = await gate('comment', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const client = createLiveClient(ctx.transport.session);
  const result =
    editing === null
      ? await sduiComment(gated.confirmed as never, client)
      : await runCommentAction(editing, UPDATE_OP, harvested.tokens.trackingId, client, text);

  return result.ok
    ? ok('comment', { on: postUrn, edited: editing !== null })
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
