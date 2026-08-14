// ─── Asking the server what it can do ─────────────────────────────────────────
//
// SDUI is server-DRIVEN: the server ships the UI description, and that
// description contains each action's id and its fully-populated arguments. So
// the comment "…" menu is not just a menu — it is a contract listing, and
// requesting it tells us how to delete or edit a comment without capturing a
// single browser request.
//
// That matters beyond convenience. Every other write in this tool was learned
// by observing traffic and is therefore a snapshot: correct until LinkedIn
// changes it, and silently wrong after. An action replayed from the menu the
// server just sent is correct BY CONSTRUCTION — if the shape changes, the menu
// changes with it, and we follow.
//
// The payloads are taken verbatim rather than rebuilt from a hardcoded shape.
// The one thing we substitute is the comment text on an edit, which is the only
// part that is ours to decide.

import type { Client } from './client.ts';

const SDUI_ACTION = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';

const MENU_OP = 'com.linkedin.sdui.requests.comments.commentControlMenuRequest';
const SCREEN_ID = 'com.linkedin.sdui.flagshipnav.feed.UpdateDetail';

export const DELETE_OP = 'com.linkedin.sdui.comments.deleteComment';
export const UPDATE_OP = 'com.linkedin.sdui.comments.updateComment';

export function actionUrl(operation: string): string {
  return `${SDUI_ACTION}?sduiid=${operation}`;
}

/** Wrap arguments in the envelope every SDUI action call uses. */
export function sduiEnvelope(operation: string, payload: unknown, states: unknown[] = []) {
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    requestId: operation,
    serverRequest: {
      requestId: operation,
      requestedArguments: args,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states,
    requestedArguments: { ...args, states, screenId: SCREEN_ID, knownTemplateIds: [] },
  };
}

export function menuBody(ref: CommentRef, trackingId: string) {
  const { activityId, commentId, threadType } = ref;
  const activityUrn = { activityUrn: { activityId } };
  return sduiEnvelope(MENU_OP, {
    // Rebuilt in the namespace it came from. A comment threaded to a ugcPost
    // given an `urn:li:activity:` thread names a different entity, and that
    // does not error — it acts on the wrong thing or finds nothing.
    commentUrn: { commentId, thread: `urn:li:${threadType}:${activityId}` },
    updateKey: {
      feedType: 3,
      items: [{ feedUpdateUrn: { updateUrnActivityUrn: activityUrn }, trackingId }],
      aggregationType: 0,
      isVideoCarousel: false,
    },
    menuContentRef: `auto-component-${crypto.randomUUID()}`,
  });
}

/**
 * Pull one action's payload out of a menu response.
 *
 * The response is a React Server Components stream, not JSON, so the payload is
 * located by scanning for the operation id and then reading the balanced JSON
 * object that follows its `"payload":` key. Brace-matching rather than a regex,
 * because these payloads nest several levels deep and a greedy match would
 * swallow half the stream.
 */
export function extractActionPayload(stream: string, operation: string): unknown | null {
  const at = stream.indexOf(operation);
  if (at === -1) return null;

  const key = stream.indexOf('"payload":', at);
  if (key === -1) return null;

  const start = stream.indexOf('{', key);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stream.length; i++) {
    const ch = stream[i] as string;
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString && ch === '{') {
      depth++;
    } else if (!inString && ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stream.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export type MenuResult =
  | { ok: true; stream: string }
  | { ok: false; code: string; message: string; hint?: string };

/** Fetch the comment's action menu. A read, though it is issued as a POST. */
export async function fetchCommentMenu(
  ref: CommentRef,
  trackingId: string,
  client: Client,
): Promise<MenuResult> {
  const result = await client.request({
    url: actionUrl(MENU_OP),
    method: 'POST',
    body: menuBody(ref, trackingId),
    spendClass: 'page',
    operation: 'commentMenu',
  });

  if (!result.ok) {
    const out: MenuResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  // The stream is not JSON; the client hands back the raw text as `json: null`
  // with the body preserved on the classification.
  const stream = (result.classification as { raw?: string }).raw ?? '';
  return { ok: true, stream };
}

export interface CommentRef {
  /** The numeric id of the thread this comment hangs off. */
  activityId: string;
  commentId: string;
  /**
   * Which namespace the thread was written in.
   *
   * NOT always `activity`. A comment in the feed came back threaded to a
   * `ugcPost`, and ENGINE-RESEARCH §5b already records that the two are
   * distinct and not derivable from one another — so the namespace is carried
   * rather than assumed, and callers that must rebuild a urn use this.
   */
  threadType: 'activity' | 'ugcPost';
}

export type ActionResult =
  | { ok: true; operation: string }
  | { ok: false; code: string; message: string; hint?: string };

/**
 * The state id of a REPLY box: the parent comment's urn.
 *
 * A reply is `createComment` with its bindings keyed to the parent comment
 * instead of to the post's opaque key — discovered by rendering the reply box's
 * submit button and reading the action it declared. The payload has NO parent
 * field; the binding is the parent reference. Send the post's key by mistake
 * and you publish a top-level comment on someone's thread instead of a reply,
 * with nothing erroring.
 */
export function boxStateId(parent: CommentRef): string {
  return `urn:li:comment:(urn:li:${parent.threadType}:${parent.activityId},${parent.commentId})`;
}

/**
 * Build the two text states from whichever names the server used for the
 * bindings. A reply payload calls them commentFieldBinding /
 * richCommentFieldBinding; an edit payload calls them commentary /
 * richTextCommentary. Returns [] when neither is present, so callers refuse
 * rather than sending a half-populated state that posts blank text.
 */
export function textStates(payload: Record<string, unknown>, text: string): unknown[] {
  const keyOf = (...names: string[]): string | null => {
    for (const n of names) {
      const slot = payload[n] as { key?: unknown } | undefined;
      if (typeof slot?.key === 'string') return slot.key;
    }
    return null;
  };
  const plain = keyOf('commentary', 'commentFieldBinding');
  const rich = keyOf('richTextCommentary', 'richCommentFieldBinding');
  if (plain === null || rich === null) return [];

  const entry = (key: string, value: unknown, protoCase: string) => ({
    key,
    namespace: 'MemoryNamespace',
    value,
    originalProtoCase: protoCase,
    protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: key } },
  });
  return [
    entry(plain, text, 'stringValue'),
    entry(rich, { text, attribute: [], $type: 'TextModel', source: 'local' }, 'textModelForWrite'),
  ];
}

