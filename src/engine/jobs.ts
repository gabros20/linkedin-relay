// ─── Job search ───────────────────────────────────────────────────────────────
//
// Captured 2026-10-14. The jobs page now opens LinkedIn's "AI job search", an
// SDUI screen that answers in an RSC stream and silently drops filters it does
// not support (it lost the location and experience level of the URL we gave
// it). The classic search behind /jobs/search/ is still served as plain
// Voyager JSON, takes every filter, and is what this module speaks:
//
//   jobCards    voyagerJobsDashJobCards?q=jobSearch       25 cards a page
//   filters     voyagerJobsDashSearchFilterClustersResource  every filter, its
//                                                          option ids, counts
//   detail      jobs/jobPostings/<id>                      description, apply
//                                                          link, applicants
//   hiring team SDUI component peopleWhoCanHelp            who posted it, who
//                                                          is hiring for it
//
// A typed location goes as `seoLocation`; LinkedIn resolves it and echoes the
// geo it chose, which we report, because "Vienna, Austria" resolved to one
// district of Vienna. A `geoId` is exact.

import { CONTRACTS } from './contracts.ts';
import { Rows } from './posts.ts';
import { encodeVariables, type RestliValue } from './restli.ts';
import type { Failure } from './sdui-form.ts';

/** The three job contracts, verified; a missing one is a build error, not drift. */
function contract(name: 'jobCards' | 'jobFilters' | 'jobPosting') {
  const c = CONTRACTS[name];
  if (c?.decorationId === undefined) throw new Error(`job contract '${name}' is missing`);
  return { path: c.path, decorationId: c.decorationId };
}

/**
 * Jobs per search call. The browser asks for 25; the server serves up to 100
 * and answers 101 with a 400 (probed 2026-10-14). Four times fewer calls.
 */
export const PAGE_SIZE = 100;

/** Jobs per batch read. 100 returned all 100 in one call (2026-10-14). */
export const BATCH_SIZE = 100;

export interface JobQuery {
  keywords?: string;
  /** Free text, resolved by LinkedIn. Ignored when `geoId` is given. */
  location?: string;
  geoId?: string;
  /** selectedFilters, by LinkedIn's own parameter names. */
  filters: Record<string, string[]>;
  start: number;
  count: number;
}

function queryTuple(q: JobQuery): string {
  const locationUnion: RestliValue =
    q.geoId !== undefined
      ? { geoId: q.geoId }
      : q.location !== undefined
        ? { seoLocation: { location: q.location } }
        : undefined;
  const selected = Object.entries(q.filters).filter(([, v]) => v.length > 0);
  return encodeVariables({
    origin: 'JOB_SEARCH_PAGE_JOB_FILTER',
    keywords: q.keywords,
    locationUnion,
    selectedFilters: selected.length > 0 ? Object.fromEntries(selected) : undefined,
    spellCorrectionEnabled: true,
  });
}

export function jobSearchUrl(q: JobQuery): string {
  const c = contract('jobCards');
  return (
    `${c.path}?decorationId=${c.decorationId}` +
    `&count=${q.count}&q=jobSearch&query=${queryTuple(q)}&start=${q.start}`
  );
}

export function jobFiltersUrl(q: JobQuery): string {
  const c = contract('jobFilters');
  return `${c.path}?decorationId=${c.decorationId}&q=filters&query=${queryTuple(q)}`;
}

export function jobDetailUrl(id: string): string {
  const c = contract('jobPosting');
  return `${c.path}/${id}?decorationId=${c.decorationId}`;
}

/** Many jobs in one call, the same projection as one: a Rest.li batch get. */
export function jobBatchUrl(ids: string[]): string {
  const c = contract('jobPosting');
  return `${c.path}?ids=List(${ids.join(',')})&decorationId=${c.decorationId}`;
}

/** A bare id, a /jobs/view/ URL, a ?currentJobId= URL or a job urn. */
export function jobIdOf(input: string): string | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  const found =
    s.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/) ??
    s.match(/[?&]currentJobId=(\d+)/) ??
    s.match(/urn:li:(?:fsd_|fs_normalized_)?jobPosting:(\d+)/);
  return found?.[1];
}

const viewUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;
const day = (ms: unknown) =>
  typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : undefined;

