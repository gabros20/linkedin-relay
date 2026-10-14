// ─── My Network: connections, following, followers, pages, invitations ────────
//
// Captured 2026-10-14. The My Network page's lists come from the same Voyager
// search as people (engine/people.ts), with origin `CurationHub`, intent
// `MYNETWORK_CURATION_HUB`, no keywords (an empty one is a 400) and a result
// type per list. Sent invitations are the older relationships resource.
//
// Opening My Network in the browser also clears the "new invitations" badge
// and marks notifications seen (`addaClearUnseenInvitationsMutation`,
// `addaMarkNotificationsSeen`). Those are separate calls; nothing here makes
// them. Not covered: received invitations (none were pending to verify
// against), newsletters (the hub answers that type with a server error), and
// "people you may know" (an SDUI pager).

import { CONTRACTS } from './contracts.ts';
import { PEOPLE_PAGE, type Person, parsePeople, peopleSearchUrl } from './people.ts';
import type { Failure } from './sdui-form.ts';
import { type Found, parseResults } from './search.ts';

/** The CLI's name for each hub list, and LinkedIn's result type. */
export const HUB = {
  connections: 'CONNECTIONS',
  following: 'PEOPLE_FOLLOW',
  followers: 'FOLLOWERS',
  pages: 'PAGES',
  events: 'EVENTS',
  groups: 'GROUPS',
} as const;

export type HubList = keyof typeof HUB;

const PEOPLE_LISTS = new Set<HubList>(['connections', 'following', 'followers']);

export function hubUrl(list: HubList, start: number): string {
  return peopleSearchUrl({
    params: {},
    start,
    kind: HUB[list],
    origin: 'CurationHub',
    intent: 'MYNETWORK_CURATION_HUB',
  });
}

export const HUB_PAGE = PEOPLE_PAGE;

export interface HubPage {
  ok: true;
  items: (Person | Found)[];
  total?: number;
  unknownTypes: Record<string, number>;
}

/** People lists read as people; pages, events and groups as generic results. */
export function parseHub(list: HubList, json: unknown): HubPage | Failure {
  if (PEOPLE_LISTS.has(list)) {
    const r = parsePeople(json);
    if (!r.ok) return r;
    return {
      ok: true,
      items: r.people,
      ...(r.total !== undefined ? { total: r.total } : {}),
      unknownTypes: r.unknownTypes,
    };
  }
  const r = parseResults(json);
  if (!r.ok) return r;
  return {
    ok: true,
    items: r.items,
    ...(r.total !== undefined ? { total: r.total } : {}),
    unknownTypes: r.unknownTypes,
  };
}

// ─── Sent invitations ─────────────────────────────────────────────────────────

export function sentInvitationsUrl(start: number, count = 10): string {
  const c = CONTRACTS.sentInvitations;
  if (c === undefined) throw new Error("the 'sentInvitations' contract is missing");
  return `${c.path}?count=${count}&invitationType=CONNECTION&q=invitationType&start=${start}`;
}

export interface SentInvitation {
  to: string;
  /** The invitee's profile id. */
  id?: string;
  headline?: string;
  url?: string;
  sent?: string;
  /** The note sent with it, if any. */
  note?: string;
}

type Node = Record<string, unknown>;

export function parseSentInvitations(
  json: unknown,
): { ok: true; invitations: SentInvitation[] } | Failure {
  const data = (json as { data?: Node } | null)?.data;
  const refs = data?.['*elements'] ?? data?.elements;
  if (!Array.isArray(refs))
    return { ok: false, code: 'SCHEMA_DRIFT', message: 'the sent invitations list was missing' };
  const included = (json as { included?: Node[] }).included ?? [];
  const byUrn = new Map<unknown, Node>(included.map((n) => [n.entityUrn, n]));
  const invitations: SentInvitation[] = [];
  for (const ref of refs as unknown[]) {
    const view = byUrn.get(ref);
    const inv =
      byUrn.get(view?.['*invitation']) ??
      included.find(
        (n) =>
          String(n.$type).endsWith('.Invitation') &&
          typeof ref === 'string' &&
          ref.endsWith(String(n.entityUrn)),
      );
    if (inv === undefined) continue;
    const who = byUrn.get(inv['*toMember']);
    const name = [who?.firstName, who?.lastName]
      .filter((x) => typeof x === 'string' && x !== '')
      .join(' ');
    const id = String(inv['*toMember'] ?? '')
      .split(':')
      .pop();
    const note =
      typeof inv.message === 'string'
        ? inv.message
        : (inv.message as { text?: unknown } | null)?.text;
    const out: SentInvitation = { to: name !== '' ? name : 'LinkedIn Member' };
    if (id) out.id = id;
    if (typeof who?.occupation === 'string') out.headline = who.occupation;
    if (typeof who?.publicIdentifier === 'string')
      out.url = `https://www.linkedin.com/in/${who.publicIdentifier}/`;
    if (typeof inv.sentTime === 'number') out.sent = new Date(inv.sentTime).toISOString();
    if (typeof note === 'string' && note.trim() !== '') out.note = note.trim();
    invitations.push(out);
  }
  if (refs.length > 0 && invitations.length === 0)
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `${refs.length} invitations were listed but none were sent`,
    };
  return { ok: true, invitations };
}
