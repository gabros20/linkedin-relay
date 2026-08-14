// ─── Replying to a comment ────────────────────────────────────────────────────
//
// Replies do NOT go where comments go. A top-level comment is an SDUI action
// (`com.linkedin.sdui.comments.createComment`, 9 KB of bindings and state); a
// REPLY is a plain Voyager POST with a four-field body. Same product surface,
// two entirely different transports.
//
// Captured live on 2026-08-14 after an implementation built by reasoning from
// the SDUI side shipped, posted a TOP-LEVEL comment, and had to be withdrawn.
// The mistake there was treating a component render as discovery when it was
// an echo — the server reflected back the parent urn we had supplied, and the
// guard checked our own input. Nothing on that surface would ever have revealed
// this endpoint, because the reply does not live on it.
//
// `threadUrn` is the parent reference the SDUI route never had.

import type { ConfirmedWrite } from '../commands/confirm.ts';
import type { Client } from './client.ts';
import type { CommentRef } from './sdui-menu.ts';

/**
 * The decorationId is REQUIRED. Omitting it returned HTTP 500, not a helpful
 * 400 — a decorated resource asked for without its decoration recipe.
 *
 * It is VERSIONED (`-43`), so it rotates like the queryIds in contracts.ts.
 * Captured 2026-08-14; if replies start failing, re-capture this first.
 */
const REPLY_DECORATION = 'com.linkedin.voyager.dash.deco.social.NormComment-43';

export const REPLY_URL = `https://www.linkedin.com/voyager/api/voyagerSocialDashNormComments?decorationId=${REPLY_DECORATION}`;

export interface ReplyBody {
  commentary: { text: string; attributesV2: unknown[]; $type: string };
  threadUrn: string;
}

/**
 * The parent comment, in the SHORT urn form the live client sends:
 * `urn:li:comment:(activity:<post>,<comment>)` — the inner urn carries no
 * `urn:li:` prefix here, unlike every other place this project handles it.
 */
export function parentThreadUrn(ref: CommentRef): string {
  return `urn:li:comment:(${ref.threadType}:${ref.activityId},${ref.commentId})`;
}

export function replyBody(ref: CommentRef, text: string): ReplyBody {
  return {
    commentary: {
      text,
      // The captured reply carried a profileMention, because LinkedIn's UI
      // pre-fills "@Author " into the box. We send none: an @mention notifies a
      // real person, and inventing one would put words — and a notification —
      // where the user did not ask for them.
      attributesV2: [],
      $type: 'com.linkedin.voyager.dash.common.text.TextViewModel',
    },
    threadUrn: parentThreadUrn(ref),
  };
}

export type ReplyResult =
  | { ok: true; parent: string }
  | { ok: false; code: string; message: string; hint?: string };

export async function replyToComment(
  confirmed: ConfirmedWrite<{ ref: CommentRef; text: string }>,
  client: Client,
): Promise<ReplyResult> {
  const { ref, text } = confirmed.payload;
  const result = await client.request({
    url: REPLY_URL,
    method: 'POST',
    body: replyBody(ref, text),
    spendClass: 'write',
    operation: 'reply',
  });

  if (!result.ok) {
    const out: ReplyResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return { ok: true, parent: parentThreadUrn(ref) };
}