type Node = Record<string, unknown>;
const text = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// ─── Cards ────────────────────────────────────────────────────────────────────

export type Workplace = 'on-site' | 'remote' | 'hybrid';

export interface JobCard {
  id: string;
  title: string;
  company?: string;
  location?: string;
  workplace?: Workplace;
  /** The day it was listed, YYYY-MM-DD. */
  listed?: string;
  easyApply: boolean;
  promoted: boolean;
  /** The pay line some cards carry, as LinkedIn wrote it. */
  salary?: string;
  /** Other card lines, e.g. "Be an early applicant", "5 applicants". */
  insights?: string[];
  url: string;
}

const WORKPLACE_SUFFIX: Record<string, Workplace> = {
  remote: 'remote',
  hybrid: 'hybrid',
  'on-site': 'on-site',
};

/** "Warsaw, Poland (Remote)" -> the place and the workplace, apart. */
function splitLocation(line: string | undefined): { location?: string; workplace?: Workplace } {
  if (line === undefined) return {};
  const m = line.match(/^(.*?)\s*\(([^()]+)\)$/);
  const kind = m?.[2] === undefined ? undefined : WORKPLACE_SUFFIX[m[2].toLowerCase()];
  return kind === undefined || m?.[1] === undefined
    ? { location: line }
    : { location: m[1], workplace: kind };
}

function cardToJob(card: Node): JobCard | undefined {
  const urn = card.jobPostingUrn ?? card['*jobPosting'];
  const id = typeof urn === 'string' ? jobIdOf(urn) : undefined;
  const title = typeof card.jobPostingTitle === 'string' ? card.jobPostingTitle : text(card.title);
  if (id === undefined || title === undefined) return undefined;

  const footer = Array.isArray(card.footerItems) ? (card.footerItems as Node[]) : [];
  const listed = footer.find((f) => f.type === 'LISTED_DATE');
  const insights = footer
    .filter((f) => !['LISTED_DATE', 'PROMOTED', 'EASY_APPLY_TEXT'].includes(String(f.type)))
    .map((f) => text(f.text))
    .filter((t): t is string => t !== undefined);
  const insight = text((card.relevanceInsight as Node | null)?.text);
  if (insight !== undefined) insights.push(insight);

  return defined({
    id,
    title,
    company: text(card.primaryDescription),
    ...splitLocation(text(card.secondaryDescription)),
    listed: day(listed?.timeAt),
    easyApply: footer.some((f) => f.type === 'EASY_APPLY_TEXT'),
    promoted: footer.some((f) => f.type === 'PROMOTED'),
    salary: text(card.tertiaryDescription),
    insights: insights.length > 0 ? insights : undefined,
    url: viewUrl(id),
  });
}

export interface JobPage {
  ok: true;
  jobs: JobCard[];
  /** LinkedIn's claimed total for the query. */
  total: number | undefined;
  start: number;
  /** The place a typed location resolved to. */
  location?: { geoId: string; name: string };
  /** Card kinds we do not read, by name: counted, never silently dropped. */
  unknownTypes: Record<string, number>;
}

const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'the job search response changed shape; re-capture it',
});

/** The cards the page lists, in order; other card kinds counted by name. */
function readCards(elements: Node[], included: Node[]) {
  const byUrn = new Map<string, Node>();
  for (const node of included) {
    if (typeof node.entityUrn === 'string') byUrn.set(node.entityUrn, node);
  }
  const jobs: JobCard[] = [];
  const unknownTypes: Record<string, number> = {};
  let unresolved = 0;
  for (const el of elements) {
    const union = (el.jobCardUnion ?? {}) as Record<string, unknown>;
    const ref = union['*jobPostingCard'];
    if (typeof ref !== 'string') {
      for (const kind of Object.keys(union)) unknownTypes[kind] = (unknownTypes[kind] ?? 0) + 1;
      continue;
    }
    const card = byUrn.get(ref);
    const job = card === undefined ? undefined : cardToJob(card);
    if (job === undefined) unresolved++;
    else if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
  }
  return { jobs, unknownTypes, unresolved };
}

