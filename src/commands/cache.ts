// Cache-backed commands. These make no network call at all — after a research
// session, repeat lookups are free, which is the whole point of keeping a local
// store on a platform where every request is rationed.

import {
  CacheCorrupt,
  count,
  getCheckpoint,
  openDb,
  purge as purgeDb,
  type Source,
  search as searchDb,
  upsert,
} from '../cache/db.ts';
import type { Shaped } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';

const SOURCES: Source[] = ['connections', 'my-posts', 'third-party'];

/** Turn a CacheCorrupt into an envelope; rethrow anything else. */
function corruptEnvelope(command: string, e: unknown): Envelope {
  if (e instanceof CacheCorrupt) {
    return err(
      command,
      'CACHE_CORRUPT',
      e.message,
      `Moved to ${e.quarantinedTo}. A corrupt cache is NOT treated as an empty one — that would ` +
        'trigger a full re-sync against LinkedIn. Inspect it, then re-run.',
    );
  }
  throw e;
}

export function runLocal(
  query: string | undefined,
  sources: string | undefined,
  since: string | undefined,
  limit: number,
): Envelope {
  const requested = sources?.split(',').map((s) => s.trim()) ?? SOURCES;
  const invalid = requested.filter((s) => !SOURCES.includes(s as Source));
  if (invalid.length > 0) {
    return err(
      'local',
      'INVALID_INPUT',
      `unknown source(s): ${invalid.join(', ')}`,
      `valid sources: ${SOURCES.join(', ')}`,
    );
  }

  let sinceMs: number | undefined;
  if (since !== undefined) {
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      return err('local', 'INVALID_INPUT', `could not parse --since '${since}'`, 'use YYYY-MM-DD');
    }
    sinceMs = parsed;
  }

  try {
    const db = openDb();
    const rows = searchDb(db, query ?? '', {
      sources: requested as Source[],
      ...(sinceMs === undefined ? {} : { since: sinceMs }),
      limit,
    });
    const total = count(db);

    return ok('local', {
      items: rows.map((r) => ({
        ...(JSON.parse(r.body ?? '{}') as Shaped),
        source: r.source,
        cachedAt: new Date(r.updatedAt).toISOString(),
      })),
      meta: {
        returnedCount: rows.length,
        cachedTotal: total,
        sources: requested,
        // An empty cache is not an empty LinkedIn — say which one this is.
        note:
          total === 0
            ? 'The local cache is empty. Run a read command with --retain, or sync a source, before searching offline.'
            : undefined,
      },
    });
  } catch (e) {
    return corruptEnvelope('local', e);
  }
}

export function runPurge(scope: string | undefined, confirmed: boolean): Envelope {
  const target = scope === 'all' ? 'all' : 'third-party';

  if (!confirmed) {
    try {
      const db = openDb();
      return err(
        'purge',
        'CONFIRMATION_REQUIRED',
        `would delete ${target === 'all' ? count(db) : count(db, 'third-party')} records (${target})`,
        'Re-run with --confirm. This only touches local files; it never contacts LinkedIn.',
      );
    } catch (e) {
      return corruptEnvelope('purge', e);
    }
  }

  try {
    const db = openDb();
    const removed = purgeDb(db, target);
    return ok('purge', { scope: target, removed, remaining: count(db) });
  } catch (e) {
    return corruptEnvelope('purge', e);
  }
}

export function runCacheStatus(): Envelope {
  try {
    const db = openDb();
    return ok('cache-status', {
      total: count(db),
      bySource: Object.fromEntries(SOURCES.map((s) => [s, count(db, s)])),
      checkpoints: Object.fromEntries(SOURCES.map((s) => [s, getCheckpoint(db, s) ?? null])),
      retention:
        'Third-party records expire 30 days after capture; the body is deleted and an identity ' +
        'stub remains so a re-fetch is a visible choice. Owner data never expires.',
    });
  } catch (e) {
    return corruptEnvelope('cache-status', e);
  }
}

/**
 * Retain shaped rows from a live read. Opt-in (`--retain`) rather than
 * automatic: caching every profile you glance at recreates a personal data
 * lake, which is exactly the shape the risk research warns against.
 */
export type RetainResult = { added: number; updated: number } | { skipped: string };

export function retain(source: Source, items: Shaped[]): RetainResult {
  const rows = items
    .filter((i) => typeof i.urn === 'string' && i.urn !== '')
    .map((i) => ({
      urn: i.urn as string,
      body: i,
      text: [i.name, i.headline, i.location, i.text, i.author, i.company, i.title]
        .filter((v) => typeof v === 'string')
        .join(' '),
    }));
  if (rows.length === 0) return { skipped: 'no items carried a urn to key on' };

  try {
    return upsert(openDb(), source, rows);
  } catch (e) {
    // Retention never fails the read the user actually asked for — but it says
    // WHY it did nothing. Returning a silent null here cost real debugging time
    // once already.
    return { skipped: (e as Error).message };
  }
}
