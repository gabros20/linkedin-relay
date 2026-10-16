// ─── A profile in full ────────────────────────────────────────────────────────
//
// Probed 2026-10-16. The GraphQL profile projection behind the top card has
// no name; the REST profile finder with the FullProfileWithEntities
// decoration has the name, About and every section of the profile page:
//
//   identity/dash/profiles?q=memberIdentity&memberIdentity=<public id>
//
// Each section is a collection (`*profileSkills` → `*elements` → nodes in
// `included`), and the collections' order is the page's order; `included`
// is in no particular order. The profile holds the first 10 position groups
// (a company with its roles) and 20 skills. The rest of the experience pages
// through identity/dash/profilePositionGroups; skills did not (400), so their
// total is reported instead.
//
// Certifications, languages, projects, courses, organizations, patents and
// test scores were empty in every profile read so far; they are read by the
// names the other sections use and stay unverified until one comes with data.

import { CONTRACTS } from './contracts.ts';
import type { Failure } from './sdui-form.ts';

type Node = Record<string, unknown>;

function contract(name: 'fullProfile' | 'profilePositions') {
  const c = CONTRACTS[name];
  if (c?.decorationId === undefined) throw new Error(`the '${name}' contract is missing`);
  return c as typeof c & { decorationId: string };
}

export function fullProfileUrl(memberId: string): string {
  const c = contract('fullProfile');
  return (
    `${c.path}?q=memberIdentity&memberIdentity=${encodeURIComponent(memberId)}` +
    `&decorationId=${c.decorationId}`
  );
}

/** Position groups per call when reading the rest of the experience. */
export const POSITIONS_PAGE = 50;

