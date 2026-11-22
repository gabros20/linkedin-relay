// ─── What Premium adds to jobs ────────────────────────────────────────────────
//
// Captured 2026-11-22 on a Premium account. Both are Voyager GraphQL, plain
// JSON, and both are read by the classic job pages:
//
//   collection  voyagerJobsDashJobCards, by `jobCollectionSlug`. The
//               /jobs/collections/<slug>/ pages. `top-applicant` (jobs where
//               you would be a top applicant) is Premium's; it answered 83
//               jobs, all of them in one call of 100. The cards are job
//               search's, under `jobCard` instead of `jobCardUnion`.
//               `recommended` answered none, as it does in the browser; a
//               slug LinkedIn does not know answers a GraphQL error.
//   insights    voyagerJobsDashJobPostingDetailSections, the detail pane's
//               cards by type. JOB_APPLICANT_INSIGHTS: how many applied, in
//               the last day, their seniority and education.
//               COMPANY_INSIGHTS_CARD: headcount by month over two years, for
//               the company and for the job's function, median tenure,
//               competitors, and LinkedIn's generated text on its hiring,
//               priorities and landscape. Both ride one call.
//
// The REST job search takes a `jobCollectionSlug` too and ignores it: it
// answered 241 jobs where the collection holds 83. Not used.

import { CONTRACTS } from './contracts.ts';
import { type JobPage, parseJobCards } from './jobs.ts';
import type { Failure } from './sdui-form.ts';

function graphql(name: 'jobCollection' | 'jobDetailSections') {
  const c = CONTRACTS[name];
  if (c?.queryId === undefined) throw new Error(`job contract '${name}' is missing`);
  return { path: c.path, queryId: c.queryId };
}

/** Jobs per collection call: the server serves 100 (2026-11-22). */
export const COLLECTION_PAGE = 100;

/** The collections a command takes, by LinkedIn's slug. */
export const COLLECTIONS = { 'top-applicant': 'top-applicant' } as const;
export type Collection = keyof typeof COLLECTIONS;

export function jobCollectionUrl(slug: Collection, start: number, count: number): string {
  const c = graphql('jobCollection');
  const variables = `(count:${count},jobCollectionSlug:${slug},query:(origin:GENERIC_JOB_COLLECTIONS_LANDING),start:${start})`;
  return `${c.path}?variables=${variables}&queryId=${c.queryId}`;
}

export function jobInsightsUrl(id: string): string {
  const c = graphql('jobDetailSections');
  const urn = encodeURIComponent(`urn:li:fsd_jobPosting:${id}`);
  const variables = `(cardSectionTypes:List(JOB_APPLICANT_INSIGHTS,COMPANY_INSIGHTS_CARD),jobPostingUrn:${urn},includeSecondaryActionsV2:true)`;
  return `${c.path}?includeWebMetadata=true&variables=${variables}&queryId=${c.queryId}`;
}

type Node = Record<string, unknown>;
const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const text = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);
function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// ─── Collection ───────────────────────────────────────────────────────────────

export function parseJobCollection(json: unknown): JobPage | Failure {
  const root = json as { data?: { data?: Node; errors?: unknown[] }; included?: Node[] } | null;
  const collection = root?.data?.data?.jobsDashJobCardsByJobCollections;
  if (collection === undefined || collection === null) {
    const why = nodes(root?.data?.errors)[0]?.message;
    return drift(`the job collection was not served${typeof why === 'string' ? `: ${why}` : ''}`);
  }
  return parseJobCards({ data: collection, included: root?.included ?? [] });
}

// ─── Insights ─────────────────────────────────────────────────────────────────

export interface ApplicantInsights {
  /** Who clicked apply. */
  total: number;
  lastDay?: number;
  seniority?: { level: string; share: number; count?: number }[];
  education?: { degree: string; share: number }[];
  /** Where you rank among them, when LinkedIn says. */
  rankPercentile?: number;
  /** Passed through as LinkedIn sends them: seen empty so far. */
  skills?: unknown[];
  locations?: unknown[];
}

export interface Headcount {
  /** The latest month, YYYY-MM. */
  asOf: string;
  now: number;
  sixMonthsAgo?: number;
  yearAgo?: number;
  twoYearsAgo?: number;
  /** Change over the year, in percent. */
  growth1y?: number;
}

export interface CompanyInsights {
  name?: string;
  url?: string;
  headcount?: Headcount;
  /** The job's own function at the company: its name and headcount. */
  function?: { name: string } & Partial<Headcount>;
  medianTenure?: string;
  competitors?: { name: string; industry?: string; url?: string }[];
  /** LinkedIn's generated text: hiring and headcount by function. */
  hiring?: string;
  /** LinkedIn's generated text: the company's strategic priorities. */
  priorities?: string;
  /** LinkedIn's generated text: its competitive landscape. */
  landscape?: string;
}

export interface JobInsights {
  ok: true;
  applicants?: ApplicantInsights;
  company?: CompanyInsights;
  /** Company insight sections we do not read, by name. */
  unknownSections: Record<string, number>;
}

function byUrn(included: Node[]): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const n of included) if (typeof n.entityUrn === 'string') map.set(n.entityUrn, n);
  return map;
}

const nameOf = (urns: Map<string, Node>, urn: unknown) => {
  const n = typeof urn === 'string' ? urns.get(urn)?.name : undefined;
  return typeof n === 'string' ? n : undefined;
};

