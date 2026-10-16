// ─── `lnrelay viewers` ────────────────────────────────────────────────────────
//
// Who viewed the owner's profile, as their profile-views page shows it; see
// engine/profile-views.ts. Two page calls: the total, then the viewers. A free
// account is shown up to 3 viewers of the total, so the result is `partial`
// whenever LinkedIn counts more than it shows.

import { createLiveClient } from '../engine/index.ts';
import {
  parseViewers,
  parseViewTotals,
  VIEW_TOTALS_URL,
  VIEWERS_URL,
  type Viewer,
  viewersBody,
  viewTotalsBody,
} from '../engine/profile-views.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope, FetchState } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; raw: string }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted POST. Injectable so tests send nothing. */
export type ViewersFetch = (url: string, body: unknown, spendClass: 'page') => Promise<Fetched>;

function liveFetch(quiet: boolean): ViewersFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('viewers', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, body, spendClass) => {
    const r = await client.request({ url, method: 'POST', body, spendClass, operation: 'viewers' });
    if (!r.ok) return r;
    return { ok: true, raw: (r.classification as { raw?: string }).raw ?? '' };
  };
}

const compactViewer = (v: Viewer) =>
  'anonymous' in v
    ? line(['anonymous', v.description, v.viewed])
    : line([v.name, v.degree, v.headline, v.viewed, v.url]);

export async function runViewers(opts: OutputOpts = {}, fetch?: ViewersFetch): Promise<Envelope> {
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;

  const totalsRes = await get(VIEW_TOTALS_URL, viewTotalsBody(), 'page');
  const totals = totalsRes.ok ? parseViewTotals(totalsRes.raw) : totalsRes;
  const listRes = await get(VIEWERS_URL, viewersBody(), 'page');
  const list = listRes.ok ? parseViewers(listRes.raw) : listRes;
  if (!list.ok) return err('viewers', list.code, list.message, list.hint);

  const shown = list.viewers.length;
  const state: FetchState = !totals.ok ? 'unknown' : totals.total > shown ? 'partial' : 'complete';
  return ok('viewers', {
    ...(totals.ok
      ? { total: totals.total, ...(totals.period !== undefined ? { period: totals.period } : {}) }
      : { totalError: `${totals.code}: ${totals.message}` }),
    ...(list.privateViewers !== undefined ? { privateViewers: list.privateViewers } : {}),
    items: shape(list.viewers, opts, compactViewer),
    meta: { state, operation: 'viewers', returnedCount: shown },
  });
}
