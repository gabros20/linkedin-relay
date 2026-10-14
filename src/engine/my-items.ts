// ─── My items: saved posts, learning, the job tracker ─────────────────────────
//
// Captured 2026-10-14. Each list is the Voyager search (the `search`
// contract) with a My-items intent and no keywords:
//
//   SEARCH_MY_ITEMS_SAVED_POSTS    posts the owner saved
//   SEARCH_MY_ITEMS_LEARNING       their LinkedIn Learning courses
//   SEARCH_MY_ITEMS_JOB_SEEKER     the job tracker, one stage at a time:
//                                  queryParameters cardType = SAVED, IN_PROGRESS,
//                                  APPLIED, INTERVIEW, ARCHIVED
//
// The stage names are the job tracker page's own (`?stage=archived`, …),
// uppercased. LinkedIn does not validate them: a wrong name answers with no
// jobs, not an error. ARCHIVED was verified with the owner's 6 archived jobs;
// the other four agreed with the page's own counts (all 0) — which a wrong
// name would also give. Pages hold 10; saved posts page with a token.

import { CONTRACTS } from './contracts.ts';
import { type Clusters, clustersOf, readItems } from './people.ts';
import { encodeVariables } from './restli.ts';
import type { Failure } from './sdui-form.ts';

export const ITEMS = {
  posts: 'SEARCH_MY_ITEMS_SAVED_POSTS',
  learning: 'SEARCH_MY_ITEMS_LEARNING',
  jobs: 'SEARCH_MY_ITEMS_JOB_SEEKER',
} as const;

export type ItemList = keyof typeof ITEMS;

export const STAGES = {
  saved: 'SAVED',
  'in-progress': 'IN_PROGRESS',
  applied: 'APPLIED',
  interview: 'INTERVIEW',
  archived: 'ARCHIVED',
} as const;

export type Stage = keyof typeof STAGES;

export const ITEMS_PAGE = 10;

export function itemsUrl(
  list: ItemList,
  q: { start: number; stage?: Stage; token?: string },
): string {
  const c = CONTRACTS.search;
  if (c?.queryId === undefined) throw new Error("the 'search' contract is missing");
  const variables = encodeVariables({
    start: q.start,
    paginationToken: q.token,
    query: {
      flagshipSearchIntent: ITEMS[list],
      queryParameters:
        q.stage !== undefined ? [{ key: 'cardType', value: [STAGES[q.stage]] }] : undefined,
    },
  });
  return `${c.path}?variables=${variables}&queryId=${c.queryId}`;
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface SavedPost {
  /** The post's urn: what `post` and `reactions` take. */
  id: string;
  url: string;
  author?: string;
  authorHeadline?: string;
  /** When, as LinkedIn shows it ("5d"). */
  posted?: string;
  text?: string;
}

export interface Course {
  id: string;
  name: string;
  length?: string;
  /** Instructor and release date, as LinkedIn writes them. */
  detail?: string;
  /** "6m left", or completion. */
  progress?: string;
  url?: string;
}

export interface TrackedJob {
  /** The job id: what `job` takes. */
  id: string;
  title: string;
  company?: string;
  location?: string;
  workplace?: 'on-site' | 'remote' | 'hybrid';
  stage?: Stage;
  /** A line LinkedIn adds, such as "No longer accepting applications". */
  note?: string;
  url: string;
}

type Node = Record<string, unknown>;
type Item = SavedPost | Course | TrackedJob;

const text = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim().replace(/\s+/g, ' ') : undefined;
};
const inner = (urn: unknown) => String(urn ?? '').match(/\((urn:li:[A-Za-z_]+:[^,)]+)/)?.[1];
const clean = (url: unknown) =>
  typeof url === 'string' && url.startsWith('https://') ? url.split('?')[0] : undefined;
const insight = (row: Node) =>
  (Array.isArray(row.insightsResolutionResults) ? (row.insightsResolutionResults as Node[]) : [])
    .map((i) => text((i.simpleInsight as Node | null)?.title))
    .find((t) => t !== undefined);

function defined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) if (obj[k] === undefined) delete obj[k];
  return obj;
}

const WORKPLACE: Record<string, TrackedJob['workplace']> = {
  remote: 'remote',
  hybrid: 'hybrid',
  'on-site': 'on-site',
};

function postRow(row: Node): SavedPost | undefined {
  const id = inner(row.entityUrn);
  if (id === undefined || !/^urn:li:(activity|ugcPost|share):/.test(id)) return undefined;
  const posted = text(row.secondarySubtitle)?.replace(/\s*•\s*$/, '');
  return defined({
    id,
    url: `https://www.linkedin.com/feed/update/${id}/`,
    author: text(row.title),
    authorHeadline: text(row.primarySubtitle),
    posted,
    text: text(row.summary),
  });
}

function courseRow(row: Node): Course | undefined {
  const id = inner(row.entityUrn)?.split(':').pop();
  const name = text(row.title);
  if (id === undefined || name === undefined) return undefined;
  return defined({
    id,
    name,
    length: text(row.primarySubtitle),
    detail: text(row.secondarySubtitle),
    progress: text(row.summary),
    url: clean(row.navigationUrl),
  });
}

function jobRow(row: Node, stage?: Stage): TrackedJob | undefined {
  const id = inner(row.entityUrn)?.split(':').pop();
  const title = text(row.title);
  if (id === undefined || title === undefined) return undefined;
  const place = text(row.secondarySubtitle);
  const m = place?.match(/^(.*?)\s*\(([^()]+)\)$/);
  const workplace = m?.[2] === undefined ? undefined : WORKPLACE[m[2].toLowerCase()];
  return defined({
    id,
    title,
    company: text(row.primarySubtitle),
    location: workplace !== undefined ? m?.[1] : place,
    workplace,
    stage,
    note: insight(row),
    url: `https://www.linkedin.com/jobs/view/${id}/`,
  });
}

export function parseItems(
  list: ItemList,
  json: unknown,
  stage?: Stage,
): { ok: true; items: Item[]; total?: number; token?: string } | Failure {
  const c: Clusters | undefined = clustersOf(json);
  if (c === undefined || !Array.isArray(c.elements))
    return { ok: false, code: 'SCHEMA_DRIFT', message: 'the My items list was missing' };
  const included = (json as { included?: Node[] }).included ?? [];
  const toRow = (row: Node) =>
    list === 'posts' ? postRow(row) : list === 'learning' ? courseRow(row) : jobRow(row, stage);
  const { people: items, unresolved } = readItems(
    c,
    included,
    toRow as (row: Node) => (Item & { id: string }) | undefined,
  );
  if (unresolved > 0 && items.length === 0)
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `${unresolved} items were listed but none could be read`,
    };
  const total = typeof c.paging?.total === 'number' ? c.paging.total : undefined;
  const token = c.metadata?.paginationToken;
  return {
    ok: true,
    items,
    ...(total !== undefined ? { total } : {}),
    ...(typeof token === 'string' && token !== '' ? { token } : {}),
  };
}
