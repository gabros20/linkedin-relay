// ─── Searching posts ──────────────────────────────────────────────────────────
//
// Captured 2026-10-14. Posts are the one search kind the Voyager search no
// longer serves: asked for `resultType:CONTENT` it claims hundreds of matches
// and returns none, at any page size. The results page loads them from an SDUI
// pager, `contentSearchResults`, whose payload takes the keywords, the start,
// the count and every filter as a list under the filter panel's own names.
//
// The answer is an RSC stream, and a heavy one (about half a megabyte a post).
// A post is not one record in it. Each post's top row (`feed-full-update`)
// holds the card's skeleton; its author, text and counts sit in other rows,
// reached through `$L<id>` references, and the numbers live in the stream's
// model state, keyed by the post's content urn:
//
//   ReactionType_<TYPE>_<urn>   commentCount-<urn>   repostCount-<urn>
//
// So a post is read by following its top row's references and reading each
// part from the rows it reaches. The content urn (a ugcPost, share or group
// post) is the post's id: /feed/update/<urn>/ opens it and `post` reads its
// comments. Labels such as the time ("5 hours ago") come in the viewer's
// LinkedIn language and are kept as shown.

import type { Failure } from './sdui-form.ts';
import { balanced, readModel } from './sdui-form.ts';

export const POSTS_PAGER = 'com.linkedin.sdui.search.contentSearchResults';
const SCREEN = 'com.linkedin.sdui.flagshipnav.search.SearchResultsContent';
export const POSTS_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${POSTS_PAGER}`;

/** Posts per call. The page asks for 3; 20 came back whole (2026-10-14). */
export const POSTS_PAGE = 20;

/** The filters the pager takes, each a list, as the filter panel names them. */
export const POST_FILTERS = [
  'sortBy',
  'postedBy',
  'datePosted',
  'contentType',
  'fromMember',
  'mentionsOrganization',
  'mentionsMember',
  'fromOrganization',
  'authorCompany',
  'authorIndustry',
  'authorJobTitle',
] as const;

export type PostFilter = (typeof POST_FILTERS)[number];

export interface PostsQuery {
  keywords?: string;
  filters: Partial<Record<PostFilter, string[]>>;
  start: number;
  count?: number;
}

/** The pager request, shaped as the results page sends it. */
export function postsPagerBody(q: PostsQuery) {
  const payload: Record<string, unknown> = {
    startIndex: q.start,
    keywords: q.keywords ?? '',
    count: q.count ?? POSTS_PAGE,
  };
  for (const f of POST_FILTERS) payload[f] = q.filters[f] ?? [];
  payload.spellCheckEnabled = true;
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    pagerId: POSTS_PAGER,
    clientArguments: { ...args, states: [], screenId: SCREEN, knownTemplateIds: [] },
    paginationRequest: {
      $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: POSTS_PAGER,
      retryCount: 0,
      requestedArguments: args,
    },
  };
}

// ─── The stream's rows ────────────────────────────────────────────────────────

/** An RSC stream split into its `<hex id>:<payload>` rows. */
export class Rows {
  readonly byId = new Map<string, string>();
  private readonly starts: { id: string; at: number }[] = [];

  constructor(readonly stream: string) {
    for (const m of stream.matchAll(/(?:^|\n)([0-9a-f]+):/g)) {
      const at = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0);
      this.starts.push({ id: m[1] as string, at });
    }
    for (let i = 0; i < this.starts.length; i++) {
      const s = this.starts[i] as { id: string; at: number };
      const end = this.starts[i + 1]?.at ?? stream.length;
      this.byId.set(s.id, stream.slice(s.at + s.id.length + 1, end));
    }
  }

  /** The row a stream position falls in. */
  at(pos: number): string | undefined {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as { at: number }).at <= pos) lo = mid;
      else hi = mid - 1;
    }
    return this.starts[lo]?.id;
  }

  /** Every row reachable from `id` through references, nearest first. */
  reach(id: string, limit = 400): string[] {
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0 && seen.size < limit) {
      const row = this.byId.get(queue.shift() as string) ?? '';
      for (const m of row.matchAll(/"\$L?([0-9a-f]+)(?::[^"]*)?"/g)) {
        const ref = m[1] as string;
        if (!seen.has(ref) && this.byId.has(ref)) {
          seen.add(ref);
          queue.push(ref);
        }
      }
    }
    return [...seen];
  }
}

// ─── Reading a post ───────────────────────────────────────────────────────────

export interface PostHit {
  /** The content urn: ugcPost, share or groupPost. */
  id: string;
  url: string;
  author?: string;
  authorHeadline?: string;
  authorUrl?: string;
  /** When, as LinkedIn shows it, in the viewer's language ("5h", "5 órája"). */
  posted?: string;
  text?: string;
  reactions?: number;
  comments?: number;
  reposts?: number;
}

/**
 * The visible strings under a node, in order. An element is `["$", type,
 * key, props]`: only its props' children are text; references are skipped.
 */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (!v.startsWith('$')) out.push(v);
  } else if (Array.isArray(v)) {
    if (v[0] === '$' && v[1] === 'br') out.push('\n');
    else if (v[0] === '$') strings(v[3], out);
    else for (const x of v) strings(x, out);
  } else if (v !== null && typeof v === 'object' && 'children' in v) {
    strings((v as { children: unknown }).children, out);
  }
  return out;
}

/** Every text block in a row from `from` on, as the reader would see it. */
function texts(row: string, from = 0): string[] {
  const part = row.slice(Math.max(0, from));
  const out: string[] = [];
  for (const m of part.matchAll(/"textProps":/g)) {
    const obj = balanced(part, part.indexOf('{', m.index ?? 0));
    if (obj === null) continue;
    const t = strings(JSON.parse(obj)).join('').trim();
    if (t !== '') out.push(t);
  }
  return out;
}

const jsonString = (s: string) => JSON.parse(`"${s}"`) as string;

const REACTIONS = [
  'LIKE',
  'PRAISE',
  'EMPATHY',
  'INTEREST',
  'APPRECIATION',
  'ENTERTAINMENT',
  'SUPER_LIKE',
];

interface Read {
  post: PostHit | undefined;
  /** The rows the post was read from, and the path to them. */
  used: string[];
}

/** The first row under `from` holding `view`, and that row's own subtree. */
function part(
  rows: Rows,
  from: string[],
  view: string,
  depth = 60,
): { row: string; under: string[] } | undefined {
  const id = from.find((r) => rows.byId.get(r)?.includes(`"viewName":"${view}"`));
  return id === undefined ? undefined : { row: id, under: rows.reach(id, depth) };
}

/** The first row in `ids` that `find` reads something from, and what it read. */
function firstIn<T>(rows: Rows, ids: string[], find: (row: string) => T | undefined) {
  for (const id of ids) {
    const v = find(rows.byId.get(id) ?? '');
    if (v !== undefined) return { id, v };
  }
  return undefined;
}

function authorOf(rows: Rows, actor: { under: string[] } | undefined) {
  if (actor === undefined) return { fields: {}, used: [] as string[] };
  const state = (key: string) => (row: string) => {
    const m = row.match(new RegExp(`"${key}"[^]*?"stringValue":"((?:[^"\\\\]|\\\\.)*)"`));
    return m?.[1] === undefined ? undefined : jsonString(m[1]);
  };
  // Person links come relative ("/in/<vanity>/"), page links absolute.
  const link = firstIn(
    rows,
    actor.under,
    (row) =>
      row.match(
        /"(?:https:\/\/www\.linkedin\.com)?(\/(?:in|company|school|showcase)\/[^"?/]+)/,
      )?.[1],
  );
  const person = firstIn(rows, actor.under, state('profile_name_loading_state'));
  const headline = firstIn(rows, actor.under, state('profile_headline_loading_state'));
  // A company or page has no profile state: its name is the visible text
  // the author link's own label starts with.
  const page =
    person !== undefined
      ? undefined
      : firstIn(rows, actor.under, (row) => {
          const labels = [...row.matchAll(/"aria-label":"((?:[^"\\]|\\.)+)"/g)].map((m) =>
            jsonString(m[1] as string).trim(),
          );
          // The label may carry a badge after the name ("Microsoft Premium").
          return texts(row).find((t) => labels.some((l) => l === t || l.startsWith(`${t} `)));
        });
  const named = person ?? page;
  return {
    fields: {
      ...(named !== undefined ? { author: named.v.trim() } : {}),
      ...(headline !== undefined ? { authorHeadline: headline.v } : {}),
      ...(link !== undefined ? { authorUrl: `https://www.linkedin.com${link.v}/` } : {}),
    },
    used: [link?.id, named?.id, headline?.id].filter((x): x is string => x !== undefined),
  };
}

