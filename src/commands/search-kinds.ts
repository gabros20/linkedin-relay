// ─── `lnrelay search <kind>` and `lnrelay search-filters <kind>` ──────────────
//
// For companies, groups, events, courses, products, services and schools; see
// engine/search.ts. People and jobs have their own commands, which `search
// people` and `search jobs` hand over to. Each call returns up to 50 results
// and spends the search budget, as does a place looked up by name.

import { parsePeopleFilters } from '../engine/people.ts';
import {
  type Found,
  parseResults,
  SEARCH_PAGE,
  type SearchKindName,
  searchUrl,
} from '../engine/search.ts';
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
import { type Lookup, liveFetch, type PeopleFetch, resolvePlace, shape } from './people.ts';

export interface FindRequest {
  keywords?: string | string[];
  limit: number;
  start?: number;
  /** A place by name, looked up, for the kinds that filter by place. */
  location?: string;
  industry?: string[];
  /** 1st, 2nd, 3rd+. */
  network?: string[];
  /** `key=v1,v2`, by LinkedIn's own names, from `search-filters <kind>`. */
  raw?: string[];
}

/** LinkedIn pages no further than 1000 into any one query. */
const PAGING: Paging = { pageSize: SEARCH_PAGE, max: 1000 };

/** The friendly flags, and the parameter each kind knows them by. */
const FLAGS: Record<
  'location' | 'industry' | 'network',
  Partial<Record<SearchKindName, string>>
> = {
  location: { companies: 'companyHqGeo', services: 'geoUrn' },
  industry: { companies: 'industryCompanyVertical' },
  network: { companies: 'network', services: 'network' },
};

const NETWORK: Record<string, string> = {
  '1st': 'F',
  '2nd': 'S',
  '3rd+': 'O',
  F: 'F',
  S: 'S',
  O: 'O',
};

type Refusal = { ok: false; code: string; message: string; hint?: string };

function paramFor(flag: keyof typeof FLAGS, kind: SearchKindName): string | Refusal {
  const param = FLAGS[flag][kind];
  if (param !== undefined) return param;
  return {
    ok: false,
    code: 'INVALID_INPUT',
    message: `${kind} cannot be filtered by --${flag}`,
    hint: `--${flag} works for: ${Object.keys(FLAGS[flag]).join(', ')}; other filters are in \`search-filters ${kind}\``,
  };
}

/** The request's filters as LinkedIn's parameters; a place is looked up. */
async function paramsOf(
  kind: SearchKindName,
  req: Omit<FindRequest, 'limit'>,
  get: PeopleFetch,
): Promise<{ params: Record<string, string[]>; resolved: Record<string, Lookup> } | Refusal> {
  const params: Record<string, string[]> = {};
  const resolved: Record<string, Lookup> = {};
  if (req.industry !== undefined && req.industry.length > 0) {
    const p = paramFor('industry', kind);
    if (typeof p !== 'string') return p;
    params[p] = req.industry;
  }
  if (req.network !== undefined && req.network.length > 0) {
    const p = paramFor('network', kind);
    if (typeof p !== 'string') return p;
    const codes = req.network.map((n) => NETWORK[n]);
    if (codes.some((c) => c === undefined))
      return { ok: false, code: 'INVALID_INPUT', message: '--network takes 1st, 2nd, 3rd+' };
    params[p] = codes as string[];
  }
  for (const r of req.raw ?? []) {
    const m = r.match(/^([A-Za-z_]+)=(.+)$/);
    if (m?.[1] === undefined || m[2] === undefined)
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `--filter '${r}' is not key=value[,value]`,
      };
    params[m[1]] = m[2]
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  if (req.location !== undefined && req.location.trim() !== '') {
    const p = paramFor('location', kind);
    if (typeof p !== 'string') return p;
    const place = await resolvePlace(get, req.location.trim());
    if ('ok' in place) return place;
    params[p] = [...(params[p] ?? []), place.id];
    resolved.location = place;
  }
  return { params, resolved };
}

