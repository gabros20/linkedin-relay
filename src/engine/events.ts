// ─── Events: the events hub, and one event in full ────────────────────────────
//
// Captured 2026-10-14. Searching events by keyword is `search events`
// (engine/search.ts). This adds the two things the events page itself has:
//
//   the hub     an SDUI component, `eventsHomeCardGroupsSection`: the Premium
//               LinkedIn Live events and "recommended for you", as cards
//   an event    `voyagerEventsDashProfessionalEvents` by event id: times and
//               time zone, state, place or online, attendees, organiser,
//               description, the event's own site
//
// A hub card's own rows hold, in order: when, the organiser (not on LinkedIn
// Live cards), the attendee line, the title. Labels come in the viewer's
// LinkedIn language, so a card is read by that order and by shape (a clock
// time; a number then a word), never by the words. Following a card's
// references would run into the next card's rows; the walk stops there.

import { CONTRACTS } from './contracts.ts';
import { Rows } from './posts.ts';
import { encodeVariables } from './restli.ts';
import type { Failure } from './sdui-form.ts';

export const EVENTS_HUB = 'com.linkedin.sdui.generated.events.dsl.impl.eventsHomeCardGroupsSection';
export const EVENTS_HUB_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/component?componentId=${EVENTS_HUB}&sduiid=${EVENTS_HUB}`;

export function eventsHubBody() {
  return {
    componentId: EVENTS_HUB,
    clientArguments: { states: [], screenId: '', knownTemplateIds: [] },
  };
}

/** An event id from itself, an /events/ URL (the id ends its vanity name), or a urn. */
export function eventIdOf(input: string): string | undefined {
  const s = input.trim();
  return (
    s.match(/^(\d{15,20})$/)?.[1] ??
    s.match(/\/events\/[a-z0-9-]*?(\d{15,20})/)?.[1] ??
    s.match(/(?:fsd_professionalEvent|event):(\d{15,20})/)?.[1]
  );
}

const eventLink = (id: string) => `https://www.linkedin.com/events/${id}/`;

// ─── The hub ──────────────────────────────────────────────────────────────────

export interface HubEvent {
  id: string;
  name: string;
  /** As the card shows it, in the viewer's language. */
  when?: string;
  organizer?: string;
  attendees?: number;
  /** A LinkedIn Live event in the Premium section. */
  premium: boolean;
  url: string;
}

const CARD = /"viewName":"event-(large|small)-card-container"/;
const TIME = /\d{1,2}:\d{2}/;
const COUNT = /^(\d[\d,.\s]*)\s+\S+$/;

function texts(row: string): string[] {
  return [...row.matchAll(/"children":\["((?:[^"\\$]|\\.)(?:[^"\\]|\\.)*)"\]/g)].map(
    (m) => JSON.parse(`"${m[1]}"`) as string,
  );
}

/** A card's rows: its own, and what it references, stopping at any other card. */
function cardRows(rows: Rows, id: string): string[] {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0 && seen.size < 40) {
    const row = rows.byId.get(queue.shift() as string) ?? '';
    for (const m of row.matchAll(/"\$L?([0-9a-f]+)(?::[^"]*)?"/g)) {
      const ref = m[1] as string;
      const next = rows.byId.get(ref);
      if (seen.has(ref) || next === undefined || CARD.test(next)) continue;
      seen.add(ref);
      queue.push(ref);
    }
  }
  return [...seen];
}

const count = (t: string | undefined) =>
  t === undefined ? undefined : Number(t.match(COUNT)?.[1]?.replace(/[,.\s]/g, ''));

function cardToEvent(rows: Rows, id: string, premium: boolean): HubEvent | undefined {
  const all = cardRows(rows, id)
    .map((r) => rows.byId.get(r) ?? '')
    .join('\n');
  const ids = [
    ...new Set([...all.matchAll(/\/events\/[a-z0-9-]*?(\d{15,20})/g)].map((m) => m[1] as string)),
  ];
  if (ids.length !== 1) return undefined;
  const t = texts(all);
  const at = t.findIndex((x) => TIME.test(x));
  const n = t.findIndex((x, i) => i > at && COUNT.test(x));
  const name = n === -1 ? undefined : t[n + 1];
  if (at === -1 || name === undefined) return undefined;
  // Between the time and the count: the organiser, and separators like "•".
  const organizer = t.slice(at + 1, n).find((x) => /\p{L}/u.test(x));
  const attendees = count(t[n]);
  return {
    id: ids[0] as string,
    name: name.trim(),
    when: t[at],
    ...(organizer !== undefined ? { organizer } : {}),
    ...(attendees !== undefined && Number.isFinite(attendees) ? { attendees } : {}),
    premium,
    url: eventLink(ids[0] as string),
  };
}

export function parseEventsHub(
  stream: string,
): { ok: true; events: HubEvent[]; used: Set<string> } | Failure {
  if (
    !stream.includes('event-large-card-container') &&
    !stream.includes('event-small-card-container')
  ) {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the events page carried no event cards',
      hint: 're-capture the events hub',
    };
  }
  const rows = new Rows(stream);
  const events: HubEvent[] = [];
  const used = new Set<string>();
  let unread = 0;
  for (const m of stream.matchAll(new RegExp(CARD.source, 'g'))) {
    const id = rows.at(m.index ?? 0);
    if (id === undefined) continue;
    for (const r of cardRows(rows, id)) used.add(r);
    const e = cardToEvent(rows, id, m[1] === 'small');
    if (e === undefined) unread++;
    else if (!events.some((x) => x.id === e.id)) events.push(e);
  }
  if (events.length === 0)
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: `${unread} event cards were shown but none could be read`,
    };
  return { ok: true, events, used };
}

