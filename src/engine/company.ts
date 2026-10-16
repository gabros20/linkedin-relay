// ─── A company page ───────────────────────────────────────────────────────────
//
// Captured 2026-10-14. The company page itself is server-rendered SDUI; the
// GraphQL company query by universalName answers only the company's urn. The
// REST resource behind the `company` contract answers in JSON with what the
// About tab shows:
//
//   organization/companies/<id>                    the company
//   organization/companies?q=universalName&…       a collection of one
//
// Both carry the affiliated and showcase pages in `included`, each with its
// follower count. LinkedIn left `tagline` and `foundedOn` null for Microsoft,
// whose page shows neither; they are read when present.

import { CONTRACTS } from './contracts.ts';
import type { Failure } from './sdui-form.ts';

export type CompanyRef = { id: string } | { name: string };

/** A company from its universal name, page URL, numeric id or urn. */
export function companyRefOf(input: string): CompanyRef | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { id: s };
  const urn = s.match(/^urn:li:(?:fsd_company|fs_normalized_company|company|organization):(\d+)$/);
  if (urn?.[1] !== undefined) return { id: urn[1] };
  const page = s.match(/linkedin\.com\/(?:company|showcase)\/([^/?#\s]+)/);
  const slug = page?.[1] ?? (/^[A-Za-z0-9][A-Za-z0-9_%.-]*$/.test(s) ? s : undefined);
  if (slug === undefined) return undefined;
  const name = decodeURIComponent(slug);
  return /^\d+$/.test(name) ? { id: name } : { name };
}

export function companyUrl(ref: CompanyRef): string {
  const c = CONTRACTS.company;
  if (c?.decorationId === undefined) throw new Error("the 'company' contract is missing");
  const deco = `decorationId=${c.decorationId}`;
  return 'id' in ref
    ? `${c.path}/${ref.id}?${deco}`
    : `${c.path}?${deco}&q=universalName&universalName=${encodeURIComponent(ref.name)}`;
}

// ─── Reading it ───────────────────────────────────────────────────────────────

export interface RelatedPage {
  id: string;
  name: string;
  url?: string;
  followers?: number;
}

export interface Company {
  /** What `people --company`, `jobs --company` and `search posts --from-company` take. */
  id: string;
  name: string;
  universalName?: string;
  url: string;
  tagline?: string;
  /** The About tab's overview. */
  about?: string;
  website?: string;
  industry?: string;
  /** "Public Company", "Privately Held", … */
  type?: string;
  /** The size band the company chose, "10,001+" or "51-200". */
  size?: string;
  /** Members who list the company: the page's "employees" link. */
  employeesOnLinkedIn?: number;
  followers?: number;
  headquarters?: string;
  founded?: number;
  phone?: string;
  specialties?: string[];
  locations?: string[];
  affiliated?: RelatedPage[];
  showcasePages?: RelatedPage[];
  /** The company's own job search, every affiliate included. */
  jobsUrl?: string;
}

type Node = Record<string, unknown>;

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const idOf = (urn: unknown) => String(urn ?? '').match(/:(\d+)$/)?.[1];
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const slash = (u: unknown) => {
  const s = str(u);
  return s === undefined ? undefined : s.endsWith('/') ? s : `${s}/`;
};

function defined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** "1 Microsoft Way, Redmond, Washington 98052, US" */
function address(a: unknown): string | undefined {
  const n = a as Node | null | undefined;
  if (n === null || n === undefined) return undefined;
  const region = [str(n.geographicArea), str(n.postalCode)].filter(Boolean).join(' ');
  const parts = [str(n.line1), str(n.line2), str(n.city), str(region), str(n.country)];
  const line = parts.filter(Boolean).join(', ');
  return line === '' ? undefined : line;
}

function sizeOf(range: unknown): string | undefined {
  const r = range as { start?: unknown; end?: unknown } | null | undefined;
  if (typeof r?.start !== 'number') return undefined;
  const n = (x: number) => x.toLocaleString('en-US');
  return typeof r.end === 'number' ? `${n(r.start)}-${n(r.end)}` : `${n(r.start)}+`;
}

const urns = (v: unknown) => (Array.isArray(v) ? v.filter((u) => typeof u === 'string') : []);

export function parseCompany(json: unknown): { ok: true; company: Company } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const data = root?.data;
  if (data === undefined || data === null) return drift('the company answer carried no data');
  const included = root?.included ?? [];
  const byUrn = new Map(included.map((n) => [n.entityUrn, n]));

  // By id the data is the company; by name, a collection of (at most) one.
  let c: Node | undefined = data;
  if (!String(data.$type ?? '').endsWith('organization.Company')) {
    const listed = urns(data['*elements']);
    if (listed.length === 0)
      return { ok: false, code: 'NOT_FOUND', message: 'no company has that name on LinkedIn' };
    c = byUrn.get(listed[0]);
    if (c === undefined) return drift('the company was listed but not sent');
  }
  const id = idOf(c.entityUrn);
  const name = str(c.name);
  if (id === undefined || name === undefined) return drift('the company carried no id or name');

  const followersOf = (n: Node) => {
    const f = byUrn.get(n['*followingInfo']) as Node | undefined;
    return typeof f?.followerCount === 'number' ? f.followerCount : undefined;
  };
  const related = (list: unknown): RelatedPage[] | undefined => {
    const pages = urns(list).flatMap((u) => {
      const p = byUrn.get(u);
      const pid = idOf(u);
      const pname = str(p?.name);
      if (p === undefined || pid === undefined || pname === undefined) return [];
      return [defined({ id: pid, name: pname, url: slash(p.url), followers: followersOf(p) })];
    });
    return pages.length > 0 ? pages : undefined;
  };
  const industry = urns(c['*companyIndustries'])
    .map((u) => str(byUrn.get(u)?.localizedName))
    .find((x) => x !== undefined);
  const locations = (Array.isArray(c.confirmedLocations) ? c.confirmedLocations : [])
    .map(address)
    .filter((x): x is string => x !== undefined);
  const specialties = Array.isArray(c.specialities)
    ? c.specialities.filter((x): x is string => typeof x === 'string')
    : [];
  const founded = (c.foundedOn as { year?: unknown } | null | undefined)?.year;

  return {
    ok: true,
    company: defined({
      id,
      name,
      universalName: str(c.universalName),
      url: slash(c.url) ?? `https://www.linkedin.com/company/${id}/`,
      tagline: str(c.tagline),
      about: str(c.description),
      website: str(c.companyPageUrl),
      industry,
      type: str((c.companyType as Node | null | undefined)?.localizedName),
      size: sizeOf(c.staffCountRange),
      employeesOnLinkedIn: typeof c.staffCount === 'number' ? c.staffCount : undefined,
      followers: followersOf(c),
      headquarters: address(c.headquarter),
      founded: typeof founded === 'number' ? founded : undefined,
      phone: str((c.phone as Node | null | undefined)?.number),
      specialties: specialties.length > 0 ? specialties : undefined,
      locations: locations.length > 0 ? locations : undefined,
      affiliated: related(c.affiliatedCompanies),
      showcasePages: related(c.showcasePages),
      jobsUrl: str(c.jobSearchPageUrl),
    }),
  };
}
