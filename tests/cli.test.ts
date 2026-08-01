import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bool, num, parseArgs, str } from '../src/args.ts';
import { dispatch } from '../src/cli.ts';
import { exitCodeFor } from '../src/output.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-cli-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('separates command, positionals and flags', async () => {
    const a = parseArgs(['search', 'people', 'ada lovelace', '--limit', '10', '--compact']);
    expect(a.command).toBe('search');
    expect(a.positionals).toEqual(['people', 'ada lovelace']);
    expect(num(a, 'limit')).toBe(10);
    expect(bool(a, 'compact')).toBe(true);
  });

  test('a flag followed by another flag is boolean, not a value', async () => {
    const a = parseArgs(['doctor', '--offline', '--quiet']);
    expect(bool(a, 'offline')).toBe(true);
    expect(bool(a, 'quiet')).toBe(true);
  });

  test('supports short flags', async () => {
    expect(str(parseArgs(['local', '-q', 'rust']), 'q')).toBe('rust');
  });

  test('num rejects a non-numeric value rather than yielding NaN', async () => {
    expect(num(parseArgs(['x', '--limit', 'abc']), 'limit')).toBeUndefined();
  });
});

describe('dispatch', () => {
  test('an unknown command exits 2', async () => {
    const e = await dispatch(['nonsense'], T0);
    expect(e.ok).toBe(false);
    expect(exitCodeFor(e)).toBe(2);
  });

  // Commands that are designed but unbuilt must say so plainly rather than
  // pretending to succeed with empty data.
  test('a designed-but-unbuilt command fails loudly with NOT_IMPLEMENTED', async () => {
    const e = await dispatch(['company', 'acme'], T0);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('NOT_IMPLEMENTED');
    expect(e.error.hint).toContain('docs/PLAN.md');
  });

  // A live command with no stored session must say so plainly rather than
  // crashing or, worse, returning an empty result that reads as "no data".
  test('a live command without a session returns AUTH_FAILED, not a crash', async () => {
    const e = await dispatch(['whoami'], T0);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('AUTH_FAILED');
    expect(e.error.message).toContain('login');
  });

  test('search validates its arguments before touching the network', async () => {
    const e = await dispatch(['search', 'nonsense-kind', 'q'], T0);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('doctor reports rather than throwing when nothing is set up', async () => {
    const e = await dispatch(['doctor', '--offline'], T0);
    expect(e.ok).toBe(true);
    expect(exitCodeFor(e)).toBe(0);
  });

  test('doctor is honest that the engine does not exist yet', async () => {
    const e = await dispatch(['doctor', '--offline'], T0);
    if (!e.ok) throw new Error('expected ok');
    const data = e.data as { healthy: boolean; checks: { name: string; ok: boolean }[] };
    expect(data.healthy).toBe(false);
    expect(data.checks.find((c) => c.name === 'engine')?.ok).toBe(false);
  });

  test('budget reports every spend class with its cap provenance', async () => {
    const e = await dispatch(['budget'], T0);
    if (!e.ok) throw new Error('expected ok');
    const data = e.data as { classes: { class: string; capProvenance: string }[] };
    expect(data.classes.map((c) => c.class)).toContain('global');
    for (const c of data.classes) {
      expect(['guessed', 'vendor-lore', 'measured']).toContain(c.capProvenance);
    }
  });

  test('budget carries the caveat that the numbers are not measured limits', async () => {
    const e = await dispatch(['budget'], T0);
    if (!e.ok) throw new Error('expected ok');
    expect((e.data as { caveat: string }).caveat).toContain('no corroborated');
  });

  test('clearing a cooldown without --confirm is refused', async () => {
    const e = await dispatch(['budget', '--reset-cooldown'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('risk reports a clear breaker when nothing has gone wrong', async () => {
    const e = await dispatch(['risk'], T0);
    if (!e.ok) throw new Error('expected ok');
    expect((e.data as { state: string }).state).toBe('ok');
  });

  test('risk states the ToS breach plainly rather than claiming compliance', async () => {
    const e = await dispatch(['risk'], T0);
    if (!e.ok) throw new Error('expected ok');
    expect((e.data as { tosNotice: string }).tosNotice).toContain('§8.2');
  });

  // A corrupt ledger must never read as a fresh, full budget.
  test('a corrupt ledger fails loudly instead of restoring a full budget', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'budget.json'), 'not json at all');
    const e = await dispatch(['budget'], T0);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('CACHE_CORRUPT');
  });
});
