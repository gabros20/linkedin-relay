// ─── `lnrelay search posts` ───────────────────────────────────────────────────
//
// See engine/posts.ts. Each call returns up to 20 posts and spends the search
// budget, as does each company given by name. The stream is heavy (about half
// a megabyte a post), so ask for the depth you need.

import { createLiveClient } from '../engine/index.ts';
import { parseOrgHits, peopleSearchUrl } from '../engine/people.ts';
import {
  POSTS_PAGE,
  POSTS_URL,
  type PostFilter,
  type PostHit,
  parsePosts,
  postsPagerBody,
} from '../engine/posts.ts';
import type { Failure } from '../engine/sdui-form.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import {
  keywordSets,
  line,
  type Matched,
  metaOf,
  type PageFetch,
  type Paging,
  searchAll,
} from './paged.ts';
import { type Lookup, shape } from './people.ts';

type Fetched =
  | { ok: true; raw: string; json?: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted call: the pager when a body is given, a GET otherwise. Injectable for tests. */
export type PostsFetch = (url: string, body: unknown, spendClass: 'search') => Promise<Fetched>;

function liveFetch(quiet: boolean): PostsFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('search posts', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, body, spendClass) => {
    const r = await client.request({
      url,
      ...(body !== undefined ? { method: 'POST' as const, body } : {}),
      spendClass,
      operation: 'search-posts',
    });
    if (!r.ok) return r;
    return { ok: true, raw: (r.classification as { raw?: string }).raw ?? '', json: r.json };
  };
}

export interface PostsRequest {
  keywords?: string | string[];
  limit: number;
  start?: number;
  /** recent | relevant */
  sort?: string;
  /** 24h | week | month */
  posted?: string;
  /** videos, images, jobs, live, articles, documents */
  type?: string[];
  /** 1st, me */
  postedBy?: string[];
  /** Profile ids. */
  from?: string[];
  mentions?: string[];
  /** Company names or ids. */
  fromCompany?: string[];
  mentionsCompany?: string[];
  authorCompany?: string[];
  authorIndustry?: string[];
  authorTitle?: string;
  /** `key=v1,v2`, by the pager's own names. */
  raw?: string[];
}

/** LinkedIn's posts pager: no total is given, so paging ends on an empty or short page. */
const PAGING: Paging = { pageSize: POSTS_PAGE, max: 1000 };

const CHOICES: Record<string, { param: PostFilter; values: Record<string, string> }> = {
  sort: { param: 'sortBy', values: { recent: 'date_posted', relevant: 'relevance' } },
  posted: {
    param: 'datePosted',
    values: { '24h': 'past-24h', day: 'past-24h', week: 'past-week', month: 'past-month' },
  },
  type: {
    param: 'contentType',
    values: {
      videos: 'videos',
      images: 'photos',
      photos: 'photos',
      jobs: 'jobs',
      live: 'liveVideos',
      articles: 'articles',
      documents: 'documents',
    },
  },
  postedBy: { param: 'postedBy', values: { '1st': 'first', me: 'me', first: 'first' } },
};

type Refusal = { ok: false; code: string; message: string; hint?: string };

function choose(name: keyof typeof CHOICES, given: string[]): string[] | Refusal {
  const { values } = CHOICES[name] as (typeof CHOICES)[string];
  const out: string[] = [];
  for (const g of given) {
    const v = values[g.toLowerCase()];
    if (v === undefined)
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `--${name} '${g}' is not one of: ${Object.keys(values).join(', ')}`,
      };
    out.push(v);
  }
  return out;
}

/** Company names to ids by LinkedIn's company search: the top hit, reported. */
async function companies(
  get: PostsFetch,
  given: string[],
): Promise<{ ids: string[]; found: Lookup[] } | Failure> {
  const ids: string[] = [];
  const found: Lookup[] = [];
  for (const v of given) {
    if (/^\d+$/.test(v)) {
      ids.push(v);
      continue;
    }
    const res = await get(
      peopleSearchUrl({ keywords: v, params: {}, start: 0, kind: 'COMPANIES' }),
      undefined,
      'search',
    );
    const hits = res.ok ? parseOrgHits(res.json) : res;
    if (!hits.ok) return hits;
    const top = hits.hits[0];
    if (top === undefined)
      return { ok: false, code: 'INVALID_INPUT', message: `no company on LinkedIn matches "${v}"` };
    ids.push(top.id);
    found.push({ given: v, id: top.id, name: top.name });
  }
  return { ids, found };
}

