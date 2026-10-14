// ─── `lnrelay jobs`, `lnrelay job`, `lnrelay job-filters` ─────────────────────
//
// See engine/jobs.ts. A search call returns up to 100 jobs and spends the
// job-search budget; a read returns up to 100 jobs in full (a batch get) and
// spends the job-read budget. `--details` is opt-in because full descriptions
// are large: search wide with cards, then read the finalists.

import { createLiveClient } from '../engine/index.ts';
import {
  BATCH_SIZE,
  type JobCard,
  type JobDetail,
  type JobFilterOptions,
  type JobQuery,
  jobBatchUrl,
  jobDetailUrl,
  jobFilterSelection,
  jobFiltersUrl,
  jobIdOf,
  jobSearchUrl,
  PAGE_SIZE,
  parseJobBatch,
  parseJobCards,
  parseJobDetail,
  parseJobFilters,
} from '../engine/jobs.ts';
import type { Failure } from '../engine/sdui-form.ts';
import { loadSession } from '../engine/session.ts';
import { project } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. */
export type JobsFetch = (url: string, spendClass: 'jobSearch' | 'jobRead') => Promise<Fetched>;

function liveFetch(command: string, quiet: boolean): JobsFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err(command, 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: command });
    return r.ok ? { ok: true, json: r.json } : r;
  };
}

export interface JobsRequest {
  /** One keyword set, or several: each its own search, merged by job id. */
  keywords?: string | string[];
  location?: string;
  geoId?: string;
  limit: number;
  start?: number;
  /** Read each job too: apply link, applicants, employment type. */
  details?: boolean;
  /** With `details`, keep each job's full description. */
  description?: boolean;
  filter?: JobFilterOptions;
}

/** LinkedIn serves no further than this into any one search. */
const MAX_RESULTS = 1000;

type Row = JobCard &
  Partial<Omit<JobDetail, keyof JobCard>> & {
    /** With several keyword sets: the ones that found this job, in the order given. */
    matched?: string[];
  };

function compactJob(j: Row): string {
  const parts = [j.id, j.title, j.company, j.location, j.workplace, j.listed];
  if (j.easyApply) parts.push('easy apply');
  if (j.promoted) parts.push('promoted');
  parts.push(j.salary);
  if (j.apply?.url !== undefined) parts.push(`apply: ${j.apply.url}`);
  if (j.matched !== undefined) parts.push(`matched: ${j.matched.join(' + ')}`);
  // A bar inside a title would read as a column break.
  return parts
    .filter((p): p is string => p !== undefined && p !== '')
    .map((p) => p.replaceAll(' | ', ' / '))
    .join(' | ');
}

function shape<T extends object>(rows: T[], opts: OutputOpts, line: (r: T) => string) {
  if (opts.compact === true) return rows.map(line);
  if (opts.fields !== undefined && opts.fields !== '')
    return project(rows as unknown as Record<string, unknown>[], opts.fields);
  return rows;
}

type Query = Omit<JobQuery, 'start' | 'count'>;

/** The keyword sets, trimmed, each once (case-insensitively), in the order given. */
function keywordSets(keywords: JobsRequest['keywords']): string[] {
  const given = keywords === undefined ? [] : Array.isArray(keywords) ? keywords : [keywords];
  const out: string[] = [];
  for (const k of given.map((g) => g.trim())) {
    if (k !== '' && !out.some((o) => o.toLowerCase() === k.toLowerCase())) out.push(k);
  }
  return out;
}

function queryOf(
  req: Omit<JobsRequest, 'limit' | 'keywords'>,
  filters: Record<string, string[]>,
  keywords?: string,
): Query {
  return {
    ...(keywords ? { keywords } : {}),
    ...(req.location ? { location: req.location } : {}),
    ...(req.geoId ? { geoId: req.geoId } : {}),
    filters,
  };
}

interface Collected {
  jobs: Row[];
  total?: number;
  resolved?: { geoId: string; name: string };
  stoppedBy?: string;
  exhausted: boolean;
  unknownTypes: Record<string, number>;
}

/** Pages from `first` until `want` jobs, the end of the results, or a failure. */
async function collect(
  get: JobsFetch,
  query: Query,
  first: number,
  want: number,
): Promise<Collected | Failure> {
  const out: Collected = { jobs: [], exhausted: false, unknownTypes: {} };
  for (let start = first; out.jobs.length < want && start < MAX_RESULTS; start += PAGE_SIZE) {
    const res = await get(jobSearchUrl({ ...query, start, count: PAGE_SIZE }), 'jobSearch');
    const page = res.ok ? parseJobCards(res.json) : res;
    if (!page.ok) {
      // The first page failing is a failure; a later one leaves a partial list.
      if (out.jobs.length === 0) return page;
      out.stoppedBy = page.code;
      break;
    }
    out.total = page.total ?? out.total;
    out.resolved = page.location ?? out.resolved;
    for (const [k, n] of Object.entries(page.unknownTypes))
      out.unknownTypes[k] = (out.unknownTypes[k] ?? 0) + n;
    const fresh = page.jobs.filter((j) => !out.jobs.some((x) => x.id === j.id));
    const room = want - out.jobs.length;
    out.jobs.push(...fresh.slice(0, room));
    // The limit cut this page short: there is more, even on the last page.
    if (fresh.length > room) break;
    if (page.jobs.length === 0 || (out.total !== undefined && start + PAGE_SIZE >= out.total)) {
      out.exhausted = true;
      break;
    }
  }
  return out;
}

