// ─── People search ────────────────────────────────────────────────────────────
//
// Probed 2026-10-14. The people results page itself now renders over SDUI,
// but the Voyager search it grew out of (`voyagerSearchDashClusters`, the
// `search` contract) still answers with every filter the page offers, passed
// as `queryParameters` under LinkedIn's own names:
//
//   network            F, S, O                  1st, 2nd, 3rd+
//   geoUrn             geo ids                  places
//   currentCompany     company ids
//   pastCompany        company ids
//   schoolFilter       school ids               (a school is an organisation id)
//   industry           industry ids
//   profileLanguage    en, de, …
//   serviceCategory    service ids
//   connectionOf       one profile id           their connections
//   followerOf         one profile id           their followers
//   openToVolunteer    true
//   activelyHiringForJobTitles   -100 for any
//   firstName lastName title company schoolFreetext    free text
//
// `includeFiltersInResponse:true` returns every filter with its options' ids
// and live counts. Pages hold up to 50: asking for 100 is answered with an
// EMPTY SUCCESS (total 0, no error), the most dangerous shape a search can
// fail in, so 50 is a constant, not an option. LinkedIn pages at most 1000
// people of any query, whatever it claims to have matched.

import { CONTRACTS } from './contracts.ts';
import { encodeVariables } from './restli.ts';
import type { Failure } from './sdui-form.ts';

/** People per call. 100 returns an empty success; see above. */
export const PEOPLE_PAGE = 50;

type Node = Record<string, unknown>;
const text = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'the people search response changed shape; re-capture it',
});

// ─── The request ──────────────────────────────────────────────────────────────

export interface PeopleQuery {
  keywords?: string;
  /** queryParameters by LinkedIn's own names; resultType is added. */
  params: Record<string, string[]>;
  start: number;
  /** Ask for the filter list with this page. */
  withFilters?: boolean;
  /** Another result type: COMPANIES, SCHOOLS, GROUPS, … (see engine/search.ts). */
  kind?: string;
  /** The My Network hub's lists use their own origin and intent (engine/network.ts). */
  origin?: string;
  intent?: string;
}

export function peopleSearchUrl(q: PeopleQuery): string {
  const c = CONTRACTS.search;
  if (c?.queryId === undefined) throw new Error("the 'search' contract is missing");
  const queryParameters = [
    ...Object.entries(q.params)
      .filter(([, v]) => v.length > 0)
      .map(([key, value]) => ({ key, value })),
    { key: 'resultType', value: [q.kind ?? 'PEOPLE'] },
  ];
  const variables = encodeVariables({
    start: q.start,
    count: PEOPLE_PAGE,
    origin: q.origin ?? 'FACETED_SEARCH',
    query: {
      // An empty `keywords` is answered with a 400: none is sent then.
      keywords: q.keywords === '' ? undefined : q.keywords,
      flagshipSearchIntent: q.intent ?? 'SEARCH_SRP',
      queryParameters,
      includeFiltersInResponse: q.withFilters === true,
    },
  });
  return `${c.path}?variables=${variables}&queryId=${c.queryId}`;
}

// ─── Results ──────────────────────────────────────────────────────────────────

export type Degree = '1st' | '2nd' | '3rd+' | 'out of network';

export interface Person {
  /** The profile id: what `connectionOf`, `followerOf` and `profile` take. */
  id: string;
  name: string;
  headline?: string;
  location?: string;
  degree?: Degree;
  verified?: boolean;
  /** The line under a result: mutual connections, services offered, … */
  insight?: string;
  /** Absent for members LinkedIn will not name to this account. */
  url?: string;
}

const DEGREE: Record<string, Degree> = {
  DISTANCE_1: '1st',
  DISTANCE_2: '2nd',
  DISTANCE_3: '3rd+',
  OUT_OF_NETWORK: 'out of network',
};

const PROFILE_ID = /urn:li:fsd_profile:([A-Za-z0-9_-]+)/;

