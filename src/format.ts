// ─── Presentation ─────────────────────────────────────────────────────────────
//
// Pure shaping of Voyager entities into flat, readable rows. No I/O.
//
// LinkedIn wraps essentially every piece of display text in a TextViewModel
// (`{text, textDirection, attributesV2, $type}`), sometimes twice — a post's
// commentary is `commentary.text.text`. Raw entities are therefore both huge
// and unreadable, so commands shape by default and keep the raw node behind
// `--raw` for when a shape has drifted and you need to see what actually came
// back.
//
// Every shaper is defensive: an unrecognised entity still reports its `$type`
// rather than returning nothing, because the parser deliberately lets unknown
// types through and silently blanking them here would undo that.

import type { Entity } from './engine/parse.ts';
import { innerUrn } from './engine/restli.ts';

export interface Shaped {
  type?: string;
  urn?: string;
  name?: string;
  headline?: string;
  location?: string;
  url?: string;
  text?: string;
  author?: string;
  posted?: string;
  [key: string]: unknown;
}

/** Pull the string out of a TextViewModel, at either nesting depth. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value === null || typeof value !== 'object') return undefined;

  const node = value as { text?: unknown };
  if (typeof node.text === 'string') return node.text.trim() || undefined;
  // commentary.text.text — the doubly-wrapped case.
  if (node.text !== null && typeof node.text === 'object') return text(node.text);
  return undefined;
}

function typeOf(node: Entity): string | undefined {
  const t = node.$type ?? (node as { _type?: unknown })._type;
  return typeof t === 'string' ? t : undefined;
}

/** Drop tracking query strings, which differ per request for identical results. */
function cleanUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined;
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function shapeSearchRow(node: Entity): Shaped {
  const entityUrn = typeof node.entityUrn === 'string' ? node.entityUrn : undefined;
  return defined({
    type: typeOf(node),
    // The entity urn is composite — (profileUrn, SEARCH_SRP, DEFAULT) — and the
    // member identity is its first member.
    urn: entityUrn === undefined ? undefined : innerUrn(entityUrn),
    name: text(node.title),
    headline: text(node.primarySubtitle),
    location: text(node.secondarySubtitle),
    url: cleanUrl(node.navigationUrl),
  });
}

/**
 * Engagement counts are two references away from the post:
 *
 *   UpdateV2 --*socialDetail--> SocialDetail --*totalSocialActivityCounts--> counts
 *
 * The parser drops both intermediate nodes as decorations, which is correct —
 * they are not content — so without the index a post has no like or comment
 * count at all. Engagement is the main ranking signal for research, so it is
 * worth the two hops.
 *
 * The same SocialDetail also carries the post's **ugcPost** URN, which is NOT
 * the activity URN in `updateMetadata` (verified live: activity …8686600193 vs
 * ugcPost …7814144000). Reactions and comments key off the ugcPost form, so
 * this is where that mapping comes from — it cannot be derived.
 */
/**
 * A post's own urn, from whichever of the two live shapes it is.
 *
 * `com.linkedin.voyager.feed.render.UpdateV2` carries it in `updateMetadata`.
 * Its dash sibling `com.linkedin.voyager.dash.feed.Update` — what `myPosts`
 * returns — has no `updateMetadata` at all, and hides the activity urn in the
 * first member of a composite entityUrn tuple:
 *
 *   urn:li:fsd_update:(urn:li:activity:662…,MEMBER_SHARES,DEBUG_REASON,…)
 *
 * Handling only the first shape made every post from `my-posts` arrive with no
 * urn, which left `delete` unable to identify the post it was about to destroy.
 */
function postUrn(node: Entity): string | undefined {
  const meta = node.updateMetadata as { urn?: unknown } | undefined;
  if (typeof meta?.urn === 'string') return meta.urn;

  const entityUrn = node.entityUrn;
  if (typeof entityUrn !== 'string') return undefined;
  return /urn:li:(activity|ugcPost|share):\d+/.exec(entityUrn)?.[0];
}

