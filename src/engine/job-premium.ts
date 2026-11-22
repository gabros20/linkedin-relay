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
//
// Two more are not Voyager:
//
//   hear back   "Jobs where you're more likely to hear back", the jobs home's
//               Premium list, is the new job search page with
//               origin=QUALIFICATION_LANDING: POST flagship-web/jobs/
//               search-results/?…&start=N, answered as page data only with
//               `x-li-rsc-stream: true` (the HTML page otherwise, ignoring
//               start). 25 cards a page, each `job-card-component-ref-<id>`;
//               their text is deep in markup, so the ids are read and the jobs
//               then read in full. Keywords and place change nothing: 84 jobs
//               in four pages, the last short.
//   match       "Show match details" asks LinkedIn's AI assistant. The job's
//               howYouFitGuide component links the question (in the session's
//               language) and the assistant's context; voyagerGuideDashMessage
//               (`action=execute`) sends it, the answer is streamed elsewhere,
//               and the conversation's messages (voyagerGuideDashBionicMessageV2)
//               hold it once `finalComponentPosition` is set: about 4 seconds.
//               Asking adds the exchange to the user's assistant history.

import { CONTRACTS } from './contracts.ts';
import { type JobPage, parseJobCards } from './jobs.ts';
import type { Failure } from './sdui-form.ts';

function graphql(name: 'jobCollection' | 'jobDetailSections' | 'guideMessage' | 'guideMessages') {
  const c = CONTRACTS[name];
  if (c?.queryId === undefined) throw new Error(`job contract '${name}' is missing`);
  return { path: c.path, queryId: c.queryId };
}

/** Jobs per collection call: the server serves 100 (2026-11-22). */
export const COLLECTION_PAGE = 100;

/** The collections a command takes, by LinkedIn's slug. */
export const COLLECTIONS = ['top-applicant', 'hear-back'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export function jobCollectionUrl(slug: 'top-applicant', start: number, count: number): string {
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

// ─── Hear back ────────────────────────────────────────────────────────────────

export const HEAR_BACK_PAGE = 25;
const SEARCH_RESULTS = 'https://www.linkedin.com/flagship-web/jobs/search-results/';
export const HEAR_BACK_HEADERS = {
  'x-li-rsc-stream': 'true',
  referer: 'https://www.linkedin.com/jobs/',
} as const;

export function hearBackUrl(start: number): string {
  return `${SEARCH_RESULTS}?showHowYouFit=HOW_YOU_FIT&origin=QUALIFICATION_LANDING&start=${start}`;
}

export function hearBackBody() {
  return {
    requestedArguments: {
      payload: {
        showHowYouFit: 'HOW_YOU_FIT',
        shouldHideLoadingSpinner: true,
        origin: 'JobSearchOrigin_QUALIFICATION_LANDING',
      },
      states: [],
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      screenId: 'com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails',
      knownTemplateIds: [],
    },
  };
}

/** The job ids a results page lists, in order, each once. */
export function parseJobIds(stream: string): { ok: true; ids: string[] } | Failure {
  if (/^\s*</.test(stream)) return drift('LinkedIn answered the page, not its data');
  const ids = [...stream.matchAll(/job-card-component-ref-(\d+)/g)].map((m) => m[1] as string);
  return { ok: true, ids: [...new Set(ids)] };
}

// ─── Match ────────────────────────────────────────────────────────────────────

const HOW_YOU_FIT = 'com.linkedin.sdui.generated.jobseeker.dsl.impl.howYouFitGuide';
export const HOW_YOU_FIT_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/component?componentId=${HOW_YOU_FIT}&sduiid=${HOW_YOU_FIT}`;

export function howYouFitBody(jobId: string) {
  const key = `jdpApplyState_${jobId}`;
  return {
    componentId: HOW_YOU_FIT,
    clientArguments: {
      payload: { jobId, isPremium: true, applyState: { key, namespace: 'MemoryNamespace' } },
      states: [
        {
          key,
          namespace: 'MemoryNamespace',
          value: 'Initial',
          originalProtoCase: 'stringValue',
          protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: key } },
        },
      ],
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      screenId: 'com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails',
      knownTemplateIds: [],
    },
  };
}

export interface MatchLink {
  /** The question, in the session's language. */
  query: string;
  intent: string;
  mailbox: string;
  contextUrns: string[];
  customContext: { key: string; value: string }[];
}

const FIT = 'JobSeekerAgentIntent_JOB_FIT_EXPLANATION';

/** The job's "Show match details" link, found by its sub-intent, not its words. */
export function parseMatchLink(
  stream: string,
  jobId: string,
): { ok: true; link: MatchLink } | Failure {
  for (const m of stream.matchAll(/"url":"(\/preload\/guideOverlay\/\?[^"]*)"/g)) {
    const q = new URL(`https://www.linkedin.com${m[1]}`).searchParams;
    const customContext = (q.get('customContext') ?? '').split(',').flatMap((pair) => {
      const at = pair.indexOf('~:');
      return at === -1 ? [] : [{ key: pair.slice(0, at), value: pair.slice(at + 2) }];
    });
    const sub = customContext.find((c) => c.key === 'subIntent')?.value;
    const job = customContext.find((c) => c.key === 'jobPostingId')?.value;
    const query = q.get('query');
    const mailbox = q.get('originalThreadMailbox');
    if (sub !== FIT || job !== jobId || query === null || mailbox === null) continue;
    return {
      ok: true,
      link: {
        query,
        intent: q.get('intent') ?? 'GuideIntent_JOB_SEEKING_AGENT',
        mailbox,
        contextUrns: (q.get('contextUrns') ?? '').split(',').filter((u) => u !== ''),
        customContext,
      },
    };
  }
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: 'the job offers no match details (Premium only, and not on every job)',
  };
}