// ─── One event ────────────────────────────────────────────────────────────────

export function eventUrl(id: string): string {
  const c = CONTRACTS.professionalEvent;
  if (c?.queryId === undefined) throw new Error("the 'professionalEvent' contract is missing");
  const variables = encodeVariables({
    eventIdentifier: id,
    includeComments: false,
    includeCommentsFirstReply: false,
  });
  return `${c.path}?variables=${variables}&queryId=${c.queryId}`;
}

export interface EventDetail {
  id: string;
  name: string;
  /** As LinkedIn shows it, in the viewer's time zone. */
  when?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  /** FUTURE, ONGOING, PAST, as LinkedIn reports it. */
  state?: string;
  cancelled?: boolean;
  attendees?: number;
  organizer?: { name: string; kind: 'company' | 'person'; url?: string };
  online: boolean;
  /** City, region, country for an event in person. */
  place?: string;
  /** The event's own site or registration page. */
  site?: string;
  private?: boolean;
  premium?: boolean;
  /** The viewer's own response (ATTENDING, …); absent when they have given none. */
  you?: string;
  description?: string;
  url: string;
}

type Node = Record<string, unknown>;
/** A TextViewModel's string, at either nesting depth (`socialProof.text.text`). */
const txt = (v: unknown): string | undefined => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  if (t !== null && typeof t === 'object') return txt(t);
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};

function organizerOf(e: Node, byUrn: Map<unknown, Node>): EventDetail['organizer'] {
  const o = (e.organizer ?? {}) as Node;
  const company = byUrn.get(o['*organizingCompanyUrn']);
  if (typeof company?.name === 'string') {
    const id = String(company.entityUrn).split(':').pop();
    return { name: company.name, kind: 'company', url: `https://www.linkedin.com/company/${id}/` };
  }
  const person = byUrn.get(o['*organizingProfileUrn'] ?? o.organizingProfileUrn);
  const name = [person?.firstName, person?.lastName].filter((x) => typeof x === 'string').join(' ');
  if (name !== '') {
    const vanity = person?.publicIdentifier;
    return {
      name,
      kind: 'person',
      ...(typeof vanity === 'string' ? { url: `https://www.linkedin.com/in/${vanity}/` } : {}),
    };
  }
  return undefined;
}

export function parseEvent(json: unknown): { ok: true; event: EventDetail } | Failure {
  const included = (json as { included?: Node[] } | null)?.included ?? [];
  const e = included.find((n) => String(n.$type).endsWith('.ProfessionalEvent'));
  const id = e === undefined ? undefined : eventIdOf(String(e.entityUrn));
  if (e === undefined || id === undefined || typeof e.name !== 'string') {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the event response carried no event',
      hint: 're-capture the event page',
    };
  }
  const byUrn = new Map<unknown, Node>(included.map((n) => [n.entityUrn, n]));
  const range = (e.timeRange ?? {}) as { start?: unknown; end?: unknown };
  const address = (e.address ?? null) as Node | null;
  const place =
    address === null
      ? undefined
      : [address.city, address.geographicArea, address.country]
          .filter((x) => typeof x === 'string' && x !== '')
          .join(', ');
  const status = byUrn.get(e['*viewerStatus'])?.scheduledContentViewerStatus;
  const attendees = Number(
    txt(e.socialProof)
      ?.match(/^(\d[\d,.\s]*)/)?.[1]
      ?.replace(/[,.\s]/g, ''),
  );
  const out: EventDetail = {
    id,
    name: e.name,
    online: typeof e.broadcastTool === 'string' || (address === null && e.venueDetails === null),
    url: eventLink(id),
  };
  const set = <K extends keyof EventDetail>(k: K, v: EventDetail[K] | undefined) => {
    if (v !== undefined && v !== '') out[k] = v;
  };
  set(
    'when',
    typeof e.displayEventTime === 'string' ? e.displayEventTime.replace(/\n/g, ' – ') : undefined,
  );
  set('start', typeof range.start === 'number' ? new Date(range.start).toISOString() : undefined);
  set('end', typeof range.end === 'number' ? new Date(range.end).toISOString() : undefined);
  set('timeZone', typeof e.timeZone === 'string' ? e.timeZone : undefined);
  set('state', typeof e.lifecycleState === 'string' ? e.lifecycleState : undefined);
  if (e.cancelled === true) out.cancelled = true;
  set('attendees', Number.isFinite(attendees) ? attendees : undefined);
  set('organizer', organizerOf(e, byUrn));
  set('place', place);
  set('site', typeof e.externalUrl === 'string' ? e.externalUrl : undefined);
  if (e.privateEvent === true) out.private = true;
  if (e.premiumEvent === true) out.premium = true;
  // NOT_INTERESTED is LinkedIn's default for no response at all, not a "no".
  set('you', typeof status === 'string' && status !== 'NOT_INTERESTED' ? status : undefined);
  set('description', txt(e.description));
  return { ok: true, event: out };
}
