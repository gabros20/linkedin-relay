// ─── Searching companies, groups, events, courses, products, services, schools ─
//
// Probed 2026-10-14. Every kind in the search box beside people, jobs and
// posts comes back from the same Voyager search as people (engine/people.ts),
// one `resultType` each, in the same row shape: a title, a subtitle, a second
// line and a summary, whose meaning depends on the kind:
//
//   companies  industry • HQ        followers                 id: company
//   groups     members              —                         id: group
//   events     when                 where • organiser         id: event
//   courses    length               instructor • released     id: course
//   products   category by vendor   —                         id: product page
//   services   the provider's headline, place, service       id: profile
//   schools    place                students and alumni       id: school (organisation)
//
// So one parser serves them all and keeps LinkedIn's lines as they are rather
// than guessing at fields inside them. Pages hold 50 (events return more than
// asked); LinkedIn pages at most 1000 of any query. Filters differ per kind and
// come back with `includeFiltersInResponse`, as for people.

import { type Clusters, clustersOf, PEOPLE_PAGE, peopleSearchUrl, readItems } from './people.ts';
import type { Failure } from './sdui-form.ts';

/** The CLI's name for each kind, and LinkedIn's result type. */
export const SEARCH_KINDS = {
  companies: 'COMPANIES',
  groups: 'GROUPS',
  events: 'EVENTS',
  courses: 'LEARNING',
  products: 'PRODUCTS',
  services: 'SERVICES',
  schools: 'SCHOOLS',
} as const;

export type SearchKindName = keyof typeof SEARCH_KINDS;

export const SEARCH_PAGE = PEOPLE_PAGE;

export interface SearchQuery {
  kind: SearchKindName;
  keywords?: string;
  params: Record<string, string[]>;
  start: number;
  withFilters?: boolean;
}

export function searchUrl(q: SearchQuery): string {
  return peopleSearchUrl({
    ...(q.keywords !== undefined ? { keywords: q.keywords } : {}),
    params: q.params,
    start: q.start,
    ...(q.withFilters === true ? { withFilters: true } : {}),
    kind: SEARCH_KINDS[q.kind],
  });
}

/** One result, in LinkedIn's own lines; see the table above for what each holds. */
export interface Found {
  /** The entity's own id: a company, group, event, course, product page or profile. */
  id: string;
  name: string;
  subtitle?: string;
  detail?: string;
  summary?: string;
  url?: string;
  verified?: boolean;
}

type Node = Record<string, unknown>;

const text = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim().replace(/\s+/g, ' ') : undefined;
};

/** The id inside `urn:li:fsd_entityResultViewModel:(<urn>,SEARCH_SRP,DEFAULT)`. */
function idOf(entityUrn: unknown): string | undefined {
  const inner = String(entityUrn ?? '').match(/\((urn:li:[A-Za-z_]+:[^,)]+)/)?.[1];
  return inner?.split(':').pop();
}

/** The page's own address, without per-viewer tracking or claim tokens. */
function cleanUrl(nav: unknown): string | undefined {
  if (typeof nav !== 'string' || !nav.startsWith('https://')) return undefined;
  return nav.split('?')[0];
}

function rowToFound(row: Node): Found | undefined {
  const id = idOf(row.entityUrn);
  const name = text(row.title);
  if (id === undefined || name === undefined) return undefined;
  const found: Found = { id, name };
  const fields: [keyof Found, string | undefined][] = [
    ['subtitle', text(row.primarySubtitle)],
    ['detail', text(row.secondarySubtitle)],
    ['summary', text(row.summary)],
    ['url', cleanUrl(row.navigationUrl)],
  ];
  for (const [k, v] of fields)
    if (v !== undefined) (found as unknown as Record<string, string>)[k] = v;
  if (JSON.stringify(row.badgeIcon ?? null).includes('VERIFIED')) found.verified = true;
  return found;
}

export interface ResultsPage {
  ok: true;
  items: Found[];
  total?: number;
  claimed?: number;
  start: number;
  excluded: number;
  unknownTypes: Record<string, number>;
}

const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'the search response changed shape; re-capture it',
});

export function parseResults(json: unknown): ResultsPage | Failure {
  const c: Clusters | undefined = clustersOf(json);
  if (c === undefined || !Array.isArray(c.elements))
    return drift('the search returned no result list');
  const included = (json as { included?: Node[] }).included ?? [];
  const { people: items, unknownTypes, excluded, unresolved } = readItems(c, included, rowToFound);
  const total = typeof c.paging?.total === 'number' ? c.paging.total : undefined;
  const start = typeof c.paging?.start === 'number' ? c.paging.start : 0;
  const claimedRaw = c.metadata?.totalResultCount;
  const claimed = typeof claimedRaw === 'number' ? claimedRaw : total;
  if (unresolved > 0 && items.length === 0)
    return drift(`${unresolved} results were listed but none could be read`);
  if (items.length === 0 && total !== undefined && total > start) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `LinkedIn claims ${total} results but returned none from ${start}`,
      hint: 'a failed fetch, not an empty search; do not report "none"',
    };
  }
  return {
    ok: true,
    items,
    ...(total !== undefined ? { total } : {}),
    ...(claimed !== undefined ? { claimed } : {}),
    start,
    excluded,
    unknownTypes,
  };
}
