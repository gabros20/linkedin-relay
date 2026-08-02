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
import { compactRows, project, type Shaped } from '../format.ts';
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

export interface LocalOpts {
  compact?: boolean;
  fields?: string;
}

/** The cache path honours the same output flags as the live path. */
function render(rows: Record<string, unknown>[], opts: LocalOpts): unknown[] {
  if (opts.compact === true) return compactRows(rows);
  if (opts.fields !== undefined && opts.fields !== '') return project(rows, opts.fields);
  return rows;
}

export function runLocal(
  query: string | undefined,
  sources: string | undefined,
  since: string | undefined,
  limit: number,
  opts: LocalOpts = {},
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

    const shaped = rows.map((r) => ({
      ...(JSON.parse(r.body ?? '{}') as Shaped),
      source: r.source,
      cachedAt: new Date(r.updatedAt).toISOString(),
    }));

    return ok('local', {
      items: render(shaped, opts),
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

/**
 * `connections` and `my-posts` are the same offline read as `local`, with the
 * source pinned. They exist as separate commands because that is how a user
 * thinks about their own data — `--sync` fills them, they read from cache.
 */
export function runSourceRead(
  command: 'connections' | 'my-posts',
  query: string | undefined,
  limit: number,
  opts: LocalOpts = {},
): Envelope {
  const result = runLocal(query, command, undefined, limit, opts);
  if (!result.ok) return result;
  const data = result.data as Record<string, unknown>;
  const meta = data.meta as Record<string, unknown>;
  if ((meta.cachedTotal as number) === 0 || (meta.returnedCount as number) === 0) {
    meta.note = `Nothing cached for '${command}'. Run \`lnrelay sync ${command}\` first — this command reads the local cache and makes no network call.`;
  }
  return ok(command, data);
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
