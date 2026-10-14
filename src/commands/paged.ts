// ─── Paged searches over several keyword sets, merged by id ───────────────────
//
// Shared by `jobs` and `people`. Each keyword set is searched on its own,
// paged to the limit, and the results are merged by id: a row found by several
// sets comes back once, naming them in `matched`, most-matched first. A set
// that fails is reported and the others are kept; only all failing is an error.

import type { Failure } from '../engine/sdui-form.ts';

/** One page of a search, as a source parsed it. */
export interface Paged<T extends { id: string }> {
  ok: true;
  items: T[];
  /** How far LinkedIn will page this query. */
  total?: number;
  /** LinkedIn's own count of matches, when it is more than it will page. */
  claimed?: number;
  /** What the source resolved part of the query to (a place, say). */
  resolved?: unknown;
  unknownTypes: Record<string, number>;
}

export type PageFetch<T extends { id: string }> = (
  keywords: string | undefined,
  start: number,
) => Promise<Paged<T> | Failure>;

export interface Paging {
  pageSize: number;
  /** LinkedIn serves no further than this into any one query. */
  max: number;
}

export type Matched<T> = T & {
  /** With several keyword sets: the ones that found this row, in the order given. */
  matched?: string[];
};

/** The keyword sets, trimmed, each once (case-insensitively), in the order given. */
export function keywordSets(keywords: string | string[] | undefined): string[] {
  const given = keywords === undefined ? [] : Array.isArray(keywords) ? keywords : [keywords];
  const out: string[] = [];
  for (const k of given.map((g) => g.trim())) {
    if (k !== '' && !out.some((o) => o.toLowerCase() === k.toLowerCase())) out.push(k);
  }
  return out;
}

interface Collected<T> {
  items: T[];
  total?: number;
  claimed?: number;
  resolved?: unknown;
  stoppedBy?: string;
  exhausted: boolean;
  unknownTypes: Record<string, number>;
}

