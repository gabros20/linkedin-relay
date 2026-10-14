// ─── `lnrelay network [list]` ─────────────────────────────────────────────────
//
// The owner's My Network, read only; see engine/network.ts. With no list, the
// count of each (one call each); with a list, its rows. Everything spends the
// page budget. Nothing here clears a badge or marks anything seen.

import { createLiveClient } from '../engine/index.ts';
import {
  HUB,
  HUB_PAGE,
  type HubList,
  hubUrl,
  parseHub,
  parseSentInvitations,
  type SentInvitation,
  sentInvitationsUrl,
} from '../engine/network.ts';
import type { Person } from '../engine/people.ts';
import type { Found } from '../engine/search.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line, metaOf, type PageFetch, type Paging, searchAll } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. */
export type NetworkFetch = (url: string, spendClass: 'page') => Promise<Fetched>;

function liveFetch(quiet: boolean): NetworkFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('network', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: 'network' });
    return r.ok ? { ok: true, json: r.json } : r;
  };
}

export interface NetworkRequest {
  limit: number;
  start?: number;
}

const LISTS = [...Object.keys(HUB), 'invitations'];
const PAGING: Paging = { pageSize: HUB_PAGE, max: 1000 };
const INVITATIONS_PAGE = 10;

function compactRow(r: Person | Found): string {
  const p = r as Person & Found;
  return line([p.id, p.name, p.headline ?? p.subtitle, p.location ?? p.detail, p.degree, p.url]);
}

async function counts(get: NetworkFetch): Promise<{ counts: Record<string, number> } | Envelope> {
  const out: Record<string, number> = {};
  for (const list of Object.keys(HUB) as HubList[]) {
    const res = await get(hubUrl(list, 0), 'page');
    const page = res.ok ? parseHub(list, res.json) : res;
    if (!page.ok) return err('network', page.code, `${list}: ${page.message}`, page.hint);
    out[list] = page.total ?? page.items.length;
  }
  const res = await get(sentInvitationsUrl(0, INVITATIONS_PAGE), 'page');
  const inv = res.ok ? parseSentInvitations(res.json) : res;
  if (!inv.ok) return err('network', inv.code, `invitations: ${inv.message}`);
  // The resource gives no total: a full page means "at least".
  out.invitationsSent = inv.invitations.length;
  return { counts: out };
}

async function invitations(
  get: NetworkFetch,
  req: NetworkRequest,
  opts: OutputOpts,
): Promise<Envelope> {
  const all: SentInvitation[] = [];
  let exhausted = false;
  let stoppedBy: string | undefined;
  for (let start = req.start ?? 0; all.length < req.limit; start += INVITATIONS_PAGE) {
    const res = await get(sentInvitationsUrl(start, INVITATIONS_PAGE), 'page');
    const page = res.ok ? parseSentInvitations(res.json) : res;
    if (!page.ok) {
      if (all.length === 0) return err('network', page.code, page.message);
      stoppedBy = page.code;
      break;
    }
    all.push(...page.invitations.slice(0, req.limit - all.length));
    if (page.invitations.length < INVITATIONS_PAGE) {
      exhausted = true;
      break;
    }
  }
  return ok('network', {
    list: 'invitations',
    items: shape(all, opts, (i) =>
      line([i.id, i.to, i.headline, i.sent?.slice(0, 10), i.note, i.url]),
    ),
    meta: {
      state: exhausted && stoppedBy === undefined ? 'complete' : 'partial',
      operation: 'network invitations',
      returnedCount: all.length,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    },
  });
}

export async function runNetwork(
  list: string | undefined,
  req: NetworkRequest,
  opts: OutputOpts = {},
  fetch?: NetworkFetch,
): Promise<Envelope> {
  if (list !== undefined && !LISTS.includes(list)) {
    return err(
      'network',
      'INVALID_INPUT',
      `no list '${list}'`,
      `one of: ${LISTS.join(', ')} — or none, for the counts`,
    );
  }
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;

  if (list === undefined) {
    const c = await counts(get);
    if (!('counts' in c)) return c;
    return ok('network', { counts: c.counts, meta: { state: 'complete', operation: 'network' } });
  }
  if (list === 'invitations') return invitations(get, req, opts);

  const hub = list as HubList;
  const first = Math.max(0, req.start ?? 0);
  const fetchPage: PageFetch<Person | Found> = async (_keywords, start) => {
    const res = await get(hubUrl(hub, start), 'page');
    const page = res.ok ? parseHub(hub, res.json) : res;
    if (!page.ok) return page;
    return {
      ok: true,
      items: page.items,
      ...(page.total !== undefined ? { total: page.total } : {}),
      unknownTypes: page.unknownTypes,
    };
  };
  const merged = await searchAll(
    fetchPage,
    [undefined],
    first,
    Math.max(1, Math.min(req.limit, PAGING.max - first)),
    PAGING,
  );
  if (merged.rows.length === 0 && merged.failure !== undefined) {
    const f = merged.failure;
    return err('network', f.code, f.message, f.hint);
  }
  return ok('network', {
    list: hub,
    items: shape(merged.rows, opts, compactRow),
    meta: metaOf(`network ${hub}`, merged, true, first),
  });
}