/** The geo a typed location resolved to, as the response echoes it. */
function resolvedGeo(included: Node[]): { location: { geoId: string; name: string } } | object {
  const geo = included.find((n) => typeof n.$type === 'string' && n.$type.endsWith('.common.Geo'));
  const geoId = typeof geo?.entityUrn === 'string' ? geo.entityUrn.split(':').pop() : undefined;
  const name = typeof geo?.fullLocalizedName === 'string' ? geo.fullLocalizedName : undefined;
  return geoId !== undefined && name !== undefined ? { location: { geoId, name } } : {};
}

export function parseJobCards(json: unknown): JobPage | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const data = root?.data;
  const elements = data?.elements;
  if (data === undefined || !Array.isArray(elements))
    return drift('the job search returned no result list');
  const paging = (data.paging ?? {}) as { total?: unknown; start?: unknown };
  const total = typeof paging.total === 'number' ? paging.total : undefined;
  const start = typeof paging.start === 'number' ? paging.start : 0;
  const included = root?.included ?? [];

  const { jobs, unknownTypes, unresolved } = readCards(elements as Node[], included);
  if (unresolved > 0 && jobs.length === 0)
    return drift(`${unresolved} job cards were listed but none could be read`);
  if (elements.length === 0 && total !== undefined && total > start) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `LinkedIn claims ${total} jobs but returned none from ${start}`,
      hint: 'a failed fetch, not an empty search; do not report "no jobs"',
    };
  }
  return { ok: true, jobs, total, start, ...resolvedGeo(included), unknownTypes };
}

// ─── Detail ───────────────────────────────────────────────────────────────────

export interface JobDetail {
  id: string;
  title: string;
  company?: string;
  companyUrl?: string;
  location?: string;
  workplace?: Workplace;
  employmentType?: string;
  experienceLevel?: string;
  industries?: string[];
  functions?: string[];
  listed?: string;
  expires?: string;
  /** LISTED, CLOSED, … as LinkedIn reports it. */
  state?: string;
  applicants?: number;
  apply?: { type: 'easy-apply' | 'external'; url?: string };
  /** The employer's applicant tracking system, when LinkedIn names it. */
  ats?: string;
  applied?: boolean;
  saved?: boolean;
  description?: string;
  url: string;
}

const WORKPLACE_URN: Record<string, Workplace> = { '1': 'on-site', '2': 'remote', '3': 'hybrid' };

function applyOf(method: unknown, id: string): JobDetail['apply'] {
  const m = method as Node | null | undefined;
  if (m === null || m === undefined) return undefined;
  const type = String(m.$type ?? '');
  if (type.endsWith('OffsiteApply')) {
    const url = typeof m.companyApplyUrl === 'string' ? m.companyApplyUrl : undefined;
    return defined({ type: 'external' as const, url });
  }
  if (type.endsWith('OnsiteApply')) {
    // Some Easy Apply jobs carry no apply URL; the button is on the job page.
    const url = typeof m.easyApplyUrl === 'string' ? m.easyApplyUrl : viewUrl(id);
    return { type: 'easy-apply' as const, url };
  }
  return undefined;
}

/** One posting, its company and the user's own state looked up in `included`. */
function postingToJob(d: Node, included: Node[]): JobDetail | undefined {
  const rawId = d.jobPostingId ?? d.entityUrn;
  const id = rawId === undefined ? undefined : jobIdOf(String(rawId));
  if (id === undefined || typeof d.title !== 'string') return undefined;
  const find = (urn: unknown) =>
    typeof urn === 'string' ? included.find((n) => n.entityUrn === urn) : undefined;

  const details = (d.companyDetails ?? {}) as Node;
  const company = find(details.company ?? details['*companyResolutionResult']);
  const companyName =
    typeof company?.name === 'string'
      ? company.name
      : typeof details.companyName === 'string'
        ? details.companyName
        : undefined;
  const workplaces = Array.isArray(d.workplaceTypes) ? (d.workplaceTypes as string[]) : [];
  const workplace = WORKPLACE_URN[String(workplaces[0]?.split(':').pop())];
  const applying = find(d['*applyingInfo']);
  const saving = find(d['*savingInfo']);
  const list = (v: unknown) =>
    Array.isArray(v) && v.length > 0 ? v.filter((x) => typeof x === 'string') : undefined;
  const nonEmpty = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

  return defined({
    id,
    title: d.title,
    company: companyName,
    companyUrl: typeof company?.url === 'string' ? company.url : undefined,
    location: nonEmpty(d.formattedLocation),
    workplace: workplace ?? (d.workRemoteAllowed === true ? 'remote' : undefined),
    employmentType: nonEmpty(d.formattedEmploymentStatus),
    experienceLevel: nonEmpty(d.formattedExperienceLevel),
    industries: list(d.formattedIndustries),
    functions: list(d.formattedJobFunctions),
    listed: day(d.listedAt),
    expires: day(d.expireAt),
    state: nonEmpty(d.jobState),
    applicants: typeof d.applies === 'number' && d.applies > 0 ? d.applies : undefined,
    apply: applyOf(d.applyMethod, id),
    ats: nonEmpty(d.applicantTrackingSystem),
    applied: typeof applying?.applied === 'boolean' ? applying.applied : undefined,
    saved: typeof saving?.saved === 'boolean' ? saving.saved : undefined,
    description: text(d.description),
    url: viewUrl(id),
  });
}

