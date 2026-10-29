// ─── `lnrelay profile <public-id|url|urn>` ────────────────────────────────────
//
// A profile in full; see engine/full-profile.ts. One call on the profile
// budget, and one more per 50 position groups past the first 10, so the
// experience is whole. `--contact` adds the contact info overlay, one more
// call on the profile budget. `--posts N` adds their newest posts: the posts
// search, filtered to posts from them, on the search budget. `--skills` reads
// every skill past the top 20, from the Skills screen's own list, 10 a page
// on the page budget. `--compact` turns every role, school and entry into a
// line and drops the descriptions; `--fields` keeps only the named fields.

import {
  CONTACT_INFO_URL,
  type ContactInfo,
  contactInfoBody,
  parseContactInfo,
} from '../engine/contact-info.ts';
import {
  type Entry,
  type FullProfile,
  fullProfileUrl,
  POSITIONS_PAGE,
  parseFullProfile,
  parsePositionsPage,
  positionsPageUrl,
  type Role,
  type School,
} from '../engine/full-profile.ts';
import { createLiveClient } from '../engine/index.ts';
import { navBody } from '../engine/sdui-form.ts';
import { NAV_URL } from '../engine/sdui-profile.ts';
import {
  listPayloadOf,
  PAGER_URL,
  pagerFrom,
  SKILL,
  skillNamesOf,
  skillRowsOf,
} from '../engine/sdui-skill.ts';
import { loadSession } from '../engine/session.ts';
import { project } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { runPostsSearch } from './posts-search.ts';

type Fetched =
  | { ok: true; json?: unknown; raw?: string }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted call: a POST when a body is given. Injectable so tests send nothing. */
export type ProfileFetch = (
  url: string,
  spendClass: 'profile' | 'search' | 'page',
  body?: unknown,
) => Promise<Fetched>;

function liveFetch(quiet: boolean): ProfileFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('profile', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass, body) => {
    const r = await client.request({
      url,
      ...(body !== undefined ? { method: 'POST' as const, body } : {}),
      spendClass,
      operation: 'profile',
    });
    if (!r.ok) return r;
    return { ok: true, json: r.json, raw: (r.classification as { raw?: string }).raw ?? '' };
  };
}

/** A public id from itself or a /in/ URL (decoded), or a profile id from a urn. */
export function memberIdOf(input: string): string {
  const s = input.trim();
  const slug = s.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  if (slug !== undefined) {
    try {
      return decodeURIComponent(slug);
    } catch {
      return slug;
    }
  }
  return s.match(/urn:li:fsd?_(?:mini)?[Pp]rofile:([^,)]+)/)?.[1] ?? s;
}

type Read = FullProfile & {
  experienceError?: string;
  contact?: ContactInfo;
  contactError?: string;
  posts?: unknown[];
  postsError?: string;
  skillsError?: string;
  raw?: unknown;
};

/** Reads the position groups the profile did not hold, until all are in. */
async function readRestOfExperience(get: ProfileFetch, p: Read): Promise<void> {
  const want = p.counts?.experience;
  if (want === undefined) return;
  let start = want.shown;
  while (start < want.total) {
    const res = await get(positionsPageUrl(p.urn, start), 'profile');
    const page = res.ok ? parsePositionsPage(res.json) : res;
    if (!page.ok) {
      p.experienceError = `${page.code}: ${page.message}`;
      return;
    }
    p.experience = [...(p.experience ?? []), ...page.experience];
    start += page.groups;
    if (page.groups < POSITIONS_PAGE) break;
  }
  const counts = { ...p.counts };
  if (start >= want.total) delete counts.experience;
  else counts.experience = { shown: start, total: want.total };
  if (Object.keys(counts).length > 0) p.counts = counts;
  else delete p.counts;
}

/** The contact info overlay, which names the member by public id and name. */
async function readContact(get: ProfileFetch, p: Read): Promise<void> {
  if (p.publicId === undefined || p.firstName === undefined) {
    p.contactError = 'NOT_FOUND: the profile has no public id or name to ask with';
    return;
  }
  const body = contactInfoBody(p.publicId, p.firstName, p.lastName ?? '');
  const res = await get(CONTACT_INFO_URL, 'profile', body);
  const read = res.ok ? parseContactInfo(res.raw ?? '') : res;
  if (read.ok) p.contact = read.contact;
  else p.contactError = `${read.code}: ${read.message}`;
}

/** Skill pages at most: 10 skills each, and LinkedIn shows up to 100. */
const SKILL_PAGES = 10;