/** 16 random bytes as a string, as the overlay makes its ids. */
const randomId = () => String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)));

export function matchMessageUrl(): string {
  const c = graphql('guideMessage');
  return `${c.path}?action=execute&queryId=${c.queryId}`;
}

export function matchMessageBody(
  link: MatchLink,
  jobId: string,
  ids: { interaction: string; session: string } = { interaction: randomId(), session: randomId() },
) {
  const c = graphql('guideMessage');
  return {
    variables: {
      guideInteractionId: ids.interaction,
      guideQueryContext: {
        customContext: link.customContext,
        intent: link.intent,
        pageContext: {
          origin: '',
          companyUrns: null,
          profileUrns: null,
          jobPostingUrns: [`urn:li:fsd_jobPosting:${jobId}`],
        },
        contextUrns: link.contextUrns,
        originalIntent: link.intent,
        originalThreadMailbox: link.mailbox,
        isZeroState: false,
      },
      guideSessionId: ids.session,
      query: link.query,
    },
    queryId: c.queryId,
    includeWebMetadata: true,
  };
}

export function parseMatchSent(
  json: unknown,
): { ok: true; conversation: string; response: string } | Failure {
  const root = json as { data?: { data?: Node; errors?: unknown[] }; included?: Node[] } | null;
  const message = nodes(root?.included).find(
    (n) => typeof n.conversationV2Urn === 'string' && (n.content as Node | null)?.['*aiResponse'],
  );
  const conversation = message?.conversationV2Urn;
  const response = (message?.content as Node | undefined)?.['*aiResponse'];
  if (typeof conversation !== 'string' || typeof response !== 'string') {
    const why = nodes(root?.data?.errors)[0]?.message;
    return drift(
      `the assistant did not take the question${typeof why === 'string' ? `: ${why}` : ''}`,
    );
  }
  return { ok: true, conversation, response };
}

export function matchAnswerUrl(conversation: string): string {
  const c = graphql('guideMessages');
  const urn = encodeURIComponent(conversation);
  return `${c.path}?includeWebMetadata=true&variables=(guideConversationV2Urn:${urn},syncToken:null)&queryId=${c.queryId}`;
}

export interface Match {
  /** The verdict line ("Job match is low"), in the session's language. */
  summary?: string;
  /** Required qualifications met (✓) and not (?), as the assistant words them. */
  met: string[];
  missing: string[];
  /** The rest of the answer, one paragraph a line. */
  text: string;
}

type Attribute = { start?: number; length?: number; detailData?: Node };

function matchOf(t: { text: string; attributesV2?: Attribute[] }): Match {
  const spans = (style: string) =>
    (t.attributesV2 ?? [])
      .filter((a) => a.detailData?.style === style)
      .map((a) => t.text.slice(a.start ?? 0, (a.start ?? 0) + (a.length ?? 0)).trim());
  const first = (t.attributesV2 ?? [])[0];
  const lines = spans('PARAGRAPH').filter((l) => l !== '');
  const marked = (mark: string) =>
    lines.filter((l) => l.startsWith(mark)).map((l) => l.slice(mark.length).trim());
  return defined({
    summary:
      first?.detailData?.style === 'BOLD' && first.start === 0 ? spans('BOLD')[0] : undefined,
    met: marked('✓'),
    missing: marked('?'),
    text: lines.join('\n'),
  }) as Match;
}

export function parseMatchAnswer(
  json: unknown,
  response: string,
): { ok: true; done: false } | { ok: true; done: true; match: Match } | Failure {
  const root = json as { included?: Node[] } | null;
  if (!Array.isArray(root?.included)) return drift('the conversation came back without messages');
  const answer = root.included.find((n) => n.entityUrn === response);
  const streaming = ((answer?.responseV2 as Node | undefined)?.streamingResponse ?? {}) as Node;
  if (typeof streaming.finalComponentPosition !== 'number') return { ok: true, done: false };
  for (const part of nodes(streaming.responseComponent)) {
    const t = ((part.component as Node | undefined)?.aiResponse as Node | undefined)?.text as
      | { text?: unknown; attributesV2?: Attribute[] }
      | undefined;
    if (typeof t?.text === 'string')
      return { ok: true, done: true, match: matchOf(t as { text: string }) };
  }
  return drift('the assistant finished without a written answer');
}
