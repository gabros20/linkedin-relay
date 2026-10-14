// ─── `lnrelay my-items posts|learning|jobs` ───────────────────────────────────
//
// The owner's My items, read only; see engine/my-items.ts. Saved posts and
// learning are one list each; the job tracker is one list per stage, so jobs
// with no --stage read all five. Everything spends the page budget.

import { createLiveClient } from '../engine/index.ts';
import {
  ITEMS,
  ITEMS_PAGE,
  type ItemList,
  itemsUrl,
  parseItems,
  STAGES,
  type Stage,
} from '../engine/my-items.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. */
export type ItemsFetch = (url: string, spendClass: 'page') => Promise<Fetched>;

function liveFetch(quiet: boolean): ItemsFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('my-items', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: 'my-items' });
    return r.ok ? { ok: true, json: r.json } : r;
  };
}

export interface ItemsRequest {
  limit: number;
  stage?: Stage;
}

type Row = Record<string, unknown>;

/** One list (or one tracker stage), paged to the limit. */
async function collect(get: ItemsFetch, list: ItemList, want: number, stage?: Stage) {
  const items: Row[] = [];
  let token: string | undefined;
  for (let start = 0; items.length < want; start += ITEMS_PAGE) {
    const res = await get(
      itemsUrl(list, { start, ...(stage ? { stage } : {}), ...(token ? { token } : {}) }),
      'page',
    );
    const page = res.ok ? parseItems(list, res.json, stage) : res;
    if (!page.ok)
      return items.length === 0 ? page : { items, complete: false, stoppedBy: page.code };
    const room = want - items.length;
    items.push(...(page.items as unknown as Row[]).slice(0, room));
    // The limit cut this page short: there is more.
    if (page.items.length > room) return { items, complete: false };
    const last =
      page.items.length < ITEMS_PAGE ||
      (page.total !== undefined && start + ITEMS_PAGE >= page.total);
    if (last) return { items, complete: true };
    token = page.token;
  }
  return { items, complete: false };
}

function compactRow(r: Row): string {
  return line(
    [
      r.id,
      r.title ?? r.name ?? r.author,
      r.company ?? r.length ?? r.authorHeadline,
      r.location ?? r.detail ?? r.posted,
      r.workplace,
      r.stage,
      r.note ?? r.progress,
      typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').slice(0, 140) : undefined,
      r.url,
    ].map((x) => (typeof x === 'string' ? x : undefined)),
  );
}

interface Gathered {
  items: Row[];
  byStage: Record<string, number>;
  complete: boolean;
  stoppedBy?: string;
}

/** Each stage in turn (one, for posts and learning) until the limit; a stage that fails is noted. */
async function collectStages(
  get: ItemsFetch,
  which: ItemList,
  want: number,
  stages: (Stage | undefined)[],
): Promise<Gathered | { failure: { code: string; message: string; hint?: string } }> {
  const out: Gathered = { items: [], byStage: {}, complete: true };
  let failure: { code: string; message: string; hint?: string } | undefined;
  for (const stage of stages) {
    const got = await collect(get, which, want - out.items.length, stage);
    if ('ok' in got) {
      failure = failure ?? got;
      out.complete = false;
      out.stoppedBy = got.code;
      continue;
    }
    out.items.push(...got.items);
    if (stage !== undefined) out.byStage[stage] = got.items.length;
    out.complete &&= got.complete;
    if (got.stoppedBy !== undefined) out.stoppedBy = got.stoppedBy;
    if (out.items.length >= want) break;
  }
  // Nothing read at all, and something failed: a failure, not an empty list.
  if (out.items.length === 0 && failure !== undefined) return { failure };
  return out;
}

export async function runMyItems(
  list: string | undefined,
  req: ItemsRequest,
  opts: OutputOpts = {},
  fetch?: ItemsFetch,
): Promise<Envelope> {
  if (list === undefined || !(list in ITEMS))
    return err(
      'my-items',
      'INVALID_INPUT',
      `no list '${list ?? ''}'`,
      `one of: ${Object.keys(ITEMS).join(', ')}`,
    );
  if (req.stage !== undefined && !(req.stage in STAGES))
    return err(
      'my-items',
      'INVALID_INPUT',
      `no stage '${req.stage}'`,
      `one of: ${Object.keys(STAGES).join(', ')}`,
    );
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;
  const want = Math.max(1, req.limit);
  const which = list as ItemList;

  const stages: (Stage | undefined)[] =
    which === 'jobs'
      ? req.stage !== undefined
        ? [req.stage]
        : (Object.keys(STAGES) as Stage[])
      : [undefined];
  const got = await collectStages(get, which, want, stages);
  if ('failure' in got) {
    const f = got.failure;
    return err('my-items', f.code, f.message, f.hint);
  }
  const { items, byStage, complete, stoppedBy } = got;
  return ok('my-items', {
    list: which,
    items: shape(items, opts, compactRow),
    meta: {
      state: complete && stoppedBy === undefined ? 'complete' : 'partial',
      operation: `my-items ${which}`,
      returnedCount: items.length,
      ...(which === 'jobs' && req.stage === undefined ? { byStage } : {}),
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    },
  });
}
