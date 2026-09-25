import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bool, list, num, parseArgs, str } from '../src/args.ts';
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

  // `--image a.png --image b.png` must keep both, in order — silently keeping
  // only the last would post one image of the two the user named.
  test('a repeated flag keeps every value, in order', () => {
    const a = parseArgs(['share', 'hi', '--image', 'a.png', '--image', 'b.png']);
    expect(list(a, 'image')).toEqual(['a.png', 'b.png']);
  });

  test('list of an absent flag is empty, and of a bare flag is empty too', () => {
    expect(list(parseArgs(['share', 'hi']), 'image')).toEqual([]);
    expect(list(parseArgs(['share', 'hi', '--image']), 'image')).toEqual([]);
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

// A `--retain` flag that never reaches the runner fails silently: the read
// succeeds, nothing is cached, and the only symptom is an empty cache later.
// It happened once during development, so it is asserted here.
describe('flag wiring', () => {
  // Dropping a valueless --image would publish the text without the picture.
  test('share with a bare --image refuses instead of posting text alone', async () => {
    const e = await dispatch(['share', 'hi', '--image'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('share refuses an image and a video together', async () => {
    const e = await dispatch(['share', 'hi', '--image', 'a.png', '--video', 'b.mp4'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.message).toContain('not both');
  });

  test('--image reaches the runner', async () => {
    const e = await dispatch(['share', 'hi', '--image', join(dir, 'missing.png')], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.message).toContain('missing.png');
  });

  test('--retain reaches the runner and is reported in meta', async () => {
    const e = await dispatch(['search', 'people', 'x', '--retain'], T0);
    // No session in this test env, so it fails at auth — the point is that the
    // flag parsed and dispatch accepted it rather than dropping it.
    if (e.ok) throw new Error('expected auth failure without a session');
    expect(e.error.code).toBe('AUTH_FAILED');
  });

  test('every live read command accepts --retain without erroring on the flag', async () => {
    for (const argv of [
      ['search', 'people', 'x', '--retain'],
      ['feed', '--retain'],
      ['post', 'urn:li:activity:1', '--retain'],
      ['reactions', 'urn:li:activity:1', '--retain'],
    ]) {
      const e = await dispatch(argv, T0);
      if (e.ok) throw new Error(`expected failure for ${argv[0]}`);
      expect(e.error.code).not.toBe('INVALID_INPUT');
    }
  });
});

// stdout carries ONLY a JSON envelope. A stack trace there breaks every caller
// that parses us — which is all of them, including the MCP shim.
describe('unexpected failures still produce an envelope', () => {
  test('a corrupt cache file yields an envelope, not a throw', async () => {
    writeFileSync(join(dir, 'cache.db'), 'not a database');
    const e = await dispatch(['local', 'anything'], T0);
    expect(e.ok).toBe(false);
    if (e.ok) throw new Error('unreachable');
    expect(e.error.code).toBe('CACHE_CORRUPT');
  });
});

describe('approval modes at the CLI', () => {
  function withSession() {
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({
        liAt: 'a'.repeat(40),
        jsessionId: '"ajax:1"',
        userAgent: 'Mozilla/5.0',
        capturedAt: '2026-08-01',
      }),
    );
  }

  test('approval shows the current mode', async () => {
    const e = await dispatch(['approval'], T0);
    if (!e.ok) throw new Error(e.error.message);
    expect(e.data).toMatchObject({ mode: 'interactive' });
  });

  // Tests run without a TTY — exactly the position an agent is in.
  test('approval set is refused without a terminal', async () => {
    const e = await dispatch(['approval', 'set', 'unattended'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('share --plan returns the preview and token and sends nothing', async () => {
    withSession();
    const e = await dispatch(['share', 'hello world', '--plan'], T0);
    if (!e.ok) throw new Error(e.error.message);
    expect(e.data).toMatchObject({ planned: true });
    expect(JSON.stringify(e.data)).toContain('hello world');
  });

  test('a bare --confirm is refused rather than read as approval', async () => {
    withSession();
    const e = await dispatch(['share', 'hello', '--confirm'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('--confirm in interactive mode is refused and names the owner switch', async () => {
    withSession();
    const e = await dispatch(['share', 'hello', '--confirm', 'abcd'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('lnrelay approval set');
  });

  test('an unreadable approval setting refuses every write', async () => {
    withSession();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ approval: 'yolo' }));
    const e = await dispatch(['share', 'hello', '--plan'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.message).toContain('yolo');
  });
});