/**
 * States for an edit: the new text under the keys the SERVER named.
 *
 * The keys come out of the menu payload rather than being rebuilt, because the
 * server already told us what they are — and for an edit they turn out to be
 * the plain comment urn, not the opaque binding a new comment needs.
 */
function editStates(payload: Record<string, unknown>, text: string): unknown[] {
  return textStates(payload, text);
}

/**
 * Run a delete or edit on a comment, using the payload the SERVER just handed
 * us for that exact action.
 *
 * Nothing about the payload is reconstructed from a hardcoded shape. That is
 * the point: every other write here is a snapshot of traffic that was correct
 * when captured, while this one is correct by construction — if LinkedIn
 * changes the arguments, the menu changes with them and we follow.
 */
export async function runCommentAction(
  ref: CommentRef,
  operation: typeof DELETE_OP | typeof UPDATE_OP,
  trackingId: string,
  client: Client,
  newText?: string,
): Promise<ActionResult> {
  const menu = await fetchCommentMenu(ref, trackingId, client);
  if (!menu.ok) return { ok: false, code: menu.code, message: menu.message };

  const payload = extractActionPayload(menu.stream, operation) as Record<string, unknown> | null;
  if (payload === null) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: `LinkedIn did not offer '${operation.split('.').pop()}' on this comment`,
      hint:
        'The menu lists only what the server permits — you may not own this comment, or the ' +
        'action may not exist on this surface. Nothing was sent.',
    };
  }

  // Guard on the id the SERVER echoed, not the one we asked for. If they
  // disagree, we would be acting on someone else's comment.
  const echoed = (payload.commentUrn as { commentId?: unknown } | undefined)?.commentId;
  if (echoed !== ref.commentId) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `the menu described comment ${String(echoed)} but we asked about ${ref.commentId}`,
      hint: 'Refusing to send — this is how an action lands on the wrong comment.',
    };
  }

  const states =
    operation === UPDATE_OP && newText !== undefined ? editStates(payload, newText) : [];
  if (operation === UPDATE_OP && states.length === 0) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the menu did not name the comment-text state keys, so an edit cannot be built',
    };
  }

  const result = await client.request({
    url: actionUrl(operation),
    method: 'POST',
    body: sduiEnvelope(operation, payload, states),
    spendClass: 'write',
    operation: operation.split('.').pop() ?? operation,
  });

  if (!result.ok) {
    const out: ActionResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return { ok: true, operation };
}

/**
 * Parse any of the three live comment-urn forms into its two ids.
 *
 * They do not agree on member order. `post` returns the `fsd_comment` form with
 * the COMMENT id first; the other two put the activity first, one of them
 * without its `urn:li:` prefix. Both members are bare numbers, so reading them
 * positionally and getting it backwards is undetectable downstream — the action
 * simply lands on the wrong thing. Hence matching by shape, never by position.
 */