export function parseJobDetail(json: unknown): { ok: true; job: JobDetail } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const job = root?.data === undefined ? undefined : postingToJob(root.data, root.included ?? []);
  return job === undefined ? drift('the job response carried no posting') : { ok: true, job };
}

export interface JobBatch {
  ok: true;
  jobs: JobDetail[];
  /** Ids the batch answered with an error. */
  missing: string[];
}

export function parseJobBatch(json: unknown): JobBatch | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const results = root?.data?.results;
  if (results === null || typeof results !== 'object')
    return drift('the batch job response carried no results');
  const included = root?.included ?? [];
  const byUrn = new Map(included.map((n) => [n.entityUrn, n]));
  const jobs: JobDetail[] = [];
  for (const ref of Object.values(results as Record<string, unknown>)) {
    const node = typeof ref === 'string' ? byUrn.get(ref) : (ref as Node);
    const job = node === undefined ? undefined : postingToJob(node, included);
    if (job !== undefined) jobs.push(job);
  }
  const claimed = Object.keys(results as object).length;
  if (claimed > 0 && jobs.length === 0)
    return drift(`the batch listed ${claimed} jobs but none could be read`);
  const errors = (root?.data?.errors ?? {}) as Record<string, unknown>;
  return { ok: true, jobs, missing: Object.keys(errors).map((k) => k.replace(/^\*/, '')) };
}

// ─── The hiring team ──────────────────────────────────────────────────────────
//
// Captured 2026-10-14. The detail's own JobHiringTeam is always empty (160 jobs
// read, 0 members); the job page draws "Meet the hiring team" from an SDUI
// component instead, one POST per job. It answers `0:null` when the job shows
// no one, and in the session's language: the degree is LinkedIn's own words.