function applicantsOf(a: Node, urns: Map<string, Node>): ApplicantInsights {
  const seniority = nodes(a.seniorityDetails).flatMap((s) => {
    const level = nameOf(urns, s['*seniority']);
    return level === undefined || typeof s.percentage !== 'number'
      ? []
      : [defined({ level, share: s.percentage, count: s.count as number | undefined })];
  });
  const education = nodes(a.degreeDetails).flatMap((d) => {
    const degree = nameOf(urns, d['*degree']);
    return degree === undefined || typeof d.percentage !== 'number'
      ? []
      : [{ degree, share: d.percentage }];
  });
  const skills = nodes(a.skillDetails);
  const locations = nodes(a.locationDetails);
  return defined({
    total: a.applicantCount as number,
    lastDay: typeof a.applicantsInPastDay === 'number' ? a.applicantsInPastDay : undefined,
    seniority: seniority.length > 0 ? seniority : undefined,
    education: education.length > 0 ? education : undefined,
    rankPercentile:
      typeof a.applicantRankPercentile === 'number' ? a.applicantRankPercentile : undefined,
    skills: skills.length > 0 ? skills : undefined,
    locations: locations.length > 0 ? locations : undefined,
  });
}

/** Newest month first, as LinkedIn lists it: now, 6 and 12 and 24 months back. */
function headcountOf(growth: unknown): Headcount | undefined {
  const months = nodes((growth as Node | null | undefined)?.headcountGrowth).flatMap((m) => {
    const on = m.startedOn as { year?: number; month?: number } | undefined;
    return typeof m.employeeCount === 'number' && on?.year !== undefined && on.month !== undefined
      ? [{ month: `${on.year}-${String(on.month).padStart(2, '0')}`, count: m.employeeCount }]
      : [];
  });
  const latest = months[0];
  if (latest === undefined) return undefined;
  const back = (n: number) => months[n]?.count;
  const yearAgo = back(12);
  return defined({
    asOf: latest.month,
    now: latest.count,
    sixMonthsAgo: back(6),
    yearAgo,
    twoYearsAgo: back(24),
    growth1y:
      yearAgo !== undefined && yearAgo > 0
        ? Math.round(((latest.count - yearAgo) / yearAgo) * 1000) / 10
        : undefined,
  });
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function trendOf(s: Node, urns: Map<string, Node>): CompanyInsights {
  const company = urns.get(String(s['*company']));
  const fn = str(s.formattedJobFunction);
  return defined({
    name: str(company?.name),
    url: str(company?.url),
    headcount: headcountOf(s.employeeGrowth),
    function:
      fn !== undefined ? { name: fn, ...headcountOf(s.employeeGrowthForFunction) } : undefined,
    medianTenure: text((s.employeeGrowth as Node | undefined)?.medianTenureYears),
  });
}

function landscapeOf(s: Node): CompanyInsights {
  const competitors = nodes(s.competitors).flatMap((c) => {
    const name = text(c.title);
    return name === undefined
      ? []
      : [defined({ name, industry: text(c.subtitle), url: str(c.navigationUrl) })];
  });
  return defined({
    landscape: text(s.aiqInsightsText),
    competitors: competitors.length > 0 ? competitors : undefined,
  });
}

/** Each section we read, into the company's insights. Any other is counted, never dropped silently. */
const SECTIONS: Record<string, (s: Node, urns: Map<string, Node>) => CompanyInsights> = {
  jobPostingCompanyInsights: trendOf,
  headcountAIQInsights: (s) => defined({ hiring: text(s.aiqInsightsText) }),
  strategicPrioritiesAIQInsights: (s) => defined({ priorities: text(s.insightsText) }),
  competitiveLandscapeAIQInsights: landscapeOf,
};

function companyOf(card: Node, urns: Map<string, Node>, unknown: Record<string, number>) {
  const out: CompanyInsights = {};
  for (const el of nodes(card.elements)) {
    for (const [kind, section] of Object.entries((el.companyInsights ?? {}) as Node)) {
      if (section === null || kind.startsWith('$')) continue;
      const read = SECTIONS[kind];
      if (read === undefined) unknown[kind] = (unknown[kind] ?? 0) + 1;
      else Object.assign(out, read(section as Node, urns));
    }
  }
  return out;
}

export function parseJobInsights(json: unknown): JobInsights | Failure {
  const root = json as { data?: { data?: Node }; included?: Node[] } | null;
  const sections = root?.data?.data?.jobsDashJobPostingDetailSectionsByCardSectionTypes as
    | Node
    | undefined;
  if (sections === undefined || sections === null || !Array.isArray(sections.elements))
    return drift('the job detail sections were not in the answer');
  const urns = byUrn(root?.included ?? []);
  const unknownSections: Record<string, number> = {};
  let applicants: ApplicantInsights | undefined;
  let company: CompanyInsights | undefined;
  for (const el of nodes(sections.elements)) {
    for (const part of nodes(el.jobPostingDetailSection)) {
      const a = urns.get(String(part['*jobApplicantInsightsUrn']));
      if (a !== undefined && typeof a.applicantCount === 'number')
        applicants = applicantsOf(a, urns);
      const posting = urns.get(String(part['*companyInsightsCard']));
      const card = posting?.companyInsightsCard as Node | undefined;
      if (card !== undefined && card !== null) company = companyOf(card, urns, unknownSections);
    }
  }
  return {
    ok: true,
    ...(applicants !== undefined ? { applicants } : {}),
    ...(company !== undefined && Object.keys(company).length > 0 ? { company } : {}),
    unknownSections,
  };
}