export function parseCommentUrn(urn: string): CommentRef | null {
  const fsd = /^urn:li:fsd_comment:\((\d+),urn:li:(activity|ugcPost):(\d+)\)$/.exec(urn);
  if (fsd !== null) {
    return {
      commentId: fsd[1] as string,
      threadType: fsd[2] as 'activity' | 'ugcPost',
      activityId: fsd[3] as string,
    };
  }

  const plain = /^urn:li:comment:\((?:urn:li:)?(activity|ugcPost):(\d+),(\d+)\)$/.exec(urn);
  if (plain !== null) {
    return {
      threadType: plain[1] as 'activity' | 'ugcPost',
      activityId: plain[2] as string,
      commentId: plain[3] as string,
    };
  }

  return null;
}

const SUBMIT_COMPONENT = 'com.linkedin.sdui.generated.comments.dsl.impl.submitCommentButton';
const CREATE_OP = 'com.linkedin.sdui.comments.createComment';

const COMPONENT_URL = 'https://www.linkedin.com/flagship-web/rsc-action/actions/component';

/**
 * WITHDRAWN — this does NOT produce a nested reply. Verified live 2026-08-14:
 * it posted a second TOP-LEVEL comment on the post.
 *
 * The reasoning that produced it was circular. The component render was treated
 * as DISCOVERY, but it is an ECHO: we pass `commentBoxStateId = <parent comment
 * urn>` and the server reflects it back inside the action it describes. The
 * guard below then checked "is the payload bound to the parent?" — against a
 * value we ourselves supplied. It could not have failed.
 *
 * So the binding key is NOT sufficient to make a reply, and W5's conclusion
 * that "the binding key IS the parent reference" was wrong. Whatever nests a
 * comment is something this has not found. Kept, unexported from the CLI, as
 * the record of a dead end — do not re-wire it without a live test that shows
 * an actual nested reply.
 */
export async function fetchReplyAction(
  postActivityId: string,
  parent: CommentRef,
  trackingId: string,
  client: Client,
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: string; message: string; hint?: string }
> {
  const activityUrn = { activityUrn: { activityId: postActivityId } };
  const body = {
    clientArguments: {
      payload: {
        collection: {
          updateKey: {
            feedType: 3,
            items: [{ feedUpdateUrn: { updateUrnActivityUrn: activityUrn }, trackingId }],
            aggregationType: 0,
            isVideoCarousel: false,
          },
          threadUrn: { threadUrnActivityThreadUrn: activityUrn },
        },
        // Keying the box to the PARENT COMMENT is what makes this a reply.
        commentBoxStateId: boxStateId(parent),
      },
      states: [],
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      screenId: SCREEN_ID,
      knownTemplateIds: [],
    },
  };

  const result = await client.request({
    url: `${COMPONENT_URL}?componentId=${SUBMIT_COMPONENT}&sduiid=${SUBMIT_COMPONENT}`,
    method: 'POST',
    body,
    spendClass: 'page',
    operation: 'replyBox',
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  const stream = (result.classification as { raw?: string }).raw ?? '';
  const payload = extractActionPayload(stream, CREATE_OP) as Record<string, unknown> | null;
  if (payload === null) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: 'the reply box did not declare a createComment action',
      hint: 'Replies may be closed on this post, or the component shape changed. Nothing was sent.',
    };
  }

  // The binding must name the parent we asked about. If it names the post
  // instead, sending this would publish a TOP-LEVEL comment on someone's
  // thread rather than a reply — the exact failure this check exists for.
  const bound = (payload.commentFieldBinding as { key?: unknown } | undefined)?.key;
  if (typeof bound !== 'string' || !bound.includes(boxStateId(parent))) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the reply box came back bound to something other than the parent comment',
      hint: 'Refusing to send — this is how a reply becomes a top-level comment.',
    };
  }

  return { ok: true, payload };
}

/** Post a reply to a comment. The payload comes from the server, not from us. */
export async function replyToComment(
  postActivityId: string,
  parent: CommentRef,
  text: string,
  trackingId: string,
  client: Client,
): Promise<ActionResult> {
  const action = await fetchReplyAction(postActivityId, parent, trackingId, client);
  if (!action.ok) {
    const out: ActionResult = { ok: false, code: action.code, message: action.message };
    if (action.hint !== undefined) out.hint = action.hint;
    return out;
  }

  const states = textStates(action.payload, text);
  if (states.length === 0) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the reply box did not name its text bindings, so a reply cannot be built',
    };
  }

  const result = await client.request({
    url: actionUrl(CREATE_OP),
    method: 'POST',
    body: sduiEnvelope(CREATE_OP, action.payload, states),
    spendClass: 'write',
    operation: 'reply',
  });
  if (!result.ok) {
    const out: ActionResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return { ok: true, operation: CREATE_OP };
}
