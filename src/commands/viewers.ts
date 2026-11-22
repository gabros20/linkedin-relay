// ─── `lnrelay viewers` ────────────────────────────────────────────────────────
//
// Who viewed the owner's profile, as their profile-views page shows it; see
// engine/profile-views.ts. Two page calls: the total, then the viewers. A free
// account is shown up to 3 viewers of the total, Premium every one; the result
// is `partial` whenever LinkedIn counts more than it names and counts as
// private. Premium also takes a range (--days) and adds highlights and the
// companies viewers work at.

import { createLiveClient } from '../engine/index.ts';
import {
  parseViewers,
  parseViewTotals,
  VIEW_TOTALS_URL,
  VIEWERS_REFERER,
  VIEWERS_URL,
  type Viewer,
  type ViewRange,
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
    const r = await client.request({
      url,
      method: 'POST',
      body,
      headers: { referer: VIEWERS_REFERER },
      spendClass,
      operation: 'viewers',
    });
    if (!r.ok) return r;
    return { ok: true, raw: (r.classification as { raw?: string }).raw ?? '' };
  };
}

const compactViewer = (v: Viewer) =>
  'anonymous' in v
    ? line(['anonymous', v.description, v.viewed])
    : line([v.name, v.degree, v.headline, v.viewed, v.url]);

export async function runViewers(
  opts: OutputOpts & { days?: ViewRange } = {},
  fetch?: ViewersFetch,
): Promise<Envelope> {
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;

  const totalsRes = await get(VIEW_TOTALS_URL, viewTotalsBody(opts.days), 'page');
  const totals = totalsRes.ok ? parseViewTotals(totalsRes.raw) : totalsRes;
  const listRes = await get(VIEWERS_URL, viewersBody(opts.days), 'page');
  const list = listRes.ok ? parseViewers(listRes.raw) : listRes;
  if (!list.ok) return err('viewers', list.code, list.message, list.hint);

  const shown = list.viewers.length;
  // Complete when the named and the private add up to the total exactly. A
  // free account's counts do not (3 named and 4 private of 5): it holds back.
  const accounted =
    totals.ok && (totals.total <= shown || shown + (list.privateViewers ?? 0) === totals.total);
  const state: FetchState = !totals.ok ? 'unknown' : accounted ? 'complete' : 'partial';
  const { ok: _ok, ...summary } = totals.ok ? totals : { ok: false };
  return ok('viewers', {
    ...(opts.days !== undefined ? { days: opts.days } : {}),
    ...(totals.ok ? summary : { totalError: `${totals.code}: ${totals.message}` }),
    ...(list.privateViewers !== undefined ? { privateViewers: list.privateViewers } : {}),
    items: shape(list.viewers, opts, compactViewer),
    meta: { state, operation: 'viewers', returnedCount: shown },
  });
}
