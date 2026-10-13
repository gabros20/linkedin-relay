import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, saveJson } from '../src/cache/store.ts';
import { dispatch } from '../src/cli.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { type ProfileSurface, runEditProfile } from '../src/commands/write.ts';
import { PROFILE_FIELDS, readForm } from '../src/engine/sdui-profile.ts';

const T0 = 1_800_000_000_000;
const INTRO = readFileSync(
  join(import.meta.dir, 'fixtures', 'sdui-profile-intro-form.rsc'),
  'utf-8',
);

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-profile-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
  saveJson(cachePath('session.json'), {
    liAt: 'a'.repeat(40),
    jsessionId: '"ajax:1"',
    userAgent: 'Mozilla/5.0',
    capturedAt: '2026-08-01',
  });
});
afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const noTty: ConfirmDeps = { isTty: false, prompt: async () => '', write: () => {} };
const planning = { ...noTty, approval: { mode: 'agent' as const, planOnly: true } };
const confirming = (token: string) => ({ ...noTty, approval: { mode: 'agent' as const, token } });

/** A profile whose headline is whatever the last save set it to. */
function surface(opts: { stick?: boolean } = {}) {
  let headline = 'Analyst | Engines | London';
  const sent: unknown[] = [];
  const s: ProfileSurface = {
    vanity: async () => ({ ok: true, vanity: 'ada-l' }),
    open: async (field) => {
      const stream = INTRO.replace('Analyst | Engines | London', headline);
      return readForm(stream, field);
    },
    send: async (_form, body) => {
      sent.push(body);
      if (opts.stick !== false) headline = 'New headline';
      return { ok: true };
    },
  };
  return { s, sent };
}

describe('editing the headline', () => {
  test('the plan shows the headline now and the one replacing it', async () => {
    const { s, sent } = surface();
    const e = await runEditProfile('headline', 'New headline', T0, planning, s);
    if (!e.ok) throw new Error(e.error.message);
    const preview = (e.data as { preview: string[] }).preview.join('\n');
    expect(preview).toContain('was      "Analyst | Engines | London"');
    expect(preview).toContain('new      "New headline"');
    expect(sent).toHaveLength(0);
  });

  test('on approval it saves, and reads the profile back to confirm', async () => {
    const { s, sent } = surface();
    const plan = await runEditProfile('headline', 'New headline', T0, planning, s);
    if (!plan.ok) throw new Error(plan.error.message);
    const token = (plan.data as { token: string }).token;
    const e = await runEditProfile('headline', 'New headline', T0 + 60_000, confirming(token), s);
    if (!e.ok) throw new Error(e.error.message);
    expect(sent).toHaveLength(1);
    expect(e.data).toMatchObject({ field: 'headline', verified: true });
  });

  // The approval names the text being replaced. If the profile changed after
  // the owner looked, they approved a different edit.
  test('a headline that changed since the preview refuses the old token', async () => {
    const { s } = surface();
    const plan = await runEditProfile('headline', 'New headline', T0, planning, s);
    if (!plan.ok) throw new Error(plan.error.message);
    const token = (plan.data as { token: string }).token;
    const changed: ProfileSurface = {
      ...s,
      open: async (f) => readForm(INTRO.replace('Analyst | Engines | London', 'Someone else'), f),
    };
    const e = await runEditProfile(
      'headline',
      'New headline',
      T0 + 60_000,
      confirming(token),
      changed,
    );
    expect(e.ok).toBe(false);
  });

  // Never an empty success: a save LinkedIn accepted but did not apply is a failure.
  test('a save that did not take is reported as a failure', async () => {
    const { s } = surface({ stick: false });
    const plan = await runEditProfile('headline', 'New headline', T0, planning, s);
    if (!plan.ok) throw new Error(plan.error.message);
    const token = (plan.data as { token: string }).token;
    const e = await runEditProfile('headline', 'New headline', T0 + 60_000, confirming(token), s);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('SCHEMA_DRIFT');
  });

  test('the same text as now is refused: there is nothing to save', async () => {
    const { s } = surface();
    const e = await runEditProfile('headline', 'Analyst | Engines | London', T0, planning, s);
    expect(e.ok).toBe(false);
  });

  test('a headline over the limit is refused before the gate', async () => {
    const { s } = surface();
    const e = await runEditProfile('headline', 'x'.repeat(221), T0, planning, s);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });
});

describe('the edit verb routes profile fields', () => {
  test('`edit headline` takes the profile path', async () => {
    const e = await dispatch(['edit', 'headline', 'x'], T0);
    if (e.ok) throw new Error('expected a refusal without a terminal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('`edit about --file` reads the text from the file', async () => {
    const e = await dispatch(['edit', 'about', '--file', join(dir, 'missing.txt')], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.message).toContain('missing.txt');
  });

  test('an unknown field is refused and lists the ones there are', async () => {
    const e = await dispatch(['edit', 'nickname', 'x'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('headline');
  });

  test('the field registry knows both', () => {
    expect(Object.keys(PROFILE_FIELDS).sort()).toEqual(['about', 'headline']);
  });
});
