import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CacheCorrupt,
  count,
  getCheckpoint,
  openDb,
  purge,
  removeUrns,
  search,
  setCheckpoint,
  sweepExpired,
  THIRD_PARTY_TTL_MS,
  upsert,
  urnsFor,
} from '../src/cache/db.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-db-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const row = (urn: string, text: string) => ({ urn, body: { urn, text }, text });

describe('upsert and read', () => {
  test('inserts and counts', () => {
    const db = openDb(T0);
    const r = upsert(db, 'my-posts', [row('urn:li:activity:1', 'hello')], T0);
    expect(r.added).toBe(1);
    expect(count(db, 'my-posts')).toBe(1);
  });

  test('a second write of the same urn updates rather than duplicating', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:activity:1', 'v1')], T0);
    const r = upsert(db, 'my-posts', [row('urn:li:activity:1', 'v2')], T0 + 1000);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    expect(count(db, 'my-posts')).toBe(1);
  });

  test('the same urn in two sources is two records', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:x:1', 'a')], T0);
    upsert(db, 'third-party', [row('urn:li:x:1', 'a')], T0);
    expect(count(db)).toBe(2);
  });
});

// Retention runs on the read path — there is no cron to forget and no purge
// command to remember. The only code that can observe expired third-party data
// is the code that expires it first.
describe('third-party retention', () => {
  test('owner data never expires', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:activity:1', 'mine')], T0);
    expect(sweepExpired(db, T0 + 10 * THIRD_PARTY_TTL_MS)).toBe(0);
    expect(search(db, 'mine')).toHaveLength(1);
  });

  test('third-party data expires after the TTL', () => {
    const db = openDb(T0);
    upsert(db, 'third-party', [row('urn:li:x:1', 'someone else')], T0);
    expect(sweepExpired(db, T0 + THIRD_PARTY_TTL_MS + 1)).toBe(1);
    expect(search(db, 'someone else')).toHaveLength(0);
  });

  test('expiry removes the body but keeps an identity stub', () => {
    const db = openDb(T0);
    upsert(db, 'third-party', [row('urn:li:x:1', 'someone else')], T0);
    sweepExpired(db, T0 + THIRD_PARTY_TTL_MS + 1);
    // The row survives, so a re-fetch is a visible choice rather than a silent
    // charge against the budget.
    expect(count(db, 'third-party')).toBe(1);
    expect(urnsFor(db, 'third-party').has('urn:li:x:1')).toBe(true);
  });

  test('opening the db sweeps automatically', () => {
    const first = openDb(T0);
    upsert(first, 'third-party', [row('urn:li:x:1', 'stale')], T0);
    first.close();

    const second = openDb(T0 + THIRD_PARTY_TTL_MS + 1);
    expect(search(second, 'stale')).toHaveLength(0);
  });
});

describe('offline search', () => {
  test('matches on text, case-insensitively', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:a:1', 'Rust and WebAssembly')], T0);
    expect(search(db, 'rust')).toHaveLength(1);
  });

  test('an empty query returns everything', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:a:1', 'one'), row('urn:li:a:2', 'two')], T0);
    expect(search(db, '')).toHaveLength(2);
  });

  test('filters by source', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:a:1', 'shared')], T0);
    upsert(db, 'connections', [row('urn:li:b:1', 'shared')], T0);
    expect(search(db, 'shared', { sources: ['connections'] })).toHaveLength(1);
  });

  test('never returns an expired record even before a sweep', () => {
    const db = openDb(T0);
    upsert(db, 'third-party', [row('urn:li:x:1', 'gone')], T0);
    sweepExpired(db, T0 + THIRD_PARTY_TTL_MS + 1);
    expect(search(db, 'gone')).toHaveLength(0);
  });

  test('respects the limit', () => {
    const db = openDb(T0);
    upsert(
      db,
      'my-posts',
      Array.from({ length: 10 }, (_, i) => row(`urn:li:a:${i}`, 'bulk')),
      T0,
    );
    expect(search(db, 'bulk', { limit: 3 })).toHaveLength(3);
  });
});

// The load-bearing one. On this platform an empty-looking cache is what makes
// sync enumerate the whole graph again, so a disk fault must never present as
// "you have no data".
describe('corruption', () => {
  test('a corrupt database throws rather than opening empty', () => {
    writeFileSync(join(dir, 'cache.db'), 'this is definitely not sqlite');
    expect(() => openDb(T0)).toThrow(CacheCorrupt);
  });

  test('the corrupt file is quarantined for inspection', () => {
    writeFileSync(join(dir, 'cache.db'), 'not sqlite at all');
    try {
      openDb(T0);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CacheCorrupt);
      expect((e as CacheCorrupt).quarantinedTo).toContain('quarantine');
    }
  });

  test('after quarantine a fresh db opens cleanly', () => {
    writeFileSync(join(dir, 'cache.db'), 'garbage');
    try {
      openDb(T0);
    } catch {
      /* expected */
    }
    expect(() => openDb(T0)).not.toThrow();
  });
});

