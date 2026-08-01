// ─── The local store ──────────────────────────────────────────────────────────
//
// SQLite (`bun:sqlite`, WAL) behind the same narrow load/save/query interface
// the family's JSON store exposes. The family similarity that matters is the
// interface, not the file format.
//
// SQLite was chosen for one specific reason: it makes "corrupt" a detectable,
// per-source, quarantinable state. In a single JSON blob, corruption is
// all-or-nothing and tells you nothing about which records survived — and on
// this platform an empty-looking cache is what triggers a full re-sync against
// the most hostile host in the research. TTL expiry as a transactional delete
// rather than a whole-file rewrite is the second reason.
//
// Retention is enforced on the READ path, not by a schedule. There is no cron
// to forget and no purge command to remember: the only code that can observe
// expired third-party data is the code that deletes it first.

import { Database } from 'bun:sqlite';
import { mkdirSync, renameSync } from 'node:fs';
import { cacheDir, cachePath } from './store.ts';

const DB_FILE = 'cache.db';

/** Third-party rows expire; owner rows do not. */
export const THIRD_PARTY_TTL_MS = 30 * 86_400_000;

export type Source = 'connections' | 'my-posts' | 'third-party';

export interface Record_ {
  urn: string;
  source: Source;
  /** Shaped JSON. Null once expired — the identity stub survives, the body does not. */
  body: string | null;
  text: string;
  firstSeenAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS records (
     urn         TEXT NOT NULL,
     source      TEXT NOT NULL,
     body        TEXT,
     text        TEXT NOT NULL DEFAULT '',
     firstSeenAt INTEGER NOT NULL,
     updatedAt   INTEGER NOT NULL,
     expiresAt   INTEGER,
     PRIMARY KEY (urn, source)
   )`,
  'CREATE INDEX IF NOT EXISTS records_source ON records(source)',
  'CREATE INDEX IF NOT EXISTS records_expires ON records(expiresAt)',
  `CREATE TABLE IF NOT EXISTS checkpoints (
     source          TEXT PRIMARY KEY,
     lastSuccessfulAt INTEGER NOT NULL,
     newestCreatedAt  INTEGER,
     headIds          TEXT NOT NULL DEFAULT '[]',
     state            TEXT NOT NULL DEFAULT 'ok'
   )`,
];

export class CacheCorrupt extends Error {
  constructor(
    message: string,
    readonly quarantinedTo: string,
  ) {
    super(message);
    this.name = 'CacheCorrupt';
  }
}

/**
 * Open the store. A database that fails its integrity check is QUARANTINED and
 * the error is thrown — never silently replaced with an empty one, because an
 * empty cache is operationally active here: it is precisely what makes `sync`
 * enumerate everything again.
 */
export function openDb(now = Date.now()): Database {
  mkdirSync(cacheDir(), { recursive: true });
  const path = cachePath(DB_FILE);

  let db: Database;
  try {
    db = new Database(path, { create: true });
    const check = db.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null;
    if (check?.integrity_check !== undefined && check.integrity_check !== 'ok') {
      throw new Error(`integrity_check: ${check.integrity_check}`);
    }
  } catch (e) {
    throw quarantine(path, (e as Error).message, now);
  }

  db.run('PRAGMA journal_mode = WAL');
  for (const stmt of SCHEMA) db.run(stmt);
  sweepExpired(db, now);
  return db;
}

function quarantine(path: string, reason: string, now: number): CacheCorrupt {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = cachePath('quarantine', stamp, DB_FILE);
  try {
    mkdirSync(cachePath('quarantine', stamp), { recursive: true });
    renameSync(path, target);
  } catch {
    // Even if it cannot be moved, the caller must still refuse to proceed.
  }
  return new CacheCorrupt(
    `the local cache was unreadable and has been quarantined: ${reason}`,
    target,
  );
}

/**
 * Expire third-party bodies. The row survives as an identity stub so a re-fetch
 * is a VISIBLE choice — the budget can say "14 of these 20 are re-fetches of
 * expired records" instead of quietly charging for them again.
 */
export function sweepExpired(db: Database, now = Date.now()): number {
  const result = db.run(
    "UPDATE records SET body = NULL, text = '' WHERE expiresAt IS NOT NULL AND expiresAt <= ? AND body IS NOT NULL",
    [now],
  );
  return result.changes;
}

export function upsert(
  db: Database,
  source: Source,
  rows: { urn: string; body: unknown; text: string }[],
  now = Date.now(),
): { added: number; updated: number } {
  const expiresAt = source === 'third-party' ? now + THIRD_PARTY_TTL_MS : null;
  let added = 0;
  let updated = 0;

  const exists = db.query('SELECT 1 FROM records WHERE urn = ? AND source = ?');
  const write = db.query(
    `INSERT INTO records (urn, source, body, text, firstSeenAt, updatedAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(urn, source) DO UPDATE SET
       body = excluded.body, text = excluded.text,
       updatedAt = excluded.updatedAt, expiresAt = excluded.expiresAt`,
  );

  db.transaction(() => {
    for (const row of rows) {
      if (exists.get(row.urn, source) === null) added++;
      else updated++;
      write.run(row.urn, source, JSON.stringify(row.body), row.text, now, now, expiresAt);
    }
  })();

  return { added, updated };
}

export function count(db: Database, source?: Source): number {
  const row =
    source === undefined
      ? (db.query('SELECT COUNT(*) AS n FROM records').get() as { n: number })
      : (db.query('SELECT COUNT(*) AS n FROM records WHERE source = ?').get(source) as {
          n: number;
        });
  return row.n;
}

/** Offline search. Substring match over the flattened text of each record. */
export function search(
  db: Database,
  query: string,
  opts: { sources?: Source[]; since?: number; limit?: number } = {},
): Record_[] {
  const sources = opts.sources ?? ['connections', 'my-posts', 'third-party'];
  const placeholders = sources.map(() => '?').join(',');
  const params: (string | number)[] = [...sources];

  let sql = `SELECT * FROM records WHERE source IN (${placeholders}) AND body IS NOT NULL`;
  if (query !== '') {
    sql += ' AND lower(text) LIKE ?';
    params.push(`%${query.toLowerCase()}%`);
  }
  if (opts.since !== undefined) {
    sql += ' AND updatedAt >= ?';
    params.push(opts.since);
  }
  sql += ' ORDER BY updatedAt DESC LIMIT ?';
  params.push(opts.limit ?? 25);

  return db.query(sql).all(...params) as Record_[];
}

export function urnsFor(db: Database, source: Source): Set<string> {
  const rows = db.query('SELECT urn FROM records WHERE source = ?').all(source) as {
    urn: string;
  }[];
  return new Set(rows.map((r) => r.urn));
}

export function removeUrns(db: Database, source: Source, urns: string[]): number {
  if (urns.length === 0) return 0;
  const stmt = db.query('DELETE FROM records WHERE source = ? AND urn = ?');
  let removed = 0;
  db.transaction(() => {
    for (const urn of urns) removed += stmt.run(source, urn).changes;
  })();
  return removed;
}

// ─── Checkpoints ──────────────────────────────────────────────────────────────

export interface Checkpoint {
  source: string;
  lastSuccessfulAt: number;
  newestCreatedAt: number | null;
  headIds: string[];
  /** `snapshot-partial` where no ordering exists — never a fabricated watermark. */
  state: 'ok' | 'snapshot-partial';
}

export function getCheckpoint(db: Database, source: Source): Checkpoint | undefined {
  const row = db.query('SELECT * FROM checkpoints WHERE source = ?').get(source) as
    | (Omit<Checkpoint, 'headIds'> & { headIds: string })
    | null;
  if (row === null) return undefined;
  return { ...row, headIds: JSON.parse(row.headIds) as string[] };
}

export function setCheckpoint(db: Database, cp: Checkpoint): void {
  db.run(
    `INSERT INTO checkpoints (source, lastSuccessfulAt, newestCreatedAt, headIds, state)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       lastSuccessfulAt = excluded.lastSuccessfulAt,
       newestCreatedAt = excluded.newestCreatedAt,
       headIds = excluded.headIds,
       state = excluded.state`,
    [cp.source, cp.lastSuccessfulAt, cp.newestCreatedAt, JSON.stringify(cp.headIds), cp.state],
  );
}

export function purge(db: Database, scope: 'all' | 'third-party'): number {
  const result =
    scope === 'all'
      ? db.run('DELETE FROM records')
      : db.run("DELETE FROM records WHERE source = 'third-party'");
  if (scope === 'all') db.run('DELETE FROM checkpoints');
  return result.changes;
}