function choices(req: PostsRequest): Partial<Record<PostFilter, string[]>> | Refusal {
  const filters: Partial<Record<PostFilter, string[]>> = {};
  const picks: [keyof typeof CHOICES, string[] | undefined][] = [
    ['sort', req.sort !== undefined ? [req.sort] : undefined],
    ['posted', req.posted !== undefined ? [req.posted] : undefined],
    ['type', req.type],
    ['postedBy', req.postedBy],
  ];
  for (const [name, given] of picks) {
    if (given === undefined || given.length === 0) continue;
    const v = choose(name, given);
    if (!Array.isArray(v)) return v;
    filters[(CHOICES[name] as (typeof CHOICES)[string]).param] = v;
  }
  if (req.from !== undefined && req.from.length > 0) filters.fromMember = req.from;
  if (req.mentions !== undefined && req.mentions.length > 0) filters.mentionsMember = req.mentions;
  if (req.authorIndustry !== undefined && req.authorIndustry.length > 0)
    filters.authorIndustry = req.authorIndustry;
  if (req.authorTitle !== undefined && req.authorTitle.trim() !== '')
    filters.authorJobTitle = [req.authorTitle.trim()];
  for (const r of req.raw ?? []) {
    const m = r.match(/^([A-Za-z_]+)=(.+)$/);
    if (m?.[1] === undefined || m[2] === undefined)
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `--filter '${r}' is not key=value[,value]`,
      };
    filters[m[1] as PostFilter] = m[2]
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return filters;
}

/** The request as pager filters; company names are looked up. */
async function filtersOf(req: PostsRequest, get: PostsFetch) {
  const filters = choices(req);
  if ('ok' in filters) return filters;
  const resolved: Record<string, Lookup[]> = {};
  const orgs: [keyof PostsRequest, PostFilter][] = [
    ['fromCompany', 'fromOrganization'],
    ['mentionsCompany', 'mentionsOrganization'],
    ['authorCompany', 'authorCompany'],
  ];
  for (const [key, param] of orgs) {
    const given = req[key] as string[] | undefined;
    if (given === undefined || given.length === 0) continue;
    const r = await companies(get, given);
    if ('ok' in r) return r;
    filters[param] = r.ids;
    if (r.found.length > 0) resolved[key] = r.found;
  }
  return { filters, resolved };
}

function compactPost(p: Matched<PostHit>): string {
  const counts = [
    p.reactions !== undefined ? `${p.reactions} reactions` : undefined,
    p.comments !== undefined ? `${p.comments} comments` : undefined,
    p.reposts !== undefined ? `${p.reposts} reposts` : undefined,
  ].filter(Boolean);
  const text = p.text?.replace(/\s+/g, ' ');
  return line([
    p.id,
    p.author,
    p.posted,
    counts.length > 0 ? counts.join(' · ') : undefined,
    text !== undefined && text.length > 160 ? `${text.slice(0, 157)}…` : text,
    p.url,
    p.matched !== undefined ? `matched: ${p.matched.join(' + ')}` : undefined,
  ]);
}

export async function runPostsSearch(
  req: PostsRequest,
  opts: OutputOpts = {},
  fetch?: PostsFetch,
): Promise<Envelope> {
  const command = 'search posts';
  const sets = keywordSets(req.keywords);
  const early = choices(req);
  if ('ok' in early) return err(command, early.code, early.message, early.hint);
  const anyFilter =
    Object.keys(early).length > 0 ||
    [req.fromCompany, req.mentionsCompany, req.authorCompany].some((v) => (v?.length ?? 0) > 0);
  if (sets.length === 0 && !anyFilter)
    return err(
      command,
      'INVALID_INPUT',
      'give keywords, a filter, or both',
      'lnrelay search posts "<keywords>"',
    );
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;
  const f = await filtersOf(req, get);
  if ('ok' in f) return err(command, f.code, f.message, f.hint);

  const first = Math.max(0, req.start ?? 0);
  const want = Math.max(1, Math.min(req.limit, PAGING.max - first));
  const fetchPage: PageFetch<PostHit> = async (keywords, start) => {
    const body = postsPagerBody({ ...(keywords ? { keywords } : {}), filters: f.filters, start });
    const res = await get(POSTS_URL, body, 'search');
    const page = res.ok ? parsePosts(res.raw) : res;
    if (!page.ok) return page;
    const cards = page.posts.length + page.unread;
    const unknownTypes: Record<string, number> =
      page.unread > 0 ? { unreadPostCards: page.unread } : {};
    return {
      ok: true,
      items: page.posts,
      // No total is given: a short page is the last.
      ...(cards < POSTS_PAGE ? { total: start + cards } : {}),
      unknownTypes,
    };
  };
  const merged = await searchAll(
    fetchPage,
    sets.length > 0 ? sets : [undefined],
    first,
    want,
    PAGING,
  );
  if (merged.rows.length === 0 && merged.failure !== undefined) {
    const fail = merged.failure;
    return err(command, fail.code, fail.message, fail.hint);
  }
  const single = sets.length <= 1;
  return ok('search', {
    kind: 'posts',
    query: {
      ...(sets.length > 0 ? { keywords: single ? sets[0] : sets } : {}),
      filters: f.filters,
    },
    ...(Object.keys(f.resolved).length > 0 ? { resolved: f.resolved } : {}),
    items: shape(merged.rows, opts, compactPost),
    meta: metaOf(command, merged, single, first),
  });
}
