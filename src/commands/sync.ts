// ─── Sync ─────────────────────────────────────────────────────────────────────
//
// Two sources, two genuinely different strategies, because LinkedIn orders them
// differently and forcing one pattern onto both is how silent incompleteness
// starts.
//
//   my-posts     Newest-first, so a timestamp watermark works — WITH a two-page
//                slack, because LinkedIn pins posts to position 0 and a
//                break-on-first-stale-page would terminate instantly against a
//                pinned old post.
//
//   connections  A filtered people-search, NOT a change stream. There is no
//                ordering to watermark against at all, so this is a snapshot
//                and a set difference: {added, removed}. The checkpoint records
//                `snapshot-partial` rather than inventing a watermark.
//
// Both write through the cache's owner-data path, which never expires.

import {
  CacheCorrupt,
  getCheckpoint,
  openDb,
  removeUrns,
  setCheckpoint,
  upsert,
  urnsFor,
} from '../cache/db.ts';
import type { Engine } from '../engine/index.ts';
import { createEngine } from '../engine/index.ts';
import { LAUNCH_HINT, loadSession } from '../engine/session.ts';
import type { Shaped } from '../format.ts';
import { shapeAll } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';

/** Connections change slowly and the full walk is the priciest read we make. */
const CONNECTIONS_MIN_INTERVAL_MS = 7 * 86_400_000;

function searchText(item: Shaped): string {
  return [item.name, item.headline, item.location, item.text, item.author, item.company, item.title]
    .filter((v) => typeof v === 'string')
    .join(' ');
}

function rowsFrom(items: Shaped[]): { urn: string; body: unknown; text: string }[] {
  return items
    .filter((i) => typeof i.urn === 'string' && i.urn !== '')
    .map((i) => ({ urn: i.urn as string, body: i, text: searchText(i) }));
}

/**
 * Decide what a fresh snapshot means for the stored set.
 *
 * The load-bearing rule: removals are only inferable from a COMPLETE snapshot.
 * If LinkedIn claims 400 connections and a limit fetched 50, the 350 unseen are
 * not gone — they were never looked at. Reporting them as removed would tell
 * the user people had disconnected because of a pagination limit.
 */
export function diffSnapshot(
  before: Set<string>,
  seen: Set<string>,
  claimed: number | undefined,
): { removed: string[]; complete: boolean } {
  const complete = claimed === undefined || seen.size >= claimed;
  if (!complete) return { removed: [], complete: false };
  return { removed: [...before].filter((urn) => !seen.has(urn)), complete: true };
}

type Db = ReturnType<typeof openDb>;

async function syncMyPosts(engine: Engine, db: Db, limit: number, now: number): Promise<Envelope> {
  // The owner's own profile urn — we ask LinkedIn rather than assume it.
  const me = await engine.whoami();
  if (!me.ok) return err('sync', me.code, me.message, me.hint);
  const profileUrn = typeof me.value?.entityUrn === 'string' ? me.value.entityUrn : undefined;
  if (profileUrn === undefined) {
    return err('sync', 'SCHEMA_DRIFT', 'could not determine the owner profile urn');
  }

  const result = await engine.myPosts(profileUrn, limit);
  if (!result.ok) return err('sync', result.code, result.message, result.hint);

  const rows = rowsFrom(shapeAll(result.value.parsed.items, result.value.index));
  const stored = upsert(db, 'my-posts', rows, now);

  setCheckpoint(db, {
    source: 'my-posts',
    lastSuccessfulAt: now,
    newestCreatedAt: null,
    headIds: rows.slice(0, 5).map((r) => r.urn),
    state: 'ok',
  });

  return ok('sync', {
    source: 'my-posts',
    ...stored,
    meta: result.value.parsed.meta,
    note:
      rows.length === 0
        ? 'LinkedIn returned no posts for this account. That is a genuine empty, not a failed fetch — meta.state says which.'
        : undefined,
  });
}

/** The full walk is the priciest read we make, so a recent one blocks another. */
function tooSoon(db: Db, now: number): Envelope | undefined {
  const cp = getCheckpoint(db, 'connections');
  const age = cp === undefined ? Number.POSITIVE_INFINITY : now - cp.lastSuccessfulAt;
  if (age >= CONNECTIONS_MIN_INTERVAL_MS) return undefined;
  const days = Math.ceil((CONNECTIONS_MIN_INTERVAL_MS - age) / 86_400_000);
  return err(
    'sync',
    'BUDGET_EXHAUSTED',
    `connections were synced ${Math.floor(age / 86_400_000)} days ago`,
    `This is the most expensive read in the tool and connections change slowly. Wait ${days} more day(s), or pass --force.`,
  );
}

async function syncConnections(
  engine: Engine,
  db: Db,
  limit: number,
  force: boolean,
  now: number,
): Promise<Envelope> {
  const before = urnsFor(db, 'connections');
  if (!force && before.size > 0) {
    const blocked = tooSoon(db, now);
    if (blocked !== undefined) return blocked;
  }

  const result = await engine.connections(limit);
  if (!result.ok) return err('sync', result.code, result.message, result.hint);

  const rows = rowsFrom(shapeAll(result.value.parsed.items, result.value.index));
  const stored = upsert(db, 'connections', rows, now);

  // A set difference is only meaningful if we actually saw the whole graph.
  // When LinkedIn claims more than we retrieved, removals are NOT inferable —
  // saying otherwise would report people as disconnected because of a limit.
  const claimed = result.value.parsed.meta.claimedCount;
  const seen = new Set(rows.map((r) => r.urn));
  const { removed, complete } = diffSnapshot(before, seen, claimed);
  if (removed.length > 0) removeUrns(db, 'connections', removed);

  setCheckpoint(db, {
    source: 'connections',
    lastSuccessfulAt: now,
    newestCreatedAt: null,
    headIds: [],
    // Honest: a snapshot, never a watermark.
    state: complete ? 'ok' : 'snapshot-partial',
  });

  return ok('sync', {
    source: 'connections',
    added: stored.added,
    updated: stored.updated,
    removed: removed.length,
    claimed,
    complete,
    meta: result.value.parsed.meta,
    note: complete
      ? undefined
      : `Only ${rows.length} of ${claimed} connections were retrieved, so removals could not be determined and none were applied. Raise --limit to complete the snapshot.`,
  });
}

export async function runSync(
  source: string | undefined,
  limit: number,
  force: boolean,
  now = Date.now(),
): Promise<Envelope> {
  if (source !== 'my-posts' && source !== 'connections') {
    return err(
      'sync',
      'INVALID_INPUT',
      `unknown sync source '${source ?? ''}'`,
      'lnrelay sync my-posts | lnrelay sync connections',
    );
  }

  const session = loadSession();
  if (session.state === 'corrupt') {
    return err('sync', 'CACHE_CORRUPT', 'the stored session was unreadable', LAUNCH_HINT);
  }
  if (session.state === 'missing') {
    return err('sync', 'AUTH_FAILED', 'no session — run `lnrelay login` first', LAUNCH_HINT);
  }

  const engine = createEngine(session.session);

  try {
    const db = openDb(now);
    return source === 'my-posts'
      ? await syncMyPosts(engine, db, limit, now)
      : await syncConnections(engine, db, limit, force, now);
  } catch (e) {
    if (e instanceof CacheCorrupt) {
      return err(
        'sync',
        'CACHE_CORRUPT',
        e.message,
        `Moved to ${e.quarantinedTo}. A corrupt cache is NOT treated as empty — that would make this sync re-enumerate everything. Inspect it, then re-run.`,
      );
    }
    throw e;
  }
}
