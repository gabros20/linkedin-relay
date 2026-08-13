// ─── Reactions, over SDUI ─────────────────────────────────────────────────────
//
// Reactions do not go to Voyager. They go to LinkedIn's Server-Driven UI
// surface, over React Server Component actions:
//
//   POST /flagship-web/rsc-action/actions/server-request
//        ?sduiid=com.linkedin.sdui.reactions.create   (or .delete)
//
// This was found by capture, on 2026-08-13, and it is why two earlier attempts
// to observe a reaction recorded nothing: the observer filtered for
// `/voyager/api/` and was structurally blind to a surface that does not live
// there. Everything in this file came off the wire; none of it is inferred.
//
// It also settles a question the research could not. W1 found exactly one OSS
// sample for reacting — `POST /voyagerSocialDashReactions?threadUrn=urn:li:
// activity:<id>` with `{"reactionType":"LIKE"}` — which contradicted this
// project's own verified read-side finding that reactions key off a ugcPost
// urn. Both were wrong for the current client, and the argument was moot:
// the live surface takes neither urn form. It takes a nested object holding
// the BARE NUMERIC ID, and a reaction type with a `ReactionType_` prefix.
// Shipping that sample would have failed against a superseded endpoint.
//
// WHY REACTIONS ARE SHIPPABLE AND COMMENTS ARE NOT. The reaction payload is
// self-contained: an id, a type, a source, and a fixed screen id — 1,481 bytes
// with no server-issued token in it. `com.linkedin.sdui.comments.createComment`
// carries a `trackingId` from the feed render and an opaque binding key
// (`commentBoxText-CgsIgIC6…`) that only exists once a page has been rendered,
// so replaying it means fetching the SDUI screen first to harvest them. That
// is a real two-step protocol, not a missing constant, and it is why `comment`
// stays unimplemented.

import type { ConfirmedWrite } from '../commands/confirm.ts';
import type { Client } from './client.ts';

const SDUI_ACTION = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';

/** The screen the live client declares when reacting from a post detail view. */
const SCREEN_ID = 'com.linkedin.sdui.flagshipnav.feed.UpdateDetail';

/** All six the UI offers, observed cycling through every one. */
export const REACTIONS = [
  'LIKE',
  'PRAISE',
  'EMPATHY',
  'INTEREST',
  'APPRECIATION',
  'ENTERTAINMENT',
] as const;

export type Reaction = (typeof REACTIONS)[number];

/**
 * What each enum actually renders as in the UI. These do NOT match: `PRAISE`
 * shows as "Celebrate", `INTEREST` as "Insightful". Verified live — a
 * `--type PRAISE` produced a Celebrate. Surfaced in the confirmation prompt so
 * nobody discovers the mismatch by putting the wrong reaction on a real post.
 */
const LABELS: Record<Reaction, string> = {
  LIKE: 'Like',
  PRAISE: 'Celebrate',
  EMPATHY: 'Love',
  INTEREST: 'Insightful',
  APPRECIATION: 'Support',
  ENTERTAINMENT: 'Funny',
};

export function reactionLabel(reaction: Reaction): string {
  return LABELS[reaction];
}

export function reactionUrl(op: 'create' | 'delete'): string {
  return `${SDUI_ACTION}?sduiid=com.linkedin.sdui.reactions.${op}`;
}

export interface ReactionTarget {
  threadUrn: Record<string, unknown>;
  /** `Update` for a post, `Comment` for a comment. Not interchangeable. */
  reactionSource: 'Update' | 'Comment';
}

/**
 * Build the target object for a post or a comment.
 *
 * A post is identified by its bare numeric activity id — no urn string reaches
 * the wire. A comment needs both its own id AND its parent thread, because a
 * comment id is only unique within a thread.
 *
 * Throws rather than returning a partial target: an empty threadUrn is a
 * well-formed request to react to nothing, and we have no idea what LinkedIn
 * does with one.
 */