function readPost(rows: Rows, top: string, model: ReturnType<typeof readModel>): Read {
  const reach = rows.reach(top);
  const counted = reach.find((r) => /commentCount-urn:li:\w+:\d+/.test(rows.byId.get(r) ?? ''));
  const id =
    counted === undefined
      ? undefined
      : rows.byId.get(counted)?.match(/commentCount-(urn:li:\w+:\d+)/)?.[1];
  if (id === undefined) return { post: undefined, used: [top] };

  const actor = part(rows, reach, 'feed-actor');
  const author = authorOf(rows, actor);
  const sub = part(rows, reach, 'feed-actor-sub-description', 4);
  const commentary = part(rows, reach, 'feed-commentary');
  const n = (k: string) => {
    const v = (model?.get(k) as { value?: unknown } | undefined)?.value;
    return typeof v === 'number' ? v : undefined;
  };
  const byType = REACTIONS.map((r) => n(`ReactionType_${r}_${id}`));
  const reactions = byType.some((v) => v !== undefined)
    ? byType.reduce<number>((a, v) => a + (v ?? 0), 0)
    : undefined;
  const subRow = sub === undefined ? '' : (rows.byId.get(sub.row) ?? '');
  const posted =
    sub === undefined
      ? undefined
      : texts(subRow, subRow.indexOf('"viewName":"feed-actor-sub-description"'))[0];
  const said =
    commentary === undefined ? undefined : firstIn(rows, commentary.under, (row) => texts(row)[0]);
  const text = said?.v;

  const post: PostHit = {
    id,
    url: `https://www.linkedin.com/feed/update/${id}/`,
    ...author.fields,
    ...(posted !== undefined ? { posted } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
  };
  const comments = n(`commentCount-${id}`);
  const reposts = n(`repostCount-${id}`);
  if (comments !== undefined) post.comments = comments;
  if (reposts !== undefined) post.reposts = reposts;
  const parts = [actor?.row, sub?.row, commentary?.row, said?.id].filter(
    (x): x is string => x !== undefined,
  );
  const used = [top, counted as string, ...author.used, ...parts];
  return { post, used };
}

export interface PostsPage {
  ok: true;
  posts: PostHit[];
  /** Cards that looked like posts but carried no content urn. */
  unread: number;
  /** The rows the posts were read from: what a fixture needs to keep. */
  used: Set<string>;
}

export function parsePosts(stream: string): PostsPage | Failure {
  if (
    !stream.includes(POSTS_PAGER) &&
    !stream.includes('"isPartialPage"') &&
    !stream.includes('feed-full-update')
  ) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the posts search page could not be read',
      hint: 'the posts search response changed shape; re-capture it',
    };
  }
  const rows = new Rows(stream);
  const model = readModel(stream);
  const posts: PostHit[] = [];
  const used = new Set<string>();
  const tops = new Set<string>();
  let unread = 0;
  for (const m of stream.matchAll(/"viewName":"feed-full-update"/g)) {
    const top = rows.at(m.index ?? 0);
    if (top === undefined || tops.has(top)) continue;
    tops.add(top);
    const r = readPost(rows, top, model);
    for (const u of r.used) used.add(u);
    if (r.post === undefined) unread++;
    else if (!posts.some((p) => p.id === r.post?.id)) posts.push(r.post);
  }
  if (unread > 0 && posts.length === 0) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `${unread} posts were listed but none could be read`,
      hint: 'the posts search response changed shape; re-capture it',
    };
  }
  return { ok: true, posts, unread, used };
}