describe('checkpoints', () => {
  test('round-trips', () => {
    const db = openDb(T0);
    setCheckpoint(db, {
      source: 'my-posts',
      lastSuccessfulAt: T0,
      newestCreatedAt: T0 - 5000,
      headIds: ['urn:li:a:1'],
      state: 'ok',
    });
    expect(getCheckpoint(db, 'my-posts')?.headIds).toEqual(['urn:li:a:1']);
  });

  test('absent before a first sync', () => {
    expect(getCheckpoint(openDb(T0), 'connections')).toBeUndefined();
  });

  // Connections have no ordering at all, so their checkpoint must say so
  // rather than pretend a watermark exists.
  test('records snapshot-partial honestly where no ordering exists', () => {
    const db = openDb(T0);
    setCheckpoint(db, {
      source: 'connections',
      lastSuccessfulAt: T0,
      newestCreatedAt: null,
      headIds: [],
      state: 'snapshot-partial',
    });
    expect(getCheckpoint(db, 'connections')?.state).toBe('snapshot-partial');
  });
});

describe('purge', () => {
  test('third-party only leaves owner data alone', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:a:1', 'mine')], T0);
    upsert(db, 'third-party', [row('urn:li:x:1', 'theirs')], T0);
    purge(db, 'third-party');
    expect(count(db, 'my-posts')).toBe(1);
    expect(count(db, 'third-party')).toBe(0);
  });

  test('all removes records and checkpoints together', () => {
    const db = openDb(T0);
    upsert(db, 'my-posts', [row('urn:li:a:1', 'mine')], T0);
    setCheckpoint(db, {
      source: 'my-posts',
      lastSuccessfulAt: T0,
      newestCreatedAt: null,
      headIds: [],
      state: 'ok',
    });
    purge(db, 'all');
    expect(count(db)).toBe(0);
    expect(getCheckpoint(db, 'my-posts')).toBeUndefined();
  });
});

describe('set difference', () => {
  test('urnsFor returns what is stored, for diffing against a fresh snapshot', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'a'), row('urn:li:p:2', 'b')], T0);
    expect(urnsFor(db, 'connections')).toEqual(new Set(['urn:li:p:1', 'urn:li:p:2']));
  });

  test('removeUrns deletes only what it is given', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'a'), row('urn:li:p:2', 'b')], T0);
    expect(removeUrns(db, 'connections', ['urn:li:p:1'])).toBe(1);
    expect(urnsFor(db, 'connections')).toEqual(new Set(['urn:li:p:2']));
  });
});

// Found by a real search: `local "kovary"` returned nothing while "kőváry"
// returned the record. SQLite's LIKE is not accent-insensitive, and for
// Hungarian (or any accented) names that makes offline search feel broken —
// the user types what is on their keyboard, not what LinkedIn stored.
describe('accent-insensitive search', () => {
  test('an unaccented query finds an accented name', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'Zsófia Kőváry Frontend Developer')], T0);
    expect(search(db, 'kovary')).toHaveLength(1);
  });

  test('an accented query still finds it', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'Zsófia Kőváry')], T0);
    expect(search(db, 'kőváry')).toHaveLength(1);
  });

  test('an accented query finds an unaccented record', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'zsofia kovary')], T0);
    expect(search(db, 'Kőváry')).toHaveLength(1);
  });

  test('folding does not make unrelated names collide', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'Kőváry'), row('urn:li:p:2', 'Szabó')], T0);
    expect(search(db, 'szabo')).toHaveLength(1);
  });

  test('handles other diacritics too, not just Hungarian', () => {
    const db = openDb(T0);
    upsert(
      db,
      'connections',
      [row('urn:li:p:1', 'Bence Fűzfa'), row('urn:li:p:2', 'Ana Peña')],
      T0,
    );
    expect(search(db, 'ana pena')).toHaveLength(1);
    expect(search(db, 'bence')).toHaveLength(1);
  });

  // The display value must survive — folding is for matching only.
  test('the stored record keeps its accents for display', () => {
    const db = openDb(T0);
    upsert(db, 'connections', [row('urn:li:p:1', 'Zsófia Kőváry')], T0);
    const found = search(db, 'kovary');
    expect(JSON.parse(found[0]?.body ?? '{}').text).toBe('Zsófia Kőváry');
  });
});