/** Reads `ids` in batches. Stops at the first failed batch, keeping the rest. */
async function readJobs(
  get: JobsFetch,
  ids: string[],
): Promise<{ jobs: Map<string, JobDetail>; stoppedBy?: string }> {
  const jobs = new Map<string, JobDetail>();
  for (let at = 0; at < ids.length; at += BATCH_SIZE) {
    const res = await get(jobBatchUrl(ids.slice(at, at + BATCH_SIZE)), 'jobRead');
    const batch = res.ok ? parseJobBatch(res.json) : res;
    if (!batch.ok) return { jobs, stoppedBy: batch.code };
    for (const job of batch.jobs) if (ids.includes(job.id)) jobs.set(job.id, job);
  }
  return { jobs };
}

/** Reads every row in full and merges it in. Returns how many stayed unread. */
async function addDetails(
  get: JobsFetch,
  rows: Row[],
  withDescription: boolean,
): Promise<{ unread: number; stoppedBy?: string }> {
  const read = await readJobs(
    get,
    rows.map((r) => r.id),
  );
  for (const row of rows) {
    const detail = read.jobs.get(row.id);
    if (detail === undefined) continue;
    const { description, id: _id, url: _url, ...rest } = detail;
    Object.assign(row, rest, withDescription ? { description } : {});
  }
  const unread = rows.filter((r) => !read.jobs.has(r.id)).length;
  return read.stoppedBy === undefined ? { unread } : { unread, stoppedBy: read.stoppedBy };
}

/** One keyword set's search, as `meta.searches` reports it. */
interface SearchReport {
  keywords?: string;
  claimedCount?: number;
  returnedCount: number;
  state: 'complete' | 'partial' | 'failed';
  next?: number;
  stoppedBy?: string;
}

function reportOf(keywords: string | undefined, found: Collected, first: number): SearchReport {
  const report: SearchReport = {
    ...(keywords !== undefined ? { keywords } : {}),
    claimedCount: found.total,
    returnedCount: found.jobs.length,
    state: found.stoppedBy === undefined && found.exhausted ? 'complete' : 'partial',
  };
  if (!found.exhausted) report.next = first + found.jobs.length;
  if (found.stoppedBy !== undefined) report.stoppedBy = found.stoppedBy;
  return report;
}

interface Merged {
  rows: Row[];
  searches: SearchReport[];
  /** Rows dropped because an earlier keyword set had already found the job. */
  duplicates: number;
  resolved?: { geoId: string; name: string };
  unknownTypes: Record<string, number>;
  failure?: Failure;
}

/** Adds one search's jobs; a job already found gains this keyword set instead. */
function mergeInto(out: Merged, byId: Map<string, Row>, jobs: Row[], keywords?: string) {
  for (const job of jobs) {
    const seen = byId.get(job.id);
    if (seen !== undefined) {
      out.duplicates++;
      if (keywords !== undefined) seen.matched?.push(keywords);
      continue;
    }
    const row: Row = keywords !== undefined ? { ...job, matched: [keywords] } : job;
    byId.set(job.id, row);
    out.rows.push(row);
  }
}

/**
 * Runs each keyword set's search and merges the results by job id. With
 * several sets, each row says which found it and the most-found come first,
 * so an agent reading top-down meets the likeliest fits before the rest.
 */
async function searchAll(
  get: JobsFetch,
  sets: (string | undefined)[],
  base: Query,
  first: number,
  want: number,
): Promise<Merged> {
  const out: Merged = { rows: [], searches: [], duplicates: 0, unknownTypes: {} };
  const byId = new Map<string, Row>();
  for (const keywords of sets) {
    const found = await collect(get, { ...base, ...(keywords ? { keywords } : {}) }, first, want);
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
    for (const [k, n] of Object.entries(found.unknownTypes))
      out.unknownTypes[k] = (out.unknownTypes[k] ?? 0) + n;
    mergeInto(out, byId, found.jobs, sets.length > 1 ? keywords : undefined);
  }
  // Stable: ties keep the order LinkedIn ranked them in.
  if (sets.length > 1) out.rows.sort((x, y) => (y.matched?.length ?? 0) - (x.matched?.length ?? 0));
  return out;
}

