// ─── Harvesting the tokens a comment needs ────────────────────────────────────
//
// Commenting needs two things that a reaction does not: a `trackingId` from the
// feed render, and an opaque `commentBoxStateId` binding key. Both live in the
// rendered post page, and that page is a PLAIN AUTHENTICATED GET — no browser,
// no CDP. See docs/research/W5 for the capture this is built from.
//
// Scraping a rendered page is the most drift-prone thing in this codebase, so
// the design leans on one lucky property: the binding key CONTAINS the post id.
//
//   commentBoxText-<base64(post id)><31 opaque bytes><FeedType_…>
//
// The first segment is the activity id, zigzag-encoded as a protobuf sint64.
// That means a harvested key can be PROVEN to belong to the post we intend to
// comment on, rather than trusted because of where it was found. A feed page
// carries comment boxes for many posts; picking the wrong one would post a
// comment on a stranger's update under the owner's name. The id check makes
// that structurally impossible instead of merely unlikely.

/** Zigzag encoding: what protobuf uses for signed ints. Positive n -> 2n. */
function zigzag(n: bigint): bigint {
  return (n << 1n) ^ (n >> 63n);
}

function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/**
 * The derivable first segment of a comment-box binding key.
 *
 * BigInt throughout: activity ids exceed Number.MAX_SAFE_INTEGER, and doing
 * this in a JS number rounds silently — encoding a segment for a post that
 * does not exist.
 */
export function activityIdSegment(activityId: string): string {
  if (!/^\d+$/.test(activityId)) {
    throw new Error(`'${activityId}' is not a numeric activity id`);
  }
  const inner = [0x08, ...varint(zigzag(BigInt(activityId)))];
  const message = Uint8Array.from([0x0a, inner.length, ...inner]);
  // UNPADDED. The key format is `commentBoxText-<A>-<B><FeedType_…>`, where the
  // '-' after segment A is a SEPARATOR, not padding. One capture made these
  // indistinguishable — its segment B began with '-', so an 18-char segment
  // plus a separator read exactly like a 20-char padded one. A unit test built
  // on that single sample passed against a wrong encoder; only a second post
  // exposed it.
  return btoa(String.fromCharCode(...message)).replace(/=+$/, '');
}

/** Whether a harvested key really belongs to this post. */
export function keyMatchesPost(bindingKey: string, activityId: string): boolean {
  try {
    return bindingKey.startsWith(`commentBoxText-${activityIdSegment(activityId)}-`);
  } catch {
    return false;
  }
}

export type HarvestResult =
  | { ok: true; bindingKey: string; trackingId: string }
  | { ok: false; message: string; hint?: string };

/** Markers that mean we were served something other than the post. */
const NOT_THE_POST = /checkpoint\/challenge|\/uas\/login|authwall|"status"\s*:\s*999/i;

/**
 * How close a trackingId must sit to a mention of the post id to be ITS id.
 *
 * Measured, not guessed: on a real permalink the update's own trackingId was 24
 * characters from an activity-id mention, while the next nearest candidate was
 * 13,613 away. The page also carries a page-level trackingId beside `treeId`
 * and `pageForestId` that has nothing to do with the post — taking the first
 * match in document order picks exactly that wrong one.
 */
const TRACKING_PROXIMITY = 400;

/** A trackingId whose position proves it belongs to this update. */
function updateTrackingId(html: string, activityId: string): string | null {
  const idAt = [...html.matchAll(new RegExp(activityId, 'g'))].map((m) => m.index ?? 0);
  if (idAt.length === 0) return null;

  // Quotes arrive HTML-escaped inside the embedded payloads.
  const pattern = /trackingId(?:&quot;|\\?")+\s*:\s*(?:&quot;|\\?")+([A-Za-z0-9+/=]{16,32})/g;
  let best: { value: string; distance: number } | null = null;
  for (const m of html.matchAll(pattern)) {
    const at = m.index ?? 0;
    const distance = Math.min(...idAt.map((p) => Math.abs(p - at)));
    if (best === null || distance < best.distance) best = { value: m[1] as string, distance };
  }
  return best !== null && best.distance <= TRACKING_PROXIMITY ? best.value : null;
}

/**
 * Pull the two tokens out of a rendered post page.
 *
 * Every failure here is loud. A comment built on a stale, empty or foreign
 * binding is the failure mode this whole module exists to prevent, and an
 * absent token must never reach the payload as `undefined`.
 */
export function extractCommentTokens(html: string, activityId: string): HarvestResult {
  if (NOT_THE_POST.test(html)) {
    return {
      ok: false,
      message: 'the page returned was a challenge or sign-in wall, not the post',
      hint: 'Re-mint the session with `lnrelay login`, then check `lnrelay risk`.',
    };
  }

  // Only keys carrying THIS post's id are candidates. A feed page contains
  // comment boxes for many posts.
  let expected: string;
  try {
    expected = activityIdSegment(activityId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const keyPattern = new RegExp(
    `commentBoxText-${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9+/_=-]*FeedType_[A-Z_]+`,
  );
  const key = keyPattern.exec(html)?.[0];
  if (key === undefined) {
    return {
      ok: false,
      message: `no comment-box binding key for post ${activityId} was found in the page`,
      hint:
        'Either the post does not accept comments, or LinkedIn changed the rendered shape. ' +
        'Re-capture with `bun run scripts/observe-write.ts` before changing this parser.',
    };
  }

  const trackingId = updateTrackingId(html, activityId);
  if (trackingId === null) {
    return {
      ok: false,
      message: `no trackingId adjacent to post ${activityId} was found in the page`,
      hint:
        'The page carries several — one for the page itself, one per rendered update. Only the ' +
        "update's own will do, and guessing would build a malformed comment.",
    };
  }

  return { ok: true, bindingKey: key, trackingId };
}
