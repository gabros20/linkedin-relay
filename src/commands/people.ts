// ─── `lnrelay people`, `lnrelay people-filters` ───────────────────────────────
//
// See engine/people.ts. A people search call returns up to 50 people and
// spends the search budget; so does each name lookup (a company or school
// name to its id, a place to its geo id). Several keyword sets are searched
// and merged by profile id, as `jobs` does (commands/paged.ts).

import { createLiveClient } from '../engine/index.ts';
import { jobSearchUrl, parseJobCards } from '../engine/jobs.ts';
import {
  PEOPLE_PAGE,
  type PeopleFilterOptions,
  type Person,
  parseOrgHits,
  parsePeople,
  parsePeopleFilters,
  peopleFilterSelection,
  peopleSearchUrl,
} from '../engine/people.ts';
import type { Failure } from '../engine/sdui-form.ts';
import { loadSession } from '../engine/session.ts';
import { project } from '../format.ts';
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

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. */
export type PeopleFetch = (url: string, spendClass: 'search') => Promise<Fetched>;

export function liveFetch(command: string, quiet: boolean): PeopleFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err(command, 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: command });
    return r.ok ? { ok: true, json: r.json } : r;
  };
}

export interface PeopleRequest {
  /** One keyword set, or several: each its own search, merged by profile id. */
  keywords?: string | string[];
  /** A place by name, looked up to its geo id. */
  location?: string;
  limit: number;
  start?: number;
  /** Company and school entries may be names; they are looked up to ids. */
  filter?: PeopleFilterOptions;
}

/** LinkedIn pages no further than 1000 people into any one query. */
const PAGING: Paging = { pageSize: PEOPLE_PAGE, max: 1000 };

type Row = Matched<Person>;

function compactPerson(p: Row): string {
  return line([
    p.id,
    p.name,
    p.headline,
    p.location,
    p.degree,
    p.verified ? 'verified' : undefined,
    p.insight,
    p.url,
    p.matched !== undefined ? `matched: ${p.matched.join(' + ')}` : undefined,
  ]);
}

export function shape<T extends object>(rows: T[], opts: OutputOpts, toLine: (r: T) => string) {
  if (opts.compact === true) return rows.map(toLine);
  if (opts.fields !== undefined && opts.fields !== '')
    return project(rows as unknown as Record<string, unknown>[], opts.fields);
  return rows;
}

// ─── Names to ids ─────────────────────────────────────────────────────────────

export interface Lookup {
  given: string;
  id: string;
  name: string;
}

const isId = (v: string) => /^\d+$/.test(v);

/** Organisation names to ids, by LinkedIn's own company or school search: the top hit. */
async function resolveOrgs(
  get: PeopleFetch,
  given: string[] | undefined,
  kind: 'COMPANIES' | 'SCHOOLS',
): Promise<{ ids: string[]; found: Lookup[] } | Failure | undefined> {
  if (given === undefined || given.length === 0) return undefined;
  const ids: string[] = [];
  const found: Lookup[] = [];
  for (const v of given) {
    if (isId(v)) {
      ids.push(v);
      continue;
    }
    const res = await get(peopleSearchUrl({ keywords: v, params: {}, start: 0, kind }), 'search');
    const hits = res.ok ? parseOrgHits(res.json) : res;
    if (!hits.ok) return hits;
    const top = hits.hits[0];
    if (top === undefined) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `no ${kind === 'SCHOOLS' ? 'school' : 'company'} on LinkedIn matches "${v}"`,
        hint: 'check the spelling, or pass its id (from `people-filters`)',
      };
    }
    ids.push(top.id);
    found.push({ given: v, id: top.id, name: top.name });
  }
  return { ids, found };
}

/** A place name to a geo id, the way the job search resolves a typed location. */
export async function resolvePlace(get: PeopleFetch, place: string): Promise<Lookup | Failure> {
  const res = await get(
    jobSearchUrl({ location: place, filters: {}, start: 0, count: 1 }),
    'search',
  );
  const page = res.ok ? parseJobCards(res.json) : res;
  if (!page.ok) return page;
  if (page.location === undefined) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `LinkedIn could not place "${place}"`,
      hint: 'try a city, region or country, or pass --geo <id> (ids are in `people-filters`)',
    };
  }
  return { given: place, id: page.location.geoId, name: page.location.name };
}