function shapePost(node: Entity, index?: Map<string, Entity>): Shaped {
  const actor = node.actor as { name?: unknown; subDescription?: unknown } | undefined;
  const urn = postUrn(node);

  const social = deref(node, '*socialDetail', index);
  const counts =
    social === undefined ? undefined : deref(social, '*totalSocialActivityCounts', index);

  return defined({
    type: typeOf(node),
    urn,
    threadUrn: typeof social?.urn === 'string' ? social.urn : undefined,
    author: text(actor?.name),
    // `text()` already trims; LinkedIn pads these with trailing spaces.
    posted: text(actor?.subDescription),
    text: text(node.commentary),
    likes: numberOf(counts?.numLikes),
    comments: numberOf(counts?.numComments),
    shares: numberOf(counts?.numShares ?? social?.totalShares),
    url: urn === undefined ? undefined : `https://www.linkedin.com/feed/update/${urn}/`,
  });
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Resolve a `*`-prefixed URN reference on a node against the side-table.
 * LinkedIn returns location, current position and education as references, so
 * a profile without its index is mostly pointers.
 */
function deref(
  node: Entity,
  key: string,
  index: Map<string, Entity> | undefined,
): Entity | undefined {
  if (index === undefined) return undefined;
  const ref = node[key];
  if (typeof ref === 'string') return index.get(ref);
  if (ref === undefined) return undefined;
  if (ref !== null && typeof ref === 'object') {
    for (const [k, v] of Object.entries(ref as Record<string, unknown>)) {
      if (k.startsWith('*') && typeof v === 'string') return index.get(v);
    }
  }
  return undefined;
}

/**
 * Shape a full profile, resolving the references LinkedIn leaves dangling.
 *
 * Note the honest gap: none of the observed projections returns
 * firstName/lastName/publicIdentifier, so a looked-up profile has no name.
 * The caller supplied the identifier, so this is a real limit rather than a
 * silent one — see src/engine/contracts.ts.
 */
export function shapeProfile(node: Entity, index?: Map<string, Entity>): Shaped {
  const base = shapeMember(node);
  const geo = deref(node, 'geoLocation', index);
  const position =
    deref(node, 'profileTopPosition', index) ?? firstOfType(index, 'profile.Position');
  const education =
    deref(node, 'profileTopEducation', index) ?? firstOfType(index, 'profile.Education');

  return defined({
    ...base,
    location: text(geo?.defaultLocalizedName) ?? text(geo?.localizedName),
    title: text(position?.title),
    company: text(position?.companyName),
    school: text(education?.schoolName),
  });
}

function firstOfType(index: Map<string, Entity> | undefined, suffix: string): Entity | undefined {
  if (index === undefined) return undefined;
  for (const node of new Set(index.values())) {
    if (String(node.$type ?? '').endsWith(suffix)) return node;
  }
  return undefined;
}

function shapeMember(node: Entity): Shaped {
  const first = text(node.firstName);
  const last = text(node.lastName);
  const publicId = text(node.publicIdentifier) ?? text(node.publicId);
  const name = [first, last].filter(Boolean).join(' ');
  return defined({
    type: typeOf(node),
    urn: typeof node.entityUrn === 'string' ? node.entityUrn : undefined,
    publicId,
    name: name === '' ? undefined : name,
    headline: text(node.headline) ?? text(node.occupation),
    url: publicId === undefined ? undefined : `https://www.linkedin.com/in/${publicId}/`,
  });
}

/**
 * A comment. The author lives under `commenter` as a lockup (title/subtitle/
 * navigationUrl), and the comment's own like count is another two-hop
 * dereference through its socialDetail — same chain as a post.
 */
function shapeComment(node: Entity, index?: Map<string, Entity>): Shaped {
  const commenter = node.commenter as Entity | undefined;
  const social = deref(node, '*socialDetail', index);
  const counts =
    social === undefined ? undefined : deref(social, '*totalSocialActivityCounts', index);

  return defined({
    type: typeOf(node),
    urn: typeof node.urn === 'string' ? node.urn : undefined,
    author: text(commenter?.title),
    headline: text(commenter?.subtitle),
    authorUrl: cleanUrl(commenter?.navigationUrl),
    text: text(node.comment) ?? text(node.commentary),
    likes: numberOf(counts?.numLikes),
    postedAt:
      typeof node.createdAt === 'number' ? new Date(node.createdAt).toISOString() : undefined,
    edited: node.edited === true ? true : undefined,
    url: cleanUrl(node.permalink),
  });
}

/** A reactor — who reacted, and with which reaction. */
function shapeReaction(node: Entity, index?: Map<string, Entity>): Shaped {
  const lockup = node.reactorLockup as Entity | undefined;
  const actorUrn = typeof node.actorUrn === 'string' ? node.actorUrn : undefined;
  const profile = actorUrn === undefined ? undefined : index?.get(actorUrn);

  return defined({
    type: typeOf(node),
    urn: actorUrn,
    name: text(lockup?.title),
    headline: text(lockup?.subtitle) ?? text(profile?.headline),
    reaction: typeof node.reactionType === 'string' ? node.reactionType : undefined,
    url: cleanUrl(lockup?.navigationUrl),
  });
}

/** Shape one entity into a flat row, dispatching on its type. */
export function shapeEntity(node: Entity, index?: Map<string, Entity>): Shaped {
  try {
    const t = (typeOf(node) ?? '').toLowerCase();
    if (t.includes('entityresultviewmodel')) return shapeSearchRow(node);
    // Order matters: Comment and Reaction are checked before the broader
    // 'update' and 'profile' fragments, which would otherwise swallow them.
    if (t.endsWith('social.comment')) return shapeComment(node, index);
    if (t.endsWith('social.reaction')) return shapeReaction(node, index);
    if (t.includes('update')) return shapePost(node, index);
    if (t.includes('profile')) return shapeMember(node);

    // Unrecognised: report the type and make a best effort, so a new shape
    // shows up as thin data rather than as nothing.
    return defined({
      type: typeOf(node),
      urn: typeof node.entityUrn === 'string' ? node.entityUrn : undefined,
      name: text(node.title) ?? text(node.name),
      text: text(node.commentary) ?? text(node.text),
    });
  } catch {
    return defined({ type: typeOf(node) });
  }
}

export function shapeAll(items: Entity[], index?: Map<string, Entity>): Shaped[] {
  return items.map((node) => shapeEntity(node, index));
}

// ─── Output modes ─────────────────────────────────────────────────────────────
//
// `--fields` and `--compact` were advertised in the command registry long
// before they existed — a documented promise the tool did not keep. They exist
// now, and tests/skill.test.ts asserts that every flag a usage string
// advertises is actually parsed, so the same drift cannot recur silently.
//
// Both are for the same problem: a shaped row is still ~8 keys of JSON, and an
// agent ranking 25 search results does not need all of them in its context.

/**
 * Keep only the named keys, in the order named. A key no row carries is
 * omitted rather than emitted as `undefined` — a field the user misspelled
 * should not become a column of nulls that looks like missing data.
 */
export function project<T extends Record<string, unknown>>(
  rows: T[],
  spec: string,
): Record<string, unknown>[] {
  const keys = spec
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  if (keys.length === 0) return rows;

  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    return out;
  });
}

/** Fields to lead with, in preference order — most identifying first. */
const LEAD = ['name', 'author', 'title'];
const DETAIL = ['headline', 'text', 'location', 'company', 'posted', 'reaction'];

/**
 * One flat line per row. Reduces a page of search results from kilobytes of
 * JSON to something scannable, without losing what a ranking decision needs.
 */
export function compactRows(rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => {
    const parts: string[] = [];

    for (const key of LEAD) {
      const v = row[key];
      if (typeof v === 'string' && v !== '') {
        parts.push(v);
        break;
      }
    }
    for (const key of DETAIL) {
      const v = row[key];
      if (typeof v === 'string' && v !== '') parts.push(v);
    }

    const counts = ['likes', 'comments']
      .map((k) => (typeof row[k] === 'number' ? `${row[k]} ${k}` : undefined))
      .filter((v): v is string => v !== undefined);
    parts.push(...counts);

    // A row with nothing human-readable still has to identify itself.
    if (parts.length === 0) {
      const urn = row.urn ?? row.type;
      if (typeof urn === 'string') parts.push(urn);
    }

    // One row, one line — a newline in a post body would break the format.
    return parts.join(' · ').replace(/\s*\n\s*/g, ' ');
  });
}
