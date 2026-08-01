import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJson, saveJson } from '../src/cache/store.ts';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-test-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadJson', () => {
  test('reports a missing file as missing, not as empty', () => {
    expect(loadJson(join(dir, 'nope.json')).state).toBe('missing');
  });

  test('round-trips a saved value', () => {
    const path = join(dir, 'state.json');
    saveJson(path, { a: 1 });
    const result = loadJson<{ a: number }>(path);
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.value.a).toBe(1);
  });

  // The load-bearing test. Degrading corruption to an empty success would make
  // a disk error indistinguishable from "no data yet" — and on this platform
  // "no data yet" is what triggers a full re-sync.
  test('reports a corrupt file as corrupt, never as missing or empty', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ this is not json');
    expect(loadJson(path).state).toBe('corrupt');
  });

  test('moves the corrupt file out of the way so it cannot be re-read', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'not json');
    const result = loadJson(path);
    if (result.state !== 'corrupt') throw new Error('expected corrupt');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(result.quarantinedTo)).toBe(true);
  });

  test('preserves the corrupt content for inspection rather than deleting it', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, 'original garbage');
    const result = loadJson(path);
    if (result.state !== 'corrupt') throw new Error('expected corrupt');
    expect(readFileSync(result.quarantinedTo, 'utf-8')).toBe('original garbage');
  });
});

describe('saveJson', () => {
  test('creates missing parent directories', () => {
    const path = join(dir, 'nested', 'deep', 'state.json');
    saveJson(path, { ok: true });
    expect(existsSync(path)).toBe(true);
  });

  test('leaves no temp file behind', () => {
    const path = join(dir, 'state.json');
    saveJson(path, { ok: true });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test('overwrites an existing file in place', () => {
    const path = join(dir, 'state.json');
    saveJson(path, { v: 1 });
    saveJson(path, { v: 2 });
    const result = loadJson<{ v: number }>(path);
    if (result.state !== 'ok') throw new Error('expected ok');
    expect(result.value.v).toBe(2);
  });

  // Credentials-adjacent state lives here; world-readable would be a defect.
  test('writes with owner-only permissions', () => {
    const path = join(dir, 'state.json');
    saveJson(path, {});
    expect(Bun.file(path).size).toBeGreaterThan(0);
    const mode = require('node:fs').statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