/** Every skill, from the Skills screen's own list, in place of the profile's top 20. */
async function readAllSkills(get: ProfileFetch, p: Read): Promise<void> {
  const fail = (code: string, message: string) => {
    p.skillsError = `${code}: ${message}`;
  };
  if (p.publicId === undefined)
    return fail('NOT_FOUND', 'the profile has no public id to ask with');
  const screen = SKILL.listScreen;
  const nav = await get(
    `${NAV_URL}?screenId=${screen}&sduiid=${screen}`,
    'page',
    navBody(screen, { vanityName: p.publicId, isVanityNameResolved: true }),
  );
  if (!nav.ok) return fail(nav.code, nav.message);
  const payload = listPayloadOf(nav.raw ?? '');
  if (payload === null) return fail('SCHEMA_DRIFT', 'the Skills screen carried no list request');
  const count = typeof payload.count === 'number' ? payload.count : 10;
  const total = p.counts?.skills?.total;
  const skills: string[] = [];
  let start = 0;
  for (let page = 0; page < SKILL_PAGES; page++) {
    const res = await get(PAGER_URL, 'page', pagerFrom(payload, start));
    if (!res.ok) return fail(res.code, res.message);
    const rows = skillRowsOf(res.raw ?? '');
    const names = skillNamesOf(res.raw ?? '');
    if (rows > names.length)
      return fail('SCHEMA_DRIFT', `${rows} skills were shown, ${names.length} read`);
    skills.push(...names);
    start += rows;
    if (rows < count || (total !== undefined && start >= total)) break;
  }
  if (skills.length === 0) return fail('SCHEMA_DRIFT', 'the skills list held no skills');
  p.skills = skills;
  const counts = { ...p.counts };
  if (total === undefined || skills.length >= total) delete counts.skills;
  else counts.skills = { shown: skills.length, total };
  if (Object.keys(counts).length > 0) p.counts = counts;
  else delete p.counts;
}

/** Their newest posts onto the profile; a failure says why on the profile. */
async function readPosts(get: ProfileFetch, p: Read, n: number, compact: boolean): Promise<void> {
  const r = await runPostsSearch(
    { from: [p.id], sort: 'recent', limit: n },
    compact ? { compact: true } : {},
    async (url, body) => {
      const res = await get(url, 'search', body);
      return res.ok ? { ok: true, raw: res.raw ?? '' } : res;
    },
  );
  if (r.ok) p.posts = (r.data as { items: unknown[] }).items;
  else p.postsError = `${r.error.code}: ${r.error.message}`;
}

const span = (x: { start?: string; end?: string; current?: boolean }) =>
  x.start === undefined && x.end === undefined
    ? undefined
    : `${x.start ?? '?'} – ${x.current === true ? 'now' : (x.end ?? '?')}`;

const roleLine = (r: Role) => line([r.title, r.company, span(r), r.employmentType, r.location]);
const schoolLine = (s: School) => line([s.school, s.degree, s.field, span(s)]);
const entryLine = (e: Entry) => {
  const { description: _d, url, ...rest } = e;
  const dates = span(e as { start?: string; end?: string; current?: boolean });
  const fields = Object.entries(rest)
    .filter(([k, v]) => !['start', 'end', 'current'].includes(k) && typeof v === 'string')
    .map(([, v]) => v as string);
  return line([...fields, dates, typeof url === 'string' ? url : undefined]);
};

const LISTS = [
  'certifications',
  'languages',
  'honors',
  'publications',
  'projects',
  'volunteering',
  'courses',
  'organizations',
  'patents',
  'testScores',
] as const;

/** Every role, school and entry as one line; descriptions dropped. */
function compact(p: Read): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if (p.experience !== undefined) out.experience = p.experience.map(roleLine);
  if (p.education !== undefined) out.education = p.education.map(schoolLine);
  for (const key of LISTS) {
    const rows = p[key];
    if (rows !== undefined) out[key] = rows.map(entryLine);
  }
  return out;
}

export async function runProfile(
  input: string | undefined,
  opts: OutputOpts = {},
  fetch?: ProfileFetch,
  req: { contact?: boolean; posts?: number; skills?: boolean } = {},
): Promise<Envelope> {
  if (input === undefined || input.trim() === '')
    return err(
      'profile',
      'INVALID_INPUT',
      'a public id, profile URL or urn is required',
      'lnrelay profile <public-id|url|urn>',
    );
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;

  const res = await get(fullProfileUrl(memberIdOf(input)), 'profile');
  if (!res.ok) return err('profile', res.code, res.message, res.hint);
  const parsed = parseFullProfile(res.json);
  if (!parsed.ok) return err('profile', parsed.code, parsed.message, parsed.hint);
  const p: Read = parsed.profile;
  await readRestOfExperience(get, p);
  if (req.skills === true) await readAllSkills(get, p);
  if (req.contact === true) await readContact(get, p);
  if (req.posts !== undefined && req.posts > 0)
    await readPosts(get, p, req.posts, opts.compact === true);

  if (opts.raw === true) return ok('profile', { ...p, raw: res.json });
  if (opts.fields !== undefined && opts.fields !== '')
    return ok('profile', project([p as unknown as Record<string, unknown>], opts.fields)[0]);
  return ok('profile', opts.compact === true ? compact(p) : p);
}