export const HIRING_TEAM = 'com.linkedin.sdui.generated.jobseeker.dsl.impl.peopleWhoCanHelp';
export const HIRING_TEAM_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/component?componentId=${HIRING_TEAM}&sduiid=${HIRING_TEAM}`;

export function hiringTeamBody(jobId: string) {
  return {
    componentId: HIRING_TEAM,
    clientArguments: {
      payload: { jobId, isTwoPane: false },
      states: [],
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      screenId: 'com.linkedin.sdui.flagshipnav.jobs.JobDetails',
      knownTemplateIds: [],
    },
  };
}

export interface HiringMember {
  name: string;
  /** Their profile id: what `profile` and messages take. */
  id?: string;
  url: string;
  headline?: string;
  /** Connection degree, as LinkedIn words it in the session's language. */
  degree?: string;
  /** "Job poster", when LinkedIn says so. */
  role?: string;
  verified?: boolean;
}

const unquote = (s: string) => JSON.parse(`"${s}"`) as string;

/** One person's card row: name, then degree ("• 3rd"), headline and role. */
function memberOf(card: string, id: string | undefined): HiringMember | undefined {
  const url = card.match(/"url":"(https:\/\/www\.linkedin\.com\/in\/[^"/]+\/)"/)?.[1];
  const name = card.match(/\[null,"((?:[^"\\]|\\.)+)"/)?.[1];
  if (url === undefined || name === undefined) return undefined;
  const lines = [...card.matchAll(/"children":\["((?:[^"\\$]|\\.)(?:[^"\\]|\\.)*)"\]/g)].map((m) =>
    unquote(m[1] as string).trim(),
  );
  const degree = lines.find((l) => l.startsWith('•'));
  const [headline, role] = lines.filter((l) => l !== degree && l !== '');
  return defined({
    name: unquote(name).trim(),
    id,
    url,
    headline,
    degree: degree?.replace(/^•\s*/, ''),
    role,
    verified: /"role":"img","aria-label"/.test(card) ? true : undefined,
  });
}

export function parseHiringTeam(stream: string): { ok: true; members: HiringMember[] } | Failure {
  if (/^0:null\s*$/.test(stream.trim())) return { ok: true, members: [] };
  if (!stream.includes('peopleWhoCanHelp'))
    return drift('the hiring team answer was not the hiring team component');
  const rows = new Rows(stream);
  const cards = [...rows.byId].filter(([, row]) => /linkedin\.com\\?\/in\\?\//.test(row));
  // Each card sits beside its Message button, which names their profile id.
  const at = (card: string) => stream.indexOf(`"$L${card}"`);
  const placed = cards.map(([key]) => at(key)).sort((a, b) => a - b);
  const members: HiringMember[] = [];
  for (const [key, row] of cards) {
    const from = at(key);
    const to = placed.find((p) => p > from) ?? stream.length;
    const id = stream.slice(from, to).match(/recipient=([A-Za-z0-9_-]+)/)?.[1];
    const m = memberOf(row, from === -1 ? undefined : id);
    if (m !== undefined) members.push(m);
  }
  const shown = (stream.match(/screenContext=JOB_DETAILS_HIRING_TEAM/g) ?? []).length;
  if (members.length === 0 && Math.max(shown, cards.length) > 0)
    return drift(
      `${Math.max(shown, cards.length)} hiring team members were shown but none could be read`,
    );
  return { ok: true, members };
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface JobFilter {
  /** The parameter name `--filter key=…` and selectedFilters take. */
  key: string;
  label: string;
  options: { value: string; label: string; count?: number }[];
}

export function parseJobFilters(json: unknown): { ok: true; filters: JobFilter[] } | Failure {
  const elements = (json as { data?: { elements?: unknown } } | null)?.data?.elements;
  if (!Array.isArray(elements)) return drift('the job filter list was missing');
  const filters: JobFilter[] = [];
  for (const el of elements as Node[]) {
    const groups = [
      ...((el.secondaryFilterGroups as Node[] | undefined) ?? []),
      ...((el.primaryFilterGroups as Node[] | undefined) ?? []),
    ];
    for (const group of groups) {
      for (const f of (group.filters as Node[] | undefined) ?? []) {
        const key = f.parameterName;
        if (typeof key !== 'string' || filters.some((x) => x.key === key)) continue;
        const values = [
          ...((f.secondaryFilterValues as Node[] | undefined) ?? []),
          ...((f.primaryFilterValues as Node[] | undefined) ?? []),
        ];
        const options = values
          .filter((v) => typeof v.value === 'string')
          .map((v) =>
            defined({
              value: v.value as string,
              label:
                text(v.displayName) ??
                (typeof v.displayName === 'string' ? v.displayName : String(v.value)),
              count: typeof v.count === 'number' ? v.count : undefined,
            }),
          );
        // An option-less filter is an upsell placeholder, not a knob.
        if (options.length === 0) continue;
        filters.push({ key, label: text(f.displayName) ?? key, options });
      }
    }
  }
  if (filters.length === 0) return drift('the job filter list was empty');
  return { ok: true, filters };
}

// ─── Friendly filter names ────────────────────────────────────────────────────

export interface JobFilterOptions {
  posted?: string;
  experience?: string[];
  type?: string[];
  workplace?: string[];
  easyApply?: boolean;
  under10?: boolean;
  verified?: boolean;
  inNetwork?: boolean;
  fairChance?: boolean;
  company?: string[];
  industry?: string[];
  function?: string[];
  title?: string[];
  place?: string[];
  sort?: string;
  distance?: number;
  /** `key=v1,v2`, by LinkedIn's own parameter names, from `job-filters`. */
  raw?: string[];
}

const NAMED: Record<string, { param: string; values: Record<string, string> }> = {
  experience: {
    param: 'experience',
    values: {
      internship: '1',
      entry: '2',
      associate: '3',
      'mid-senior': '4',
      senior: '4',
      director: '5',
      executive: '6',
    },
  },
  type: {
    param: 'jobType',
    values: {
      'full-time': 'F',
      'part-time': 'P',
      contract: 'C',
      temporary: 'T',
      volunteer: 'V',
      internship: 'I',
      other: 'O',
    },
  },
  workplace: {
    param: 'workplaceType',
    values: { 'on-site': '1', onsite: '1', remote: '2', hybrid: '3' },
  },
};

const POSTED: Record<string, number> = {
  day: 86_400,
  '24h': 86_400,
  week: 604_800,
  month: 2_592_000,
};

/** A filter value we cannot map; caught once, in `jobFilterSelection`. */
class Refused extends Error {}

function postedRange(given: string): string {
  const p = given.toLowerCase();
  const n = p.match(/^(\d+)([hd])$/);
  const seconds = POSTED[p] ?? (n ? Number(n[1]) * (n[2] === 'h' ? 3600 : 86_400) : undefined);
  if (seconds === undefined)
    throw new Refused(`--posted '${given}' is not one of: 24h, week, month, or <N>h / <N>d`);
  return `r${seconds}`;
}

/** Friendly names, or LinkedIn's own codes, onto the codes; duplicates once. */
function named(name: keyof typeof NAMED, given: string[]): string[] {
  const { values } = NAMED[name] as (typeof NAMED)[string];
  const out: string[] = [];
  for (const v of given) {
    const mapped = values[v.toLowerCase()] ?? (Object.values(values).includes(v) ? v : undefined);
    if (mapped === undefined)
      throw new Refused(`--${name} '${v}' is not one of: ${Object.keys(values).join(', ')}`);
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function rawFilter(r: string): [string, string[]] {
  const m = r.match(/^([A-Za-z_]+)=(.+)$/);
  if (m?.[1] === undefined || m[2] === undefined)
    throw new Refused(`--filter '${r}' is not key=value[,value]`);
  const values = m[2]
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  return [m[1], values];
}

function selection(o: JobFilterOptions): Record<string, string[]> {
  const filters: Record<string, string[]> = {};
  if (o.posted !== undefined) filters.timePostedRange = [postedRange(o.posted)];
  for (const name of ['experience', 'type', 'workplace'] as const) {
    const given = o[name];
    if (given !== undefined && given.length > 0)
      filters[(NAMED[name] as (typeof NAMED)[string]).param] = named(name, given);
  }
  const flags: [boolean | undefined, string][] = [
    [o.easyApply, 'applyWithLinkedin'],
    [o.under10, 'earlyApplicant'],
    [o.verified, 'verifiedJob'],
    [o.inNetwork, 'jobInYourNetwork'],
    [o.fairChance, 'fairChanceEmployer'],
  ];
  for (const [on, param] of flags) if (on === true) filters[param] = ['true'];
  const ids: [string[] | undefined, string][] = [
    [o.company, 'company'],
    [o.industry, 'industry'],
    [o.function, 'function'],
    [o.title, 'title'],
    [o.place, 'populatedPlace'],
  ];
  for (const [given, param] of ids)
    if (given !== undefined && given.length > 0) filters[param] = given;
  if (o.sort !== undefined) {
    const sort = { recent: 'DD', relevant: 'R' }[o.sort.toLowerCase()];
    if (sort === undefined) throw new Refused(`--sort '${o.sort}' is not one of: recent, relevant`);
    filters.sortBy = [sort];
  }
  if (o.distance !== undefined) filters.distance = [String(o.distance)];
  for (const r of o.raw ?? []) {
    const [key, values] = rawFilter(r);
    filters[key] = values;
  }
  return filters;
}

export function jobFilterSelection(
  o: JobFilterOptions,
): { ok: true; filters: Record<string, string[]> } | Failure {
  try {
    return { ok: true, filters: selection(o) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: 'INVALID_INPUT', message: e.message };
    throw e;
  }
}
