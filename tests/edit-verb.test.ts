import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli.ts';

const T0 = 1_800_000_000_000;
const COMMENT = 'urn:li:comment:(activity:6620492574320930816,7493773969058062336)';
const POST = 'urn:li:activity:6620492574320930816';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-edit-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

// `comment` used to EDIT when handed a comment urn. That silently does the
// wrong thing for the most natural reading of the command — someone holding a
// comment urn most likely wants to REPLY to it, not overwrite it. Editing gets
// its own verb, and the overloaded form is refused rather than guessed at.
describe('editing has its own verb', () => {
  test('`comment` refuses a comment urn instead of silently editing', async () => {
    const e = await dispatch(['comment', COMMENT, 'text'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('and points at the verb that does what was probably meant', async () => {
    const e = await dispatch(['comment', COMMENT, 'text'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('lnrelay edit');
  });

  test('`edit` rejects a POST urn — you cannot edit a post here', async () => {
    const e = await dispatch(['edit', POST, 'text'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('`edit` requires the new text', async () => {
    const e = await dispatch(['edit', COMMENT], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('`edit` with a valid comment urn reaches the confirmation gate', async () => {
    const e = await dispatch(['edit', COMMENT, 'new text'], T0);
    if (e.ok) throw new Error('expected a gate refusal, not success');
    // No TTY in tests: it must stop at the gate, before any network call.
    expect(['CONFIRMATION_REQUIRED', 'AUTH_FAILED']).toContain(e.error.code);
  });

  test('`comment` still accepts a post urn', async () => {
    const e = await dispatch(['comment', POST, 'text'], T0);
    if (e.ok) throw new Error('expected a gate refusal');
    expect(e.error.code).not.toBe('INVALID_INPUT');
  });
});