function addCounts(into: Record<string, number>, from: Record<string, number>) {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

/** Pages from `first` until `want` rows, the end of the results, or a failure. */
async function collect<T extends { id: string }>(
  fetchPage: PageFetch<T>,
  keywords: string | undefined,
  first: number,
  want: number,
  paging: Paging,
): Promise<Collected<T> | Failure> {
  const out: Collected<T> = { items: [], exhausted: false, unknownTypes: {} };
  for (let start = first; out.items.length < want && start < paging.max; start += paging.pageSize) {
    const page = await fetchPage(keywords, start);
    if (!page.ok) {
      // The first page failing is a failure; a later one leaves a partial list.
      if (out.items.length === 0) return page;
      out.stoppedBy = page.code;
      break;
    }
    out.total = page.total ?? out.total;
    out.claimed = page.claimed ?? out.claimed;
    out.resolved = page.resolved ?? out.resolved;
    addCounts(out.unknownTypes, page.unknownTypes);
    const fresh = page.items.filter((j) => !out.items.some((x) => x.id === j.id));
    const room = want - out.items.length;
    out.items.push(...fresh.slice(0, room));
    // The limit cut this page short: there is more, even on the last page.
    if (fresh.length > room) break;
    if (
      page.items.length === 0 ||
      (out.total !== undefined && start + paging.pageSize >= out.total)
    ) {
      out.exhausted = true;
      break;
    }
  }
  return out;
}

/** One keyword set's search, as `meta.searches` reports it. */
export interface SearchReport {
  keywords?: string;
  claimedCount?: number;
  returnedCount: number;
  state: 'complete' | 'partial' | 'failed';
  next?: number;
  /** LinkedIn claims more than it will serve; narrow the query to see the rest. */
  servedLimit?: number;
  stoppedBy?: string;
}

function reportOf<T>(
  keywords: string | undefined,
  found: Collected<T>,
  first: number,
): SearchReport {
  const capped =
    found.exhausted &&
    found.claimed !== undefined &&
    found.total !== undefined &&
    found.claimed > found.total;
  const report: SearchReport = {
    ...(keywords !== undefined ? { keywords } : {}),
    claimedCount: found.claimed ?? found.total,
    returnedCount: found.items.length,
    state: found.stoppedBy === undefined && found.exhausted && !capped ? 'complete' : 'partial',
  };
  if (!found.exhausted) report.next = first + found.items.length;
  if (capped) report.servedLimit = found.total;
  if (found.stoppedBy !== undefined) report.stoppedBy = found.stoppedBy;
  return report;
}

export interface Merged<T> {
  rows: Matched<T>[];
  searches: SearchReport[];
  /** Rows dropped because an earlier keyword set had already found them. */
  duplicates: number;
  resolved?: unknown;
  unknownTypes: Record<string, number>;
  failure?: Failure;
}

/** Adds one search's rows; a row already found gains this keyword set instead. */
function mergeInto<T extends { id: string }>(
  out: Merged<T>,
  byId: Map<string, Matched<T>>,
  items: T[],
  keywords?: string,
) {
  for (const item of items) {
    const seen = byId.get(item.id);
    if (seen !== undefined) {
      out.duplicates++;
      if (keywords !== undefined) seen.matched?.push(keywords);
      continue;
    }
    const row: Matched<T> = keywords !== undefined ? { ...item, matched: [keywords] } : item;
    byId.set(item.id, row);
    out.rows.push(row);
  }
}

/**
 * Runs each keyword set's search and merges the results by id. With several
 * sets, each row says which found it and the most-found come first; ties keep
 * the order LinkedIn ranked them in.
 */
export async function searchAll<T extends { id: string }>(
  fetchPage: PageFetch<T>,
  sets: (string | undefined)[],
  first: number,
  want: number,
  paging: Paging,
): Promise<Merged<T>> {
  const out: Merged<T> = { rows: [], searches: [], duplicates: 0, unknownTypes: {} };
  const byId = new Map<string, Matched<T>>();
  for (const keywords of sets) {
    const found = await collect(fetchPage, keywords, first, want, paging);
    if ('ok' in found) {
      out.failure = out.failure ?? found;
      out.searches.push({
        ...(keywords !== undefined ? { keywords } : {}),
        returnedCount: 0,
        state: 'failed',
        stoppedBy: found.code,
      });
      continue;
    }
    out.searches.push(reportOf(keywords, found, first));
    out.resolved = out.resolved ?? found.resolved;
    addCounts(out.unknownTypes, found.unknownTypes);
    mergeInto(out, byId, found.items, sets.length > 1 ? keywords : undefined);
  }
  if (sets.length > 1) out.rows.sort((x, y) => (y.matched?.length ?? 0) - (x.matched?.length ?? 0));
  return out;
}

/**
 * The envelope's `meta`. One keyword set keeps the plain shape with its own
 * paging; several add `searches` (each set's report) and `duplicates`.
 */
export function metaOf<T>(
  operation: string,
  merged: Merged<T>,
  single: boolean,
  first: number,
  extra: { unread?: number; readStop?: string } = {},
): Record<string, unknown> {
  const { unread = 0, readStop } = extra;
  const searched = merged.searches;
  const allComplete = searched.every((r) => r.state === 'complete');
  const meta: Record<string, unknown> = {
    state: allComplete && unread === 0 && readStop === undefined ? 'complete' : 'partial',
    operation,
  };
  if (single) {
    const { keywords: _k, state: _s, ...report } = searched[0] as SearchReport;
    Object.assign(meta, report, { start: first });
    if (readStop !== undefined) meta.stoppedBy = meta.stoppedBy ?? readStop;
  } else {
    Object.assign(meta, {
      returnedCount: merged.rows.length,
      duplicates: merged.duplicates,
      start: first,
      searches: searched,
      ...(readStop !== undefined ? { stoppedBy: readStop } : {}),
    });
  }
  if (unread > 0) meta.unread = unread;
  if (Object.keys(merged.unknownTypes).length > 0) meta.unknownTypes = merged.unknownTypes;
  return meta;
}

/** One flat line from the given parts; a bar inside a value would read as a column break. */
export function line(parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => p !== undefined && p !== '')
    .map((p) => p.replaceAll(' | ', ' / '))
    .join(' | ');
}
