// ─── The unsanctioned write transport ─────────────────────────────────────────
//
// Writing over Voyager, with the same two cookies the reads already use.
//
// This exists because the sanctioned path has a prerequisite not everyone can
// meet: `w_member_social` needs a registered developer app, which needs an
// associated LinkedIn *Page*. Someone with no company has no Page, and so no
// legitimate way to post to their own feed from their own tools. That is a real
// gap, not a hypothetical one.
//
// docs/DESIGN.md ratified OAuth as the sole write transport, with the rule:
// "if OAuth cannot perform an operation, omit the command — never fall back to
// Voyager SILENTLY." This is the non-silent version of that fallback, and the
// distinction is the whole design:
//
//   - OAuth is still preferred whenever a token exists. This is the fallback,
//     not the default (see commands/write.ts).
//   - The confirmation prompt names the transport, so the human approving the
//     write knows which surface it goes over before they approve it.
//   - It is CLI-only and TTY-gated exactly like every other write.
//
// What this buys, honestly: nothing legal. LinkedIn's User Agreement §8.2 bans
// automated posting regardless of how the bytes are produced, so this is not
// "safer" than driving a browser — the research (docs/research/W4) found the
// contract exposure identical and the technical-detection margin small and
// uncertain in both directions. What it does buy is FAILURE MODE: a raw request
// either returns a status we can read or it doesn't. A script driving the real
// composer can post the wrong text, post twice, or report success on a UI that
// never submitted — and a write is publicly visible under the owner's name.
//
// PROVENANCE OF THE PAYLOAD:
//
//   share   ✅ VERIFIED LIVE 2026-08-13. The body below, sent with the six
//           standard headers and the two cookies, created a real public post
//           on the owner's feed. LinkedIn answered **201 Created**. The shape
//           came from four converging OSS clients (docs/research/W1) and was
//           right first time.
//
//   delete  Not yet exercised. Best-evidenced operation in the research, but
//           still `repo` evidence.
//
// The 201 is worth recording for a second reason: the classifier accepted only
// 200, because reads never return anything else, so that first successful post
// was reported to the user as FETCH_FAILED — after it had already gone live.
// Reporting a success as a failure is the worst direction to be wrong here: it
// invites a re-run, and the re-run posts twice. See classify.ts.

import type { ConfirmedWrite } from '../commands/confirm.ts';
import type { Client } from './client.ts';

const VOYAGER = 'https://www.linkedin.com/voyager/api';

export const SHARE_URL = `${VOYAGER}/contentcreation/normShares`;

export type WriteResult =
  | { ok: true; id: string | null; note?: string }
  | { ok: false; code: string; message: string; hint?: string };

export interface SharePayload {
  visibleToConnectionsOnly: boolean;
  externalAudienceProviders: unknown[];
  commentaryV2: { text: string; attributes: unknown[] };
  origin: string;
  allowedCommentersScope: string;
  postState: string;
  media: unknown[];
}

/**
 * The create-post body.
 *
 * Note that visibility here is a BOOLEAN (`visibleToConnectionsOnly`), the
 * inverse of the OAuth API's `visibility: 'PUBLIC' | 'CONNECTIONS'` enum.
 * Inverting it by accident publishes a connections-only note to the open web,
 * which is why the mapping is pinned by test rather than inlined at the call.
 */
export function sharePayload(text: string, visibility: 'PUBLIC' | 'CONNECTIONS'): SharePayload {
  return {
    visibleToConnectionsOnly: visibility === 'CONNECTIONS',
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: 'FEED',
    allowedCommentersScope: 'ALL',
    postState: 'PUBLISHED',
    media: [],
  };
}

/** Urn prefixes that identify a CREATED POST, as opposed to its author. */
const POST_URN = /urn:li:(share|activity|ugcPost):\d+/;

/**
 * Whether a urn identifies something this endpoint may be pointed at.
 *
 * Checked BEFORE encoding rather than after a failure, because the failure mode
 * of getting it wrong is not an error — a well-formed request naming the wrong
 * kind of entity is a request to destroy the wrong kind of thing, and we have
 * no evidence for what LinkedIn does with one.
 */
export function isDeletableUrn(urn: string): boolean {
  return new RegExp(`^${POST_URN.source}$`).test(urn);
}

/** The colons are path-hostile; the reference implementations all encode them. */
export function deleteUrl(urn: string): string {
  return `${SHARE_URL}/${encodeURIComponent(urn)}`;
}

/**
 * Delete one of the owner's own posts. Irreversible — the confirmation gate
 * upstream is what makes this safe, and it shows the post's text first.
 */
export async function deletePost(
  confirmed: ConfirmedWrite<{ urn: string }>,
  client: Client,
): Promise<WriteResult> {
  const { urn } = confirmed.payload;

  const result = await client.request({
    url: deleteUrl(urn),
    method: 'DELETE',
    spendClass: 'write',
    operation: 'delete',
  });

  if (result.ok) return { ok: true, id: urn };

  // A 404 has two meanings that call for opposite actions, and we cannot tell
  // them apart from here. Saying both beats picking one and being wrong.
  const notFound = result.code === 'NOT_FOUND';
  const out: WriteResult = {
    ok: false,
    code: result.code,
    message: result.message,
  };
  if (notFound) {
    out.hint =
      'Either the post is already gone — in which case nothing more is needed — or this is the ' +
      'wrong urn namespace for this endpoint. It is documented against `urn:li:share:<id>`; if ' +
      'you passed an activity or ugcPost urn, the same numeric id under `urn:li:share:` is the ' +
      'thing to try next.';
  } else if (result.hint !== undefined) {
    out.hint = result.hint;
  }
  return out;
}

/**
 * Find the created post's urn anywhere in the response.
 *
 * We have never seen this response body, so this searches rather than reading a
 * known field, and returns null instead of guessing when nothing matches. A
 * null urn means "posted, but we cannot tell you which post" — which is a
 * different and honest answer, not a failure.
 */
export function extractShareUrn(json: unknown): string | null {
  return JSON.stringify(json ?? null).match(POST_URN)?.[0] ?? null;
}

/**
 * Post to the owner's own feed over Voyager.
 *
 * Takes a ConfirmedWrite, so this is unreachable without a human having typed
 * the confirmation token at a terminal — the same guarantee the OAuth transport
 * gives, enforced by the type rather than by a check anyone could forget.
 */
export async function share(
  confirmed: ConfirmedWrite<{ text: string; visibility: 'PUBLIC' | 'CONNECTIONS' }>,
  client: Client,
): Promise<WriteResult> {
  const body = sharePayload(confirmed.payload.text, confirmed.payload.visibility);

  const result = await client.request({
    url: SHARE_URL,
    method: 'POST',
    body,
    spendClass: 'write',
    operation: 'share',
  });

  if (!result.ok) {
    const out: WriteResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }

  const id = extractShareUrn(result.json);
  return id === null
    ? {
        ok: true,
        id: null,
        note:
          'LinkedIn accepted the post but the response carried no recognisable urn. Run ' +
          '`lnrelay sync my-posts && lnrelay my-posts` to confirm what actually landed — and ' +
          'do NOT re-run this command on the assumption it failed, or you will post twice.',
      }
    : { ok: true, id };
}
