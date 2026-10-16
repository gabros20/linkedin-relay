// ─── `lnrelay company <name|url|id> [...] [--posts N]` ────────────────────────
//
// A company page in full; see engine/company.ts. Each company is one page
// call. `--posts N` adds its newest posts: the posts search, filtered to posts
// from the company and sorted by date, on the search budget.

import { type Company, companyRefOf, companyUrl, parseCompany } from '../engine/company.ts';
import { createLiveClient } from '../engine/index.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';
import { runPostsSearch } from './posts-search.ts';

type Fetched =
  | { ok: true; raw: string; json?: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted call: a POST when a body is given, a GET otherwise. Injectable for tests. */
export type CompanyFetch = (
  url: string,
  body: unknown,
  spendClass: 'page' | 'search',
) => Promise<Fetched>;

function liveFetch(quiet: boolean): CompanyFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('company', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, body, spendClass) => {
    const r = await client.request({
      url,
      ...(body !== undefined ? { method: 'POST' as const, body } : {}),
      spendClass,
      operation: 'company',
    });
    if (!r.ok) return r;
    return { ok: true, raw: (r.classification as { raw?: string }).raw ?? '', json: r.json };
  };
}

export interface CompanyRequest {
  /** Add this many of the company's newest posts. */
  posts?: number;
}

type Read = Company & { posts?: unknown[]; postsError?: string };

function compactCompany(c: Read): string {
  return line([
    c.id,
    c.name,
    c.industry,
    c.size,
    c.employeesOnLinkedIn !== undefined ? `${c.employeesOnLinkedIn} on LinkedIn` : undefined,
    c.followers !== undefined ? `${c.followers} followers` : undefined,
    c.headquarters,
    c.website,
    c.url,
  ]);
}

/** Its newest posts onto the company; a failure says why on the company. */
async function addPosts(get: CompanyFetch, c: Read, n: number, opts: OutputOpts) {
  const r = await runPostsSearch(
    { fromCompany: [c.id], sort: 'recent', limit: n },
    opts.compact === true ? { compact: true } : {},
    (url, body) => get(url, body, 'search'),
  );
  if (r.ok) c.posts = (r.data as { items: unknown[] }).items;
  else c.postsError = `${r.error.code}: ${r.error.message}`;
}

type Outcome =
  | { ok: true; company: Read }
  | { ok: false; code: string; message: string; hint?: string };

async function readOne(
  get: CompanyFetch,
  input: string,
  req: CompanyRequest,
  opts: OutputOpts,
): Promise<Outcome> {
  const ref = companyRefOf(input) as NonNullable<ReturnType<typeof companyRefOf>>;
  const res = await get(companyUrl(ref), undefined, 'page');
  const parsed = res.ok ? parseCompany(res.json) : res;
  if (!parsed.ok) return parsed;
  const company: Read = parsed.company;
  if (req.posts !== undefined && req.posts > 0) await addPosts(get, company, req.posts, opts);
  return { ok: true, company };
}

export async function runCompany(
  inputs: string[],
  req: CompanyRequest = {},
  opts: OutputOpts = {},
  fetch?: CompanyFetch,
): Promise<Envelope> {
  const given = [...new Set(inputs.map((i) => i.trim()).filter((i) => i !== ''))];
  const bad = given.filter((g) => companyRefOf(g) === undefined);
  if (given.length === 0 || bad.length > 0)
    return err(
      'company',
      'INVALID_INPUT',
      bad.length > 0 ? `not a company: ${bad.join(', ')}` : 'a company is required',
      'lnrelay company <universal-name|company-url|id> [...] [--posts N]',
    );
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;

  if (given.length === 1) {
    const one = await readOne(get, given[0] as string, req, opts);
    return one.ok ? ok('company', one.company) : err('company', one.code, one.message, one.hint);
  }
  const companies: Read[] = [];
  const unread: { company: string; code: string; message: string }[] = [];
  for (const g of given) {
    const one = await readOne(get, g, req, opts);
    // A name and an id can be the same company: it is listed once.
    if (one.ok && !companies.some((c) => c.id === one.company.id)) companies.push(one.company);
    else if (!one.ok) unread.push({ company: g, code: one.code, message: one.message });
  }
  if (companies.length === 0)
    return err('company', unread[0]?.code ?? 'FETCH_FAILED', 'no company could be read');
  return ok('company', {
    items: shape(companies, opts, compactCompany),
    meta: {
      state: unread.length === 0 ? 'complete' : 'partial',
      operation: 'company',
      returnedCount: companies.length,
      ...(unread.length > 0 ? { unread } : {}),
    },
  });
}