export function targetFor(urn: string): ReactionTarget {
  const comment = /^urn:li:comment:\((urn:li:activity:\d+),(\d+)\)$/.exec(urn);
  if (comment !== null) {
    return {
      threadUrn: {
        threadUrnCommentThreadUrn: {
          commentUrn: { commentId: comment[2] as string, thread: comment[1] as string },
        },
      },
      reactionSource: 'Comment',
    };
  }

  const activity = /^urn:li:(?:activity|ugcPost|share):(\d+)$/.exec(urn);
  if (activity !== null) {
    return {
      threadUrn: {
        threadUrnActivityThreadUrn: { activityUrn: { activityId: activity[1] as string } },
      },
      reactionSource: 'Update',
    };
  }

  throw new Error(
    `'${urn}' does not identify a post or a comment — expected urn:li:activity:<id> or urn:li:comment:(urn:li:activity:<id>,<id>)`,
  );
}

export interface ReactionPayload {
  threadUrn: Record<string, unknown>;
  reactionType: string;
  reactionSource: string;
}

export function reactionPayload(target: ReactionTarget, reaction: Reaction): ReactionPayload {
  return {
    threadUrn: target.threadUrn,
    reactionType: `ReactionType_${reaction}`,
    reactionSource: target.reactionSource,
  };
}

interface RequestedArguments {
  $type: string;
  requestedStateKeys: unknown[];
  payload: ReactionPayload;
  requestMetadata: { $type: string };
  states?: unknown[];
  screenId?: string;
  knownTemplateIds?: unknown[];
}

export interface SduiBody {
  requestId: string;
  serverRequest: {
    requestId: string;
    requestedArguments: RequestedArguments;
    isApfcEnabled: boolean;
    isStreaming: boolean;
    rumPageKey: string;
  };
  states: unknown[];
  requestedArguments: RequestedArguments;
}

/**
 * The request body, mirroring the live client — including the fact that it
 * sends the arguments TWICE, once nested under `serverRequest` and once at the
 * top level. That is not a mistake in the capture; both copies were present in
 * all 56 recorded calls, so both are reproduced rather than tidied away.
 *
 * The client also sends an `onClientRequestFailureAction` block describing a
 * toast to show and state to roll back on failure. That is pure client-side UI
 * instruction with nothing for the server to act on, so it is omitted — the
 * one deliberate departure from the captured shape, noted here so a future
 * failure has somewhere to look.
 */
export function sduiBody(
  op: 'create' | 'delete',
  target: ReactionTarget,
  reaction: Reaction,
): SduiBody {
  const requestId = `com.linkedin.sdui.reactions.${op}`;
  const payload = reactionPayload(target, reaction);
  const args: RequestedArguments = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };

  return {
    requestId,
    serverRequest: {
      requestId,
      requestedArguments: args,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states: [],
    requestedArguments: {
      ...args,
      states: [],
      screenId: SCREEN_ID,
      knownTemplateIds: [],
    },
  };
}

export type WriteResult =
  | { ok: true; id: string | null; note?: string }
  | { ok: false; code: string; message: string; hint?: string };

/** Add or remove a reaction. Unreachable without a human-confirmed write. */
export async function react(
  confirmed: ConfirmedWrite<{ urn: string; type: Reaction; remove: boolean }>,
  client: Client,
): Promise<WriteResult> {
  const { urn, type, remove } = confirmed.payload;

  let target: ReactionTarget;
  try {
    target = targetFor(urn);
  } catch (e) {
    return { ok: false, code: 'INVALID_INPUT', message: (e as Error).message };
  }

  const op = remove ? 'delete' : 'create';
  const result = await client.request({
    url: reactionUrl(op),
    method: 'POST',
    body: sduiBody(op, target, type),
    spendClass: 'write',
    operation: `reaction.${op}`,
  });

  if (result.ok) return { ok: true, id: urn };

  const out: WriteResult = { ok: false, code: result.code, message: result.message };
  out.hint =
    result.hint ??
    'This surface was captured from the live client but has never been replayed by this tool. ' +
      'If it refuses, the first thing to try is sending `x-li-page-instance` and `x-li-track`, ' +
      'which the browser sends here and which our verified read header set deliberately omits.';
  return out;
}