/** Looks up every name in the request; ids pass straight through. */
async function resolveNames(
  get: PeopleFetch,
  req: Omit<PeopleRequest, 'limit'>,
): Promise<{ filter: PeopleFilterOptions; resolved: Record<string, unknown> } | Failure> {
  const filter: PeopleFilterOptions = { ...(req.filter ?? {}) };
  const resolved: Record<string, unknown> = {};
  const orgs: ['company' | 'pastCompany' | 'school', 'COMPANIES' | 'SCHOOLS'][] = [
    ['company', 'COMPANIES'],
    ['pastCompany', 'COMPANIES'],
    ['school', 'SCHOOLS'],
  ];
  for (const [key, kind] of orgs) {
    const r = await resolveOrgs(get, filter[key], kind);
    if (r === undefined) continue;
    if ('ok' in r) return r;
    filter[key] = r.ids;
    if (r.found.length > 0) resolved[key] = r.found;
  }
  if (req.location !== undefined && req.location.trim() !== '') {
    const place = await resolvePlace(get, req.location.trim());
    if ('ok' in place) return place;
    filter.geo = [...(filter.geo ?? []), place.id];
    resolved.location = place;
  }
  return { filter, resolved };
}

/** Filters this tool also takes by name, and the flag that does it. */
const BY_NAME: Record<string, string> = {
  currentCompany: 'ids, or names via --company',
  pastCompany: 'ids, or names via --past-company',
  schoolFilter: 'ids, or names via --school',
  geoUrn: 'ids via --geo, or a place via --location',
};

// ─── Runners ──────────────────────────────────────────────────────────────────

export async function runPeople(
  req: PeopleRequest,
  opts: OutputOpts = {},
  fetch?: PeopleFetch,
): Promise<Envelope> {
  const sets = keywordSets(req.keywords);
  const named = peopleFilterSelection(req.filter ?? {});
  if (!named.ok) return err('people', named.code, named.message, 'see `lnrelay help people`');
  const hasFilter = Object.keys(named.params).length > 0 || (req.location ?? '').trim() !== '';
  if (sets.length === 0 && !hasFilter) {
    return err(
      'people',
      'INVALID_INPUT',
      'give keywords, a filter, or both',
      'lnrelay people "<keywords>" ["<more>" ...] [--company "<name|id>"] [--location "<place>"] [filters]',
    );
  }
  const get = fetch ?? liveFetch('people', opts.quiet === true);
  if (typeof get !== 'function') return get;

  const names = await resolveNames(get, req);
  if ('ok' in names) return err('people', names.code, names.message, names.hint);
  const selection = peopleFilterSelection(names.filter);
  if (!selection.ok) return err('people', selection.code, selection.message);
  const params = selection.params;

  const first = Math.max(0, req.start ?? 0);
  const want = Math.max(1, Math.min(req.limit, PAGING.max - first));
  const fetchPage: PageFetch<Person> = async (keywords, start) => {
    const res = await get(
      peopleSearchUrl({ ...(keywords ? { keywords } : {}), params, start }),
      'search',
    );
    const page = res.ok ? parsePeople(res.json) : res;
    if (!page.ok) return page;
    return {
      ok: true,
      items: page.people,
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
    return err('people', f.code, f.message, f.hint);
  }

  const single = sets.length <= 1;
  return ok('people', {
    query: { ...(sets.length > 0 ? { keywords: single ? sets[0] : sets } : {}), params },
    ...(Object.keys(names.resolved).length > 0 ? { resolved: names.resolved } : {}),
    items: shape(merged.rows, opts, compactPerson),
    meta: metaOf('people', merged, single, first),
  });
}

export async function runPeopleFilters(
  req: Omit<PeopleRequest, 'limit'>,
  opts: OutputOpts = {},
  fetch?: PeopleFetch,
): Promise<Envelope> {
  const sets = keywordSets(req.keywords);
  if (sets.length > 1) {
    return err(
      'people-filters',
      'INVALID_INPUT',
      'people-filters takes one keyword set: its counts belong to that one query',
      'lnrelay people-filters "<keywords>" [filters]',
    );
  }
  const get = fetch ?? liveFetch('people-filters', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const names = await resolveNames(get, req);
  if ('ok' in names) return err('people-filters', names.code, names.message, names.hint);
  const selection = peopleFilterSelection(names.filter);
  if (!selection.ok) return err('people-filters', selection.code, selection.message);

  const url = peopleSearchUrl({
    ...(sets[0] !== undefined ? { keywords: sets[0] } : {}),
    params: selection.params,
    start: 0,
    withFilters: true,
  });
  const res = await get(url, 'search');
  const parsed = res.ok ? parsePeopleFilters(res.json) : res;
  if (!parsed.ok) return err('people-filters', parsed.code, parsed.message, parsed.hint);
  return ok('people-filters', {
    ...(Object.keys(names.resolved).length > 0 ? { resolved: names.resolved } : {}),
    items: shape(parsed.filters, opts, (f) => {
      const how = f.input === 'text' ? 'free text' : (BY_NAME[f.key] ?? 'ids');
      const options = f.options
        .map((o) => `${o.value}=${o.label}${o.count !== undefined ? ` (${o.count})` : ''}`)
        .join(', ');
      return `${f.key} [${how}]${options !== '' ? `: ${options}` : ''}`;
    }),
    meta: { state: 'complete', operation: 'people-filters', returnedCount: parsed.filters.length },
  });
}
