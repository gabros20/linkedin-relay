// ─── `lnrelay jobs`, `lnrelay job`, `lnrelay job-filters` ─────────────────────
//
// See engine/jobs.ts. Search pages spend the job-search budget, one per 25
// jobs; reading a job spends the job-read budget, one per job. `--details` therefore
// costs a call per result and is opt-in: search wide with cards, then read the
// finalists.

import { createLiveClient } from '../engine/index.ts';
import {
  type JobCard,
  type JobDetail,
  type JobFilterOptions,
  type JobQuery,
  jobDetailUrl,
  jobFilterSelection,
  jobFiltersUrl,
  jobIdOf,
  jobSearchUrl,
  PAGE_SIZE,
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
  keywords?: string;
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

type Row = JobCard & Partial<Omit<JobDetail, keyof JobCard>>;

function compactJob(j: Row): string {
  const parts = [j.id, j.title, j.company, j.location, j.workplace, j.listed];
  if (j.easyApply) parts.push('easy apply');
  if (j.promoted) parts.push('promoted');
  parts.push(j.salary);
  if (j.apply?.url !== undefined) parts.push(`apply: ${j.apply.url}`);
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

function queryOf(req: Omit<JobsRequest, 'limit'>, filters: Record<string, string[]>): Query {
  return {
    ...(req.keywords ? { keywords: req.keywords } : {}),
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
    out.jobs.push(...fresh.slice(0, want - out.jobs.length));
    if (page.jobs.length === 0 || (out.total !== undefined && start + PAGE_SIZE >= out.total)) {
      out.exhausted = true;
      break;
    }
  }
  return out;
}

/** Reads each job into its row. Returns the failure code it stopped on, if any. */
async function addDetails(
  get: JobsFetch,
  jobs: Row[],
  withDescription: boolean,
): Promise<string | undefined> {
  for (const job of jobs) {
    const res = await get(jobDetailUrl(job.id), 'jobRead');
    const detail = res.ok ? parseJobDetail(res.json) : res;
    if (!detail.ok) return detail.code;
    const { description, id: _id, url: _url, ...rest } = detail.job;
    Object.assign(job, rest, withDescription ? { description } : {});
  }
  return undefined;
}

export async function runJobs(
  req: JobsRequest,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const hasQuery = [req.keywords, req.location, req.geoId].some((v) => v !== undefined && v !== '');
  if (!hasQuery) {
    return err(
      'jobs',
      'INVALID_INPUT',
      'give keywords, a location, or both',
      'lnrelay jobs "<keywords>" [--location "<place>" | --geo <id>] [filters]',
    );
  }
  const selection = jobFilterSelection(req.filter ?? {});
  if (!selection.ok)
    return err('jobs', selection.code, selection.message, 'see `lnrelay help jobs`');
  const get = fetch ?? liveFetch('jobs', opts.quiet === true);
  if (typeof get !== 'function') return get;

  const first = Math.max(0, req.start ?? 0);
  const want = Math.max(1, Math.min(req.limit, MAX_RESULTS - first));
  const query = queryOf(req, selection.filters);
  const found = await collect(get, query, first, want);
  if ('ok' in found) return err('jobs', found.code, found.message, found.hint);
  if (req.details === true) {
    const stopped = await addDetails(get, found.jobs, req.description === true);
    found.stoppedBy = found.stoppedBy ?? stopped;
  }

  const { jobs, stoppedBy, exhausted, unknownTypes } = found;
  return ok('jobs', {
    query,
    ...(found.resolved !== undefined ? { location: found.resolved } : {}),
    items: shape(jobs, opts, compactJob),
    meta: {
      state: stoppedBy === undefined && exhausted ? 'complete' : 'partial',
      operation: 'jobs',
      claimedCount: found.total,
      returnedCount: jobs.length,
      start: first,
      next: exhausted ? undefined : first + jobs.length,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
      ...(Object.keys(unknownTypes).length > 0 ? { unknownTypes } : {}),
    },
  });
}

export async function runJob(
  input: string | undefined,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const id = input === undefined ? undefined : jobIdOf(input);
  if (id === undefined) {
    return err('job', 'INVALID_INPUT', 'a job id or job URL is required', 'lnrelay job <id|url>');
  }
  const get = fetch ?? liveFetch('job', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const res = await get(jobDetailUrl(id), 'jobRead');
  if (!res.ok) return err('job', res.code, res.message, res.hint);
  const detail = parseJobDetail(res.json);
  if (!detail.ok) return err('job', detail.code, detail.message, detail.hint);
  return ok('job', detail.job);
}

export async function runJobFilters(
  req: Omit<JobsRequest, 'limit'>,
  opts: OutputOpts = {},
  fetch?: JobsFetch,
): Promise<Envelope> {
  const selection = jobFilterSelection(req.filter ?? {});
  if (!selection.ok) return err('job-filters', selection.code, selection.message);
  const get = fetch ?? liveFetch('job-filters', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const url = jobFiltersUrl({ ...queryOf(req, selection.filters), start: 0, count: PAGE_SIZE });
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