function insightOf(row: Node): string | undefined {
  const all = Array.isArray(row.insightsResolutionResults)
    ? (row.insightsResolutionResults as Node[])
    : [];
  const lines = all
    .map((i) => text((i.simpleInsight as Node | null)?.title))
    .filter((t): t is string => t !== undefined);
  return text(row.summary) ?? (lines.length > 0 ? lines.join('; ') : undefined);
}

/** `/in/<vanity>/` without the tracking query; a headless search URL is no profile. */
function profileUrl(nav: unknown): string | undefined {
  if (typeof nav !== 'string') return undefined;
  const m = nav.match(/^(https:\/\/www\.linkedin\.com\/in\/[^/?#]+)/);
  return m?.[1] === undefined ? undefined : `${m[1]}/`;
}

function rowToPerson(row: Node): Person | undefined {
  const id = String(row.entityUrn ?? '').match(PROFILE_ID)?.[1];
  const name = text(row.title);
  if (id === undefined || name === undefined) return undefined;
  const tracking = (row.entityCustomTrackingInfo ?? {}) as Node;
  const badge = JSON.stringify(row.badgeIcon ?? null);
  return defined({
    id,
    name,
    headline: text(row.primarySubtitle),
    location: text(row.secondarySubtitle),
    degree: DEGREE[String(tracking.memberDistance)],
    verified: badge.includes('VERIFIED') ? true : undefined,
    insight: insightOf(row),
    url: profileUrl(row.navigationUrl),
  });
}

export interface Clusters {
  elements?: { items?: { item?: Node }[] }[];
  paging?: { total?: unknown; start?: unknown };
  metadata?: Node;
}

export function clustersOf(json: unknown): Clusters | undefined {
  const d = (json as { data?: { data?: Node } } | null)?.data?.data;
  const c = d?.searchDashClustersByAll;
  return c !== null && typeof c === 'object' ? (c as Clusters) : undefined;
}

export interface PeoplePage {
  ok: true;
  people: Person[];
  /** How far LinkedIn will page this query: at most 1000. */
  total?: number;
  /** LinkedIn's own count of matches, often far more than it pages. */
  claimed?: number;
  start: number;
  /** Page furniture dropped on purpose: feedback cards, empty slots. */
  excluded: number;
  unknownTypes: Record<string, number>;
}

/** Items that are page furniture, not results. */
const FURNITURE = new Set([
  '*feedbackCard',
  '*bannerCard',
  '*searchSuggestionCard',
  '*promoCard',
  'simpleText',
  'simpleTextV2',
  '*simpleText',
]);

/** What one cluster item is: a result's urn, furniture, or kinds we do not read. */
function classify(item: Node | undefined): { ref: string } | 'furniture' | string[] {
  const ref = item?.['*entityResult'];
  if (typeof ref === 'string') return { ref };
  const kinds = Object.entries(item ?? {})
    .filter(([k, v]) => v !== null && !k.startsWith('$'))
    .map(([k]) => k);
  return kinds.every((k) => FURNITURE.has(k)) ? 'furniture' : kinds;
}

/**
 * The results in a page, in LinkedIn's order, each mapped by `toRow`; page
 * furniture counted apart; item kinds we do not read counted by name.
 */
export function readItems<T extends { id: string }>(
  c: Clusters,
  included: Node[],
  toRow: (row: Node) => T | undefined,
) {
  const byUrn = new Map(included.map((n) => [n.entityUrn, n]));
  const people: T[] = [];
  const unknownTypes: Record<string, number> = {};
  let excluded = 0;
  let unresolved = 0;
  const items = (c.elements ?? []).flatMap((el) => el.items ?? []);
  for (const { item } of items) {
    const kind = classify(item);
    if (kind === 'furniture') {
      excluded++;
    } else if (Array.isArray(kind)) {
      for (const k of kind) unknownTypes[k] = (unknownTypes[k] ?? 0) + 1;
    } else {
      const row = byUrn.get(kind.ref);
      const person = row === undefined ? undefined : toRow(row);
      if (person === undefined) unresolved++;
      else if (!people.some((p) => p.id === person.id)) people.push(person);
    }
  }
  return { people, unknownTypes, excluded, unresolved };
}

export function parsePeople(json: unknown): PeoplePage | Failure {
  const c = clustersOf(json);
  if (c === undefined || !Array.isArray(c.elements))
    return drift('the people search returned no result list');
  const included = (json as { included?: Node[] }).included ?? [];
  const { people, unknownTypes, excluded, unresolved } = readItems(c, included, rowToPerson);
  const total = typeof c.paging?.total === 'number' ? c.paging.total : undefined;
  const start = typeof c.paging?.start === 'number' ? c.paging.start : 0;
  const claimedRaw = c.metadata?.totalResultCount;
  const claimed = typeof claimedRaw === 'number' ? claimedRaw : total;

  if (unresolved > 0 && people.length === 0)
    return drift(`${unresolved} people were listed but none could be read`);
  if (people.length === 0 && total !== undefined && total > start) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `LinkedIn claims ${total} people but returned none from ${start}`,
      hint: 'a failed fetch, not an empty search; do not report "nobody"',
    };
  }
  return {
    ok: true,
    people,
    ...(total !== undefined ? { total } : {}),
    ...(claimed !== undefined ? { claimed } : {}),
    start,
    excluded,
    unknownTypes,
  };
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface PeopleFilter {
  /** The parameter name `--filter key=…` takes. */
  key: string;
  label: string;
  /** select: pick option ids; text: free text. */
  input: 'select' | 'text';
  /** What a name is looked up as, when the filter takes ids LinkedIn can search for. */
  lookup?: string;
  options: { value: string; label: string; count?: number }[];
}

export function parsePeopleFilters(json: unknown): { ok: true; filters: PeopleFilter[] } | Failure {
  const cluster = clustersOf(json)?.metadata?.primaryFilterCluster as Node | null | undefined;
  if (cluster === null || cluster === undefined)
    return drift('the people search returned no filter list');
  const groups = [
    ...((cluster.secondaryFilterGroups as Node[] | undefined) ?? []),
    ...((cluster.primaryFilterGroups as Node[] | undefined) ?? []),
  ];
  const filters: PeopleFilter[] = [];
  for (const g of groups) {
    for (const f of (g.filters as Node[] | undefined) ?? []) {
      const key = f.parameterName;
      // A navigation filter switches to another kind of search; not a knob.
      if (typeof key !== 'string' || f.renderType === 'NAVIGATION') continue;
      if (filters.some((x) => x.key === key)) continue;
      const values = [
        ...((f.secondaryFilterValues as Node[] | undefined) ?? []),
        ...((f.primaryFilterValues as Node[] | undefined) ?? []),
      ];
      filters.push(
        defined({
          key,
          label: text(f.displayName) ?? key,
          input: f.renderType === 'FREE_TEXT' ? ('text' as const) : ('select' as const),
          lookup: typeof f.typeaheadType === 'string' ? f.typeaheadType : undefined,
          options: values
            .filter((v) => typeof v.value === 'string')
            .map((v) =>
              defined({
                value: v.value as string,
                label: typeof v.displayName === 'string' ? v.displayName : String(v.value),
                count: typeof v.count === 'number' && v.count > 0 ? v.count : undefined,
              }),
            ),
        }),
      );
    }
  }
  if (filters.length === 0) return drift('the people filter list was empty');
  return { ok: true, filters };
}

// ─── Companies and schools by name ────────────────────────────────────────────

/** A company or school search: each hit with the organisation id filters take. */
export function parseOrgHits(
  json: unknown,
): { ok: true; hits: { id: string; name: string }[] } | Failure {
  const c = clustersOf(json);
  if (c === undefined) return drift('the organisation search returned no result list');
  const included = (json as { included?: Node[] }).included ?? [];
  const byUrn = new Map(included.map((n) => [n.entityUrn, n]));
  const hits: { id: string; name: string }[] = [];
  for (const el of c.elements ?? []) {
    for (const { item } of el.items ?? []) {
      const row = byUrn.get(item?.['*entityResult']);
      const id = String(row?.entityUrn ?? '').match(/urn:li:fsd_company:(\d+)/)?.[1];
      const name = text(row?.title);
      if (id !== undefined && name !== undefined && !hits.some((h) => h.id === id))
        hits.push({ id, name });
    }
  }
  return { ok: true, hits };
}

// ─── Friendly filter names ────────────────────────────────────────────────────

export interface PeopleFilterOptions {
  /** 1st, 2nd, 3rd+. */
  network?: string[];
  /** Current company ids. */
  company?: string[];
  pastCompany?: string[];
  school?: string[];
  /** Geo ids. */
  geo?: string[];
  industry?: string[];
  /** Profile language codes: en, de, … */
  language?: string[];
  /** Service category ids. */
  service?: string[];
  /** A profile id or urn: their connections. */
  connectionOf?: string;
  /** A profile id or urn: their followers. */
  followerOf?: string;
  firstName?: string;
  lastName?: string;
  /** Free text matched against the current title. */
  title?: string;
  /** Free text matched against company names, current or past. */
  companyText?: string;
  schoolText?: string;
  openToVolunteer?: boolean;
  /** `key=v1,v2`, by LinkedIn's own parameter names, from `people-filters`. */
  raw?: string[];
}

const NETWORK: Record<string, string> = {
  '1st': 'F',
  '1': 'F',
  '2nd': 'S',
  '2': 'S',
  '3rd+': 'O',
  '3rd': 'O',
  '3': 'O',
};

const profileId = (v: string) => v.match(/^(?:urn:li:fsd_profile:)?(AC[A-Za-z0-9_-]{10,})$/)?.[1];

class Refused extends Error {}

function selection(o: PeopleFilterOptions): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  if (o.network !== undefined && o.network.length > 0) {
    params.network = o.network.map((n) => {
      const code = NETWORK[n.toLowerCase()] ?? (['F', 'S', 'O'].includes(n) ? n : undefined);
      if (code === undefined) throw new Refused(`--network '${n}' is not one of: 1st, 2nd, 3rd+`);
      return code;
    });
  }
  const ids: [string[] | undefined, string][] = [
    [o.company, 'currentCompany'],
    [o.pastCompany, 'pastCompany'],
    [o.school, 'schoolFilter'],
    [o.geo, 'geoUrn'],
    [o.industry, 'industry'],
    [o.language, 'profileLanguage'],
    [o.service, 'serviceCategory'],
  ];
  for (const [given, param] of ids)
    if (given !== undefined && given.length > 0) params[param] = given;
  for (const [given, param, flag] of [
    [o.connectionOf, 'connectionOf', '--connection-of'],
    [o.followerOf, 'followerOf', '--follower-of'],
  ] as const) {
    if (given === undefined) continue;
    const id = profileId(given.trim());
    if (id === undefined)
      throw new Refused(`${flag} takes a profile id (ACo…) or urn, from a people row's \`id\``);
    params[param] = [id];
  }
  const texts: [string | undefined, string][] = [
    [o.firstName, 'firstName'],
    [o.lastName, 'lastName'],
    [o.title, 'title'],
    [o.companyText, 'company'],
    [o.schoolText, 'schoolFreetext'],
  ];
  for (const [given, param] of texts)
    if (given !== undefined && given.trim() !== '') params[param] = [given.trim()];
  if (o.openToVolunteer === true) params.openToVolunteer = ['true'];
  for (const r of o.raw ?? []) {
    const m = r.match(/^([A-Za-z_]+)=(.+)$/);
    if (m?.[1] === undefined || m[2] === undefined)
      throw new Refused(`--filter '${r}' is not key=value[,value]`);
    params[m[1]] = m[2]
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return params;
}

export function peopleFilterSelection(
  o: PeopleFilterOptions,
): { ok: true; params: Record<string, string[]> } | Failure {
  try {
    return { ok: true, params: selection(o) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: 'INVALID_INPUT', message: e.message };
    throw e;
  }
}
