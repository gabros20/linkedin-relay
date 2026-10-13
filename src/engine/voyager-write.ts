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

import { createHash } from 'node:crypto';
import type { ConfirmedWrite } from '../commands/confirm.ts';
import type { Client } from './client.ts';
import { contractFor } from './contracts.ts';
import { type MediaKind, uploadMedia } from './voyager-media.ts';

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
  /** Epoch ms. Present only on a scheduled post. */
  scheduledAt?: number;
}

/** The share-media `category` for each upload kind. A document is not "DOCUMENT". */
const CATEGORY: Record<MediaKind | 'POLL', string> = {
  POLL: 'URN_REFERENCE',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  DOCUMENT: 'NATIVE_DOCUMENT',
};

/**
 * The create-post body.
 *
 * Note that visibility here is a BOOLEAN (`visibleToConnectionsOnly`), the
 * inverse of the OAuth API's `visibility: 'PUBLIC' | 'CONNECTIONS'` enum.
 * Inverting it by accident publishes a connections-only note to the open web,
 * which is why the mapping is pinned by test rather than inlined at the call.
 */
export function sharePayload(
  text: string,
  visibility: 'PUBLIC' | 'CONNECTIONS',
  media: { category: MediaKind | 'POLL'; urn: string; alt?: string; title?: string }[] = [],
  scheduledAt?: number,
): SharePayload {
  // LinkedIn publishes a SCHEDULED post itself at scheduledAt (verified 2026-10-13).
  const schedule =
    scheduledAt === undefined
      ? { postState: 'PUBLISHED' }
      : { postState: 'SCHEDULED', scheduledAt };
  return {
    visibleToConnectionsOnly: visibility === 'CONNECTIONS',
    externalAudienceProviders: [],
    commentaryV2: { text, attributes: [] },
    origin: 'FEED',
    allowedCommentersScope: 'ALL',
    ...schedule,
    // altText only when given, so a post without it keeps the body verified in 2026-08.
    media: media.map((m) => ({
      category: CATEGORY[m.category],
      mediaUrn: m.urn,
      tapTargets: [],
      ...(m.alt === undefined ? {} : { altText: m.alt }),
      ...(m.title === undefined ? {} : { title: { text: m.title } }),
    })),
  };
}

/** What the human approves about a file: its identity, not its bytes. */
export interface ApprovedMedia {
  filename: string;
  kind: MediaKind;
  contentType: string;
  size: number;
  sha256: string;
  /** Alt text for screen readers; images only. */
  alt?: string;
  /** A document's title, which LinkedIn requires; documents only. */
  title?: string;
}

export function mediaDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  confirmed: ConfirmedWrite<{
    text: string;
    visibility: 'PUBLIC' | 'CONNECTIONS';
    media?: ApprovedMedia[];
    /** Epoch ms; makes this a scheduled post. */
    scheduledAt?: number;
    poll?: PollSpec;
  }>,
  client: Client,
  bytes?: Uint8Array[],
): Promise<WriteResult> {
  const approved = confirmed.payload.media ?? [];
  const files = bytes ?? [];

  // The approval names each file by digest and the bytes travel separately —
  // so ALL of them are checked before anything leaves the machine. Checking
  // one at a time would upload the first before discovering the second changed.
  for (const [i, a] of approved.entries()) {
    const b = files[i];
    if (b === undefined || mediaDigest(b) !== a.sha256) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `${a.filename} changed after it was approved; nothing was sent`,
      };
    }
  }

  const media: { category: MediaKind | 'POLL'; urn: string; alt?: string; title?: string }[] = [];

  // A poll is created first, as its own object, then referenced like media.
  const { poll } = confirmed.payload;
  if (poll !== undefined) {
    const created = await createPoll(poll, client);
    if (!created.ok) return created;
    media.push({ category: 'POLL', urn: created.urn });
  }
  for (const [i, a] of approved.entries()) {
    const uploaded = await uploadMedia(
      {
        bytes: files[i] as Uint8Array,
        filename: a.filename,
        kind: a.kind,
        contentType: a.contentType,
      },
      client,
    );
    if (!uploaded.ok) return uploaded;
    media.push({
      category: a.kind,
      urn: uploaded.urn,
      ...(a.alt === undefined ? {} : { alt: a.alt }),
      ...(a.title === undefined ? {} : { title: a.title }),
    });
  }

  const body = sharePayload(
    confirmed.payload.text,
    confirmed.payload.visibility,
    media,
    confirmed.payload.scheduledAt,
  );

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