export function positionsPageUrl(profileUrn: string, start: number): string {
  const c = contract('profilePositions');
  return (
    `${c.path}?q=viewee&profileUrn=${encodeURIComponent(profileUrn)}` +
    `&decorationId=${c.decorationId}&start=${start}&count=${POSITIONS_PAGE}`
  );
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface Role {
  title?: string;
  company?: string;
  /** What `company`, `people --company` and `jobs --company` take. */
  companyId?: string;
  employmentType?: string;
  location?: string;
  /** "2017-08", or "2017" when the month is not given. */
  start?: string;
  end?: string;
  current?: boolean;
  description?: string;
}

export interface School {
  school?: string;
  schoolId?: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
  grade?: string;
  activities?: string;
  description?: string;
}

export type Entry = Record<string, string | boolean | undefined>;

export interface FullProfile {
  /** The profile id: what `messages`, `people --connection-of` take. */
  id: string;
  urn: string;
  publicId?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  url?: string;
  location?: string;
  industry?: string;
  about?: string;
  /** The top card, as `profile` always gave it: the newest role and school. */
  title?: string;
  company?: string;
  school?: string;
  premium?: boolean;
  influencer?: boolean;
  creator?: boolean;
  experience?: Role[];
  education?: School[];
  skills?: string[];
  certifications?: Entry[];
  languages?: Entry[];
  honors?: Entry[];
  publications?: Entry[];
  projects?: Entry[];
  volunteering?: Entry[];
  courses?: Entry[];
  organizations?: Entry[];
  patents?: Entry[];
  testScores?: Entry[];
  /** Sections LinkedIn holds more of than it sent: shown and total. */
  counts?: Record<string, { shown: number; total: number }>;
}

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const str = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' && v.trim() !== '-' ? v.trim() : undefined;
const idOf = (urn: unknown) => String(urn ?? '').match(/:(\d+)$/)?.[1];

function defined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** {year, month, day} as "2017", "2017-08" or "2017-08-14". */
function date(v: unknown): string | undefined {
  const d = v as { year?: unknown; month?: unknown; day?: unknown } | null | undefined;
  if (typeof d?.year !== 'number') return undefined;
  const two = (n: number) => String(n).padStart(2, '0');
  if (typeof d.month !== 'number') return String(d.year);
  return typeof d.day === 'number'
    ? `${d.year}-${two(d.month)}-${two(d.day)}`
    : `${d.year}-${two(d.month)}`;
}

function range(v: unknown): { start?: string; end?: string; current?: boolean } {
  const r = v as { start?: unknown; end?: unknown } | null | undefined;
  const start = date(r?.start);
  const end = date(r?.end);
  return defined({
    start,
    end,
    current: start !== undefined && end === undefined ? true : undefined,
  });
}

class Index {
  readonly byUrn: Map<unknown, Node>;
  constructor(included: Node[]) {
    this.byUrn = new Map(included.map((n) => [n.entityUrn, n]));
  }
  get(urn: unknown): Node | undefined {
    return typeof urn === 'string' ? this.byUrn.get(urn) : undefined;
  }
  /** The node as a list of one, or none. */
  list(urn: unknown): Node[] {
    const n = this.get(urn);
    return n === undefined ? [] : [n];
  }
  /** A collection's nodes, in its order, and how many LinkedIn says there are. */
  collection(urn: unknown): { nodes: Node[]; total?: number } {
    const c = this.get(urn);
    const refs = Array.isArray(c?.['*elements']) ? (c?.['*elements'] as unknown[]) : [];
    const nodes = refs.flatMap((r): Node[] => this.list(r));
    const total = (c?.paging as { total?: unknown } | undefined)?.total;
    return typeof total === 'number' ? { nodes, total } : { nodes };
  }
}

function role(p: Node, group: Node | undefined, ix: Index): Role {
  const companyUrn = p.companyUrn ?? group?.companyUrn;
  return defined({
    title: str(p.title),
    company: str(p.companyName) ?? str(group?.companyName),
    companyId: idOf(companyUrn),
    employmentType: str(ix.get(p['*employmentType'])?.name),
    location: str(p.locationName) ?? str(p.geoLocationName),
    ...range(p.dateRange),
    description: str(p.description),
  });
}

/** Position groups (a company and its roles) as one list of roles, in order. */
function rolesOf(groups: Node[], ix: Index): Role[] {
  return groups.flatMap((g) => {
    const inGroup = ix.collection(g['*profilePositionInPositionGroup']).nodes;
    return inGroup.map((p) => role(p, g, ix));
  });
}

function school(e: Node): School {
  return defined({
    school: str(e.schoolName),
    schoolId: idOf(e.schoolUrn),
    degree: str(e.degreeName),
    field: str(e.fieldOfStudy),
    ...range(e.dateRange),
    grade: str(e.grade),
    activities: str(e.activities),
    description: str(e.description),
  });
}

/** The fields the other sections use, read off any section's node. */
function entry(n: Node): Entry {
  const proficiency = str(n.proficiency);
  return defined({
    name: str(n.name),
    title: str(n.title),
    role: str(n.role),
    organization: str(n.companyName),
    authority: str(n.authority),
    issuer: str(n.issuer),
    publisher: str(n.publisher),
    proficiency: proficiency?.toLowerCase().replace(/_/g, ' '),
    number: str(n.number) ?? str(n.licenseNumber) ?? str(n.patentNumber),
    score: str(n.score),
    cause: str(n.cause)?.toLowerCase().replace(/_/g, ' '),
    ...range(n.dateRange),
    issued: date(n.issuedOn),
    published: date(n.publishedOn),
    url: str(n.url),
    description: str(n.description),
  });
}

const SECTIONS = {
  certifications: '*profileCertifications',
  languages: '*profileLanguages',
  honors: '*profileHonors',
  publications: '*profilePublications',
  projects: '*profileProjects',
  volunteering: '*profileVolunteerExperiences',
  courses: '*profileCourses',
  organizations: '*profileOrganizations',
  patents: '*profilePatents',
  testScores: '*profileTestScores',
} as const;

const some = <T>(xs: T[]) => (xs.length > 0 ? xs : undefined);

export function parseFullProfile(json: unknown): { ok: true; profile: FullProfile } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const listed = root?.data?.['*elements'];
  if (!Array.isArray(listed)) return drift('the profile answer carried no profile list');
  if (listed.length === 0)
    return { ok: false, code: 'NOT_FOUND', message: 'no profile has that id on LinkedIn' };
  const ix = new Index(root?.included ?? []);
  const p = ix.get(listed[0]);
  const urn = typeof p?.entityUrn === 'string' ? p.entityUrn : undefined;
  if (p === undefined || urn === undefined) return drift('the profile was listed but not sent');

  const counts: Record<string, { shown: number; total: number }> = {};
  const count = (key: string, shown: number, total: number | undefined) => {
    if (total !== undefined && total > shown) counts[key] = { shown, total };
  };
  const groups = ix.collection(p['*profilePositionGroups']);
  count('experience', groups.nodes.length, groups.total);
  const experience = rolesOf(groups.nodes, ix);
  const schools = ix.collection(p['*profileEducations']);
  const education = schools.nodes.map(school);
  const skillNodes = ix.collection(p['*profileSkills']);
  count('skills', skillNodes.nodes.length, skillNodes.total);
  const skills = skillNodes.nodes.flatMap((s) => str(s.name) ?? []);

  const sections: Partial<Record<keyof typeof SECTIONS, Entry[]>> = {};
  for (const [key, field] of Object.entries(SECTIONS) as [keyof typeof SECTIONS, string][]) {
    const c = ix.collection(p[field]);
    count(key, c.nodes.length, c.total);
    const rows = c.nodes.map(entry);
    if (rows.length > 0) sections[key] = rows;
  }

  const publicId = str(p.publicIdentifier);
  const name = [str(p.firstName), str(p.lastName)].filter(Boolean).join(' ');
  const geo = ix.get((p.geoLocation as Node | undefined)?.['*geo']);
  const bool = (v: unknown) => (v === true ? true : undefined);
  return {
    ok: true,
    profile: defined({
      id: urn.split(':').pop() as string,
      urn,
      publicId,
      name: name === '' ? undefined : name,
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      headline: str(p.headline),
      url: publicId === undefined ? undefined : `https://www.linkedin.com/in/${publicId}/`,
      location: str(geo?.defaultLocalizedName),
      industry: str(ix.get(p['*industry'])?.name),
      about: str(p.summary),
      title: experience[0]?.title,
      company: experience[0]?.company,
      school: education[0]?.school,
      premium: bool(p.premium),
      influencer: bool(p.influencer),
      creator: bool(p.creator),
      experience: some(experience),
      education: some(education),
      skills: some(skills),
      ...sections,
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    }),
  };
}

/** The rest of the experience: more position groups, read as the profile reads them. */
export function parsePositionsPage(
  json: unknown,
): { ok: true; experience: Role[]; groups: number; total?: number } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const refs = root?.data?.['*elements'];
  if (!Array.isArray(refs)) return drift('the experience page carried no position groups');
  const ix = new Index(root?.included ?? []);
  const groups = refs.flatMap((r): Node[] => ix.list(r));
  if (refs.length > 0 && groups.length === 0)
    return drift(`${refs.length} position groups were listed but none sent`);
  const total = (root?.data?.paging as { total?: unknown } | undefined)?.total;
  return {
    ok: true,
    experience: rolesOf(groups, ix),
    groups: groups.length,
    ...(typeof total === 'number' ? { total } : {}),
  };
}
