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

export function menuBody(activityId: string, commentId: string, trackingId: string) {
  const activityUrn = { activityUrn: { activityId } };
  return sduiEnvelope(MENU_OP, {
    commentUrn: { commentId, thread: `urn:li:activity:${activityId}` },
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
  activityId: string,
  commentId: string,
  trackingId: string,
  client: Client,
): Promise<MenuResult> {
  const result = await client.request({
    url: actionUrl(MENU_OP),
    method: 'POST',
    body: menuBody(activityId, commentId, trackingId),
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
  activityId: string;
  commentId: string;
}

export type ActionResult =
  | { ok: true; operation: string }
  | { ok: false; code: string; message: string; hint?: string };

/**
 * States for an edit: the new text under the keys the SERVER named.
 *
 * The keys come out of the menu payload rather than being rebuilt, because the
 * server already told us what they are — and for an edit they turn out to be
 * the plain comment urn, not the opaque binding a new comment needs.
 */
function editStates(payload: Record<string, unknown>, text: string): unknown[] {
  const named = (field: string): string | null => {
    const slot = payload[field] as { key?: unknown } | undefined;
    return typeof slot?.key === 'string' ? slot.key : null;
  };
  const plain = named('commentary');
  const rich = named('richTextCommentary');
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
  const menu = await fetchCommentMenu(ref.activityId, ref.commentId, trackingId, client);
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