// ─── Editing a post ───────────────────────────────────────────────────────────
//
// VERIFIED LIVE 2026-10-13: a Rest.li partial update on normShares/<urn>
// replaced a post's text, and the response returned the post as LinkedIn then
// held it, media untouched. The same resource `delete` uses, so no rotating
// queryId is involved. It replaces the WHOLE text: an @mention in the old text
// is not carried over, because `attributes` is sent empty.

export function editPostBody(text: string) {
  return { patch: { $set: { commentaryV2: { text, attributes: [] } } } };
}

export async function editPost(
  confirmed: ConfirmedWrite<{ urn: string; text: string }>,
  client: Client,
): Promise<WriteResult> {
  const { urn, text } = confirmed.payload;
  const result = await client.request({
    url: deleteUrl(urn),
    method: 'POST',
    body: editPostBody(text),
    spendClass: 'write',
    operation: 'edit-post',
  });
  if (!result.ok) {
    const out: WriteResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  const held = (result.json as { data?: { commentary?: { text?: unknown } } } | null)?.data
    ?.commentary?.text;
  if (held !== text) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'LinkedIn answered, but the post does not hold the text that was sent',
      hint: `Look at the post before trying again: \`lnrelay post\` or the browser. ${urn}`,
    };
  }
  return { ok: true, id: urn };
}

// ─── Polls ────────────────────────────────────────────────────────────────────
//
// VERIFIED LIVE 2026-10-13: the PollsPollSummary mutation returned a
// pollSummary urn, and normShares with media { category: URN_REFERENCE } posted
// it — LinkedIn's own scheduled list showed it as a poll. Creating the poll
// publishes nothing; it is an orphan until a post references it.

export type PollDuration = 'ONE_DAY' | 'THREE_DAYS' | 'ONE_WEEK' | 'TWO_WEEKS';

export interface PollSpec {
  question: string;
  options: string[];
  duration: PollDuration;
}

const DURATIONS: Record<string, PollDuration> = {
  '1d': 'ONE_DAY',
  '3d': 'THREE_DAYS',
  '1w': 'ONE_WEEK',
  '2w': 'TWO_WEEKS',
};

/** The `--duration` shorthand as LinkedIn's enum, or null. */
export function pollDuration(shorthand: string): PollDuration | null {
  return DURATIONS[shorthand] ?? null;
}

/** The first GraphQL error message, wherever this envelope put it. */
function gqlError(json: unknown): string | null {
  const j = json as { errors?: { message?: string }[]; data?: { errors?: { message?: string }[] } };
  const errors = j?.errors ?? j?.data?.errors;
  return errors !== undefined && errors.length > 0 ? (errors[0]?.message ?? 'GraphQL error') : null;
}

/** The created poll's urn, or null — including when the 200 carries errors. */
export function pollUrnOf(json: unknown): string | null {
  if (gqlError(json) !== null) return null;
  return JSON.stringify(json ?? null).match(/urn:li:fsd_pollSummary:\d+/)?.[0] ?? null;
}

async function createPoll(
  poll: PollSpec,
  client: Client,
): Promise<
  { ok: true; urn: string } | { ok: false; code: string; message: string; hint?: string }
> {
  const contract = contractFor('createPoll');
  if (contract?.queryId === undefined) {
    return { ok: false, code: 'NOT_IMPLEMENTED', message: 'no verified poll contract' };
  }
  const result = await client.request({
    url: `${contract.path}?action=execute&queryId=${contract.queryId}`,
    method: 'POST',
    body: { variables: { poll }, queryId: contract.queryId, includeWebMetadata: true },
    spendClass: 'write',
    operation: 'create-poll',
  });
  if (!result.ok)
    return { ok: false, code: result.code, message: `${result.message}; nothing was posted` };

  // GraphQL answers a validation failure with HTTP 200 — read the body, or a
  // refused poll would be reported as created.
  const error = gqlError(result.json);
  if (error !== null) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `LinkedIn refused the poll: ${error}; nothing was posted`,
    };
  }
  const urn = pollUrnOf(result.json);
  if (urn === null) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the poll mutation answered without a poll urn; nothing was posted',
      hint: 'The queryId may have rotated — recapture it (docs/ENGINE-RESEARCH.md).',
    };
  }
  return { ok: true, urn };
}