function metaOf(
  merged: Merged,
  single: boolean,
  first: number,
  unread: number,
  readStop: string | undefined,
): Record<string, unknown> {
  const searched = merged.searches;
  const allComplete = searched.every((r) => r.state === 'complete');
  const meta: Record<string, unknown> = {
    state: allComplete && unread === 0 && readStop === undefined ? 'complete' : 'partial',
    operation: 'jobs',
  };
  if (single) {
    // One search: the plain shape, with its own paging.
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

export async function runJobs(
  req: JobsRequest,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const sets = keywordSets(req.keywords);
  const hasQuery =
    sets.length > 0 || [req.location, req.geoId].some((v) => v !== undefined && v !== '');
  if (!hasQuery) {
    return err(
      'jobs',
      'INVALID_INPUT',
      'give keywords, a location, or both',
      'lnrelay jobs "<keywords>" ["<more keywords>" ...] [--location "<place>" | --geo <id>] [filters]',
    );
  }
  const selection = jobFilterSelection(req.filter ?? {});
  if (!selection.ok)
    return err('jobs', selection.code, selection.message, 'see `lnrelay help jobs`');
  const get = fetch ?? liveFetch('jobs', opts.quiet === true);
  if (typeof get !== 'function') return get;

  const first = Math.max(0, req.start ?? 0);
  const want = Math.max(1, Math.min(req.limit, MAX_RESULTS - first));
  const base = queryOf(req, selection.filters);
  const merged = await searchAll(get, sets.length > 0 ? sets : [undefined], base, first, want);
  if (merged.rows.length === 0 && merged.failure !== undefined) {
    const f = merged.failure;
    return err('jobs', f.code, f.message, f.hint);
  }

  let unread = 0;
  let readStop: string | undefined;
  if (req.details === true) {
    const added = await addDetails(get, merged.rows, req.description === true);
    unread = added.unread;
    readStop = added.stoppedBy;
  }

  const single = sets.length <= 1;
  const meta = metaOf(merged, single, first, unread, readStop);

  return ok('jobs', {
    query: { ...base, ...(sets.length > 0 ? { keywords: single ? sets[0] : sets } : {}) },
    ...(merged.resolved !== undefined ? { location: merged.resolved } : {}),
    items: shape(merged.rows, opts, compactJob),
    meta,
  });
}

/** One job by its own endpoint; several in batches of 100, one call each. */
export async function runJob(
  input: string | string[] | undefined,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const given = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const ids = [...new Set(given.map(jobIdOf))];
  if (ids.length === 0 || ids.some((id) => id === undefined)) {
    const bad = given.filter((g) => jobIdOf(g) === undefined);
    return err(
      'job',
      'INVALID_INPUT',
      bad.length > 0 ? `not a job id or URL: ${bad.join(', ')}` : 'a job id or job URL is required',
      'lnrelay job <id|url> [<id|url> ...]',
    );
  }
  const get = fetch ?? liveFetch('job', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const wanted = ids as string[];

  if (wanted.length === 1) {
    const res = await get(jobDetailUrl(wanted[0] as string), 'jobRead');
    if (!res.ok) return err('job', res.code, res.message, res.hint);
    const detail = parseJobDetail(res.json);
    if (!detail.ok) return err('job', detail.code, detail.message, detail.hint);
    return ok('job', detail.job);
  }

  const read = await readJobs(get, wanted);
  if (read.jobs.size === 0 && read.stoppedBy !== undefined)
    return err('job', read.stoppedBy, 'no job could be read');
  const unread = wanted.filter((id) => !read.jobs.has(id));
  const jobs = wanted.flatMap((id) => read.jobs.get(id) ?? []);
  return ok('job', {
    items: shape(jobs, opts, (j) =>
      compactJob({ ...j, easyApply: j.apply?.type === 'easy-apply', promoted: false }),
    ),
    meta: {
      state: unread.length === 0 ? 'complete' : 'partial',
      operation: 'job',
      returnedCount: jobs.length,
      ...(unread.length > 0 ? { unread } : {}),
      ...(read.stoppedBy !== undefined ? { stoppedBy: read.stoppedBy } : {}),
    },
  });
}

export async function runJobFilters(
  req: Omit<JobsRequest, 'limit'>,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const sets = keywordSets(req.keywords);
  if (sets.length > 1) {
    return err(
      'job-filters',
      'INVALID_INPUT',
      'job-filters takes one keyword set: its counts belong to that one query',
      'lnrelay job-filters "<keywords>" [filters]',
    );
  }
  const selection = jobFilterSelection(req.filter ?? {});
  if (!selection.ok) return err('job-filters', selection.code, selection.message);
  const get = fetch ?? liveFetch('job-filters', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const url = jobFiltersUrl({
    ...queryOf(req, selection.filters, sets[0]),
    start: 0,
    count: PAGE_SIZE,
  });
  const res = await get(url, 'jobSearch');
  const parsed = res.ok ? parseJobFilters(res.json) : res;
  if (!parsed.ok) return err('job-filters', parsed.code, parsed.message, parsed.hint);
  return ok('job-filters', {
    items: shape(
      parsed.filters,
      opts,
      (f) =>
        `${f.key}: ${f.options.map((o) => `${o.value}=${o.label}${o.count !== undefined ? ` (${o.count})` : ''}`).join(', ')}`,
    ),
    meta: { state: 'complete', operation: 'job-filters', returnedCount: parsed.filters.length },
  });
}
