// ─── Local state store ────────────────────────────────────────────────────────
//
// Small, replaceable JSON state (the ledger, the cooldown, credentials
// metadata) lives here. The research cache proper is SQLite and arrives in
// Phase 4 — see docs/DESIGN.md §5.
//
// The rule that matters, and where we deliberately break with the family:
//
//   never-throw is NOT never-fail.
//
// x-relay's store degrades a corrupt file to an empty object so a read never
// crashes. That is right on X. Here it composes into a disaster: corrupt file →
// empty cache → sync sees no prior state → full enumeration against the most
// hostile platform in the research, triggered by a disk error. So a corrupt
// file is quarantined and reported loudly. An empty result and a lost result
// must be distinguishable on disk for exactly the same reason they must be
// distinguishable in a parse.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function cacheDir(): string {
  return process.env.LNRELAY_CACHE_DIR ?? join(homedir(), '.lnrelay');
}

export function cachePath(...parts: string[]): string {
  return join(cacheDir(), ...parts);
}

export type LoadResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'missing' }
  | { state: 'corrupt'; quarantinedTo: string; reason: string };

/**
 * Read a JSON file. Never throws. A file that exists but cannot be parsed is
 * MOVED to `quarantine/` and reported as corrupt — never silently treated as
 * absent, because "we lost your data" and "you have no data" lead to opposite
 * and non-interchangeable actions.
 */
export function loadJson<T>(path: string): LoadResult<T> {
  if (!existsSync(path)) return { state: 'missing' };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return quarantine(path, `unreadable: ${(e as Error).message}`);
  }

  try {
    return { state: 'ok', value: JSON.parse(raw) as T };
  } catch (e) {
    return quarantine(path, `unparseable JSON: ${(e as Error).message}`);
  }
}

function quarantine(path: string, reason: string): LoadResult<never> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = cachePath('quarantine', stamp, path.split('/').pop() ?? 'file');
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(path, target);
  } catch {
    // If we cannot even move it, still report corrupt — the caller must refuse
    // to proceed either way.
  }
  return { state: 'corrupt', quarantinedTo: target, reason };
}

/**
 * Write JSON atomically: a temp file in the same directory, then rename. A
 * torn write leaves the previous good file intact rather than a truncated one.
 */
export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}
