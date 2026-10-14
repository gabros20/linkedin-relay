// ─── `lnrelay events` and `lnrelay event` ─────────────────────────────────────
//
// The events page's own lists, and one event in full; see engine/events.ts.
// Searching events by keyword is `search events`. Everything spends the page
// budget: the hub is one call, each event one call.

import {
  EVENTS_HUB_URL,
  type EventDetail,
  eventIdOf,
  eventsHubBody,
  eventUrl,
  type HubEvent,
  parseEvent,
  parseEventsHub,
} from '../engine/events.ts';
import { createLiveClient } from '../engine/index.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; raw: string; json?: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted call: a POST when a body is given, a GET otherwise. Injectable for tests. */
export type EventsFetch = (url: string, body: unknown, spendClass: 'page') => Promise<Fetched>;

function liveFetch(command: string, quiet: boolean): EventsFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err(command, 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, body, spendClass) => {
    const r = await client.request({
      url,
      ...(body !== undefined ? { method: 'POST' as const, body } : {}),
      spendClass,
      operation: command,
    });
    if (!r.ok) return r;
    return { ok: true, raw: (r.classification as { raw?: string }).raw ?? '', json: r.json };
  };
}

export interface EventsRequest {
  limit: number;
  /** Only the Premium (LinkedIn Live) events. */
  premium?: boolean;
}

function compactEvent(e: HubEvent): string {
  return line([
    e.id,
    e.name,
    e.when,
    e.organizer,
    e.attendees !== undefined ? `${e.attendees} attendees` : undefined,
    e.premium ? 'Premium' : undefined,
    e.url,
  ]);
}

export async function runEvents(
  req: EventsRequest,
  opts: OutputOpts = {},
  fetch?: EventsFetch,
): Promise<Envelope> {
  const get = fetch ?? liveFetch('events', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const res = await get(EVENTS_HUB_URL, eventsHubBody(), 'page');
  const hub = res.ok ? parseEventsHub(res.raw) : res;
  if (!hub.ok) return err('events', hub.code, hub.message, hub.hint);
  const picked = hub.events.filter((e) => req.premium !== true || e.premium);
  const items = picked.slice(0, Math.max(1, req.limit));
  return ok('events', {
    items: shape(items, opts, compactEvent),
    meta: {
      // The hub is one page LinkedIn chose; it has no "more".
      state: 'complete',
      operation: 'events',
      returnedCount: items.length,
      shownCount: hub.events.length,
    },
  });
}

function compactDetail(e: EventDetail): string {
  return line([
    e.id,
    e.name,
    e.when,
    e.online ? 'online' : e.place,
    e.organizer?.name,
    e.attendees !== undefined ? `${e.attendees} attendees` : undefined,
    e.state,
    e.site ?? e.url,
  ]);
}

export async function runEvent(
  inputs: string[],
  opts: OutputOpts = {},
  fetch?: EventsFetch,
): Promise<Envelope> {
  const ids = inputs.map(eventIdOf);
  if (ids.length === 0 || ids.some((id) => id === undefined)) {
    const bad = inputs.filter((i) => eventIdOf(i) === undefined);
    return err(
      'event',
      'INVALID_INPUT',
      bad.length > 0
        ? `not an event id or URL: ${bad.join(', ')}`
        : 'an event id or URL is required',
      'lnrelay event <id|url> [<id|url> ...]',
    );
  }
  const get = fetch ?? liveFetch('event', opts.quiet === true);
  if (typeof get !== 'function') return get;
  const events: EventDetail[] = [];
  for (const id of [...new Set(ids as string[])]) {
    const res = await get(eventUrl(id), undefined, 'page');
    const parsed = res.ok ? parseEvent(res.json) : res;
    if (!parsed.ok) {
      if (events.length === 0) return err('event', parsed.code, parsed.message, parsed.hint);
      return ok('event', {
        items: shape(events, opts, compactDetail),
        meta: {
          state: 'partial',
          operation: 'event',
          returnedCount: events.length,
          stoppedBy: parsed.code,
        },
      });
    }
    events.push(parsed.event);
  }
  if (events.length === 1 && opts.compact !== true && opts.fields === undefined)
    return ok('event', events[0]);
  return ok('event', {
    items: shape(events, opts, compactDetail),
    meta: { state: 'complete', operation: 'event', returnedCount: events.length },
  });
}
