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

/** LinkedIn serves no further than 1000 into any one job search. */
const PAGING: Paging = { pageSize: PAGE_SIZE, max: 1000 };

type Row = Matched<JobCard & Partial<Omit<JobDetail, keyof JobCard>>>;

function compactJob(j: Row): string {
  return line([
    j.id,
    j.title,
    j.company,
    j.location,
    j.workplace,
    j.listed,
    j.easyApply ? 'easy apply' : undefined,
    j.promoted ? 'promoted' : undefined,
    j.salary,
    j.apply?.url !== undefined ? `apply: ${j.apply.url}` : undefined,
    j.matched !== undefined ? `matched: ${j.matched.join(' + ')}` : undefined,
  ]);
}

function shape<T extends object>(rows: T[], opts: OutputOpts, line: (r: T) => string) {
  if (opts.compact === true) return rows.map(line);
  if (opts.fields !== undefined && opts.fields !== '')
    return project(rows as unknown as Record<string, unknown>[], opts.fields);
  return rows;
}

type Query = Omit<JobQuery, 'start' | 'count'>;

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
  const want = Math.max(1, Math.min(req.limit, PAGING.max - first));
  const base = queryOf(req, selection.filters);
  const fetchPage: PageFetch<JobCard> = async (keywords, start) => {
    const url = jobSearchUrl({
      ...base,
      ...(keywords ? { keywords } : {}),
      start,
      count: PAGE_SIZE,
    });
    const res = await get(url, 'jobSearch');
    const page = res.ok ? parseJobCards(res.json) : res;
    if (!page.ok) return page;
    return {
      ok: true,
      items: page.jobs,
      ...(page.total !== undefined ? { total: page.total } : {}),
      ...(page.location !== undefined ? { resolved: page.location } : {}),
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
  const meta = metaOf('jobs', merged, single, first, {
    unread,
    ...(readStop !== undefined ? { readStop } : {}),
  });

  return ok('jobs', {
    query: { ...base, ...(sets.length > 0 ? { keywords: single ? sets[0] : sets } : {}) },
    ...(merged.resolved !== undefined ? { location: merged.resolved } : {}),
    items: shape(merged.rows as Row[], opts, compactJob),
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