function compactFound(f: Matched<Found>): string {
  return line([
    f.id,
    f.name,
    f.subtitle,
    f.detail,
    f.verified ? 'verified' : undefined,
    f.summary !== undefined && f.summary.length > 120 ? `${f.summary.slice(0, 117)}…` : f.summary,
    f.url,
    f.matched !== undefined ? `matched: ${f.matched.join(' + ')}` : undefined,
  ]);
}

export async function runFind(
  kind: SearchKindName,
  req: FindRequest,
  opts: OutputOpts = {},
  fetch?: PeopleFetch,
): Promise<Envelope> {
  const command = `search ${kind}`;
  const sets = keywordSets(req.keywords);
  const anyFilter =
    (req.location ?? '').trim() !== '' ||
    (req.industry?.length ?? 0) > 0 ||
    (req.network?.length ?? 0) > 0 ||
    (req.raw?.length ?? 0) > 0;
  if (sets.length === 0 && !anyFilter) {
    return err(
      command,
      'INVALID_INPUT',
      'give keywords, a filter, or both',
      `lnrelay search ${kind} "<keywords>"`,
    );
  }
  const get = fetch ?? liveFetch(command, opts.quiet === true);
  if (typeof get !== 'function') return get;
  const p = await paramsOf(kind, req, get);
  if ('ok' in p) return err(command, p.code, p.message, p.hint);

  const first = Math.max(0, req.start ?? 0);
  const want = Math.max(1, Math.min(req.limit, PAGING.max - first));
  const fetchPage: PageFetch<Found> = async (keywords, start) => {
    const res = await get(
      searchUrl({ kind, ...(keywords ? { keywords } : {}), params: p.params, start }),
      'search',
    );
    const page = res.ok ? parseResults(res.json) : res;
    if (!page.ok) return page;
    return {
      ok: true,
      items: page.items,
      ...(page.total !== undefined ? { total: page.total } : {}),
      ...(page.claimed !== undefined ? { claimed: page.claimed } : {}),
      unknownTypes: page.unknownTypes,
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
    const f = merged.failure;
    return err(command, f.code, f.message, f.hint);
  }
  const single = sets.length <= 1;
  return ok('search', {
    kind,
    query: { ...(sets.length > 0 ? { keywords: single ? sets[0] : sets } : {}), params: p.params },
    ...(Object.keys(p.resolved).length > 0 ? { resolved: p.resolved } : {}),
    items: shape(merged.rows, opts, compactFound),
    meta: metaOf(command, merged, single, first),
  });
}

export async function runFindFilters(
  kind: SearchKindName,
  req: Omit<FindRequest, 'limit'>,
  opts: OutputOpts = {},
  fetch?: PeopleFetch,
): Promise<Envelope> {
  const command = `search-filters ${kind}`;
  const sets = keywordSets(req.keywords);
  if (sets.length > 1)
    return err(
      command,
      'INVALID_INPUT',
      'search-filters takes one keyword set: its counts belong to that one query',
    );
  const get = fetch ?? liveFetch(command, opts.quiet === true);
  if (typeof get !== 'function') return get;
  const p = await paramsOf(kind, req, get);
  if ('ok' in p) return err(command, p.code, p.message, p.hint);
  const res = await get(
    searchUrl({
      kind,
      ...(sets[0] !== undefined ? { keywords: sets[0] } : {}),
      params: p.params,
      start: 0,
      withFilters: true,
    }),
    'search',
  );
  const parsed = res.ok ? parsePeopleFilters(res.json) : res;
  if (!parsed.ok) return err(command, parsed.code, parsed.message, parsed.hint);
  return ok('search-filters', {
    kind,
    ...(Object.keys(p.resolved).length > 0 ? { resolved: p.resolved } : {}),
    items: shape(parsed.filters, opts, (f) => {
      const how = f.input === 'text' ? 'free text' : 'ids';
      const options = f.options
        .map((o) => `${o.value}=${o.label}${o.count !== undefined ? ` (${o.count})` : ''}`)
        .join(', ');
      return `${f.key} [${how}]${options !== '' ? `: ${options}` : ''}`;
    }),
    meta: { state: 'complete', operation: command, returnedCount: parsed.filters.length },
  });
}
