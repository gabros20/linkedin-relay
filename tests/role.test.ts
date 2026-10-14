import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, saveJson } from '../src/cache/store.ts';
import { dispatch } from '../src/cli.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { type RoleSurface, runRole } from '../src/commands/role.ts';
import { type Position, readPositionForm, roleSummary } from '../src/engine/sdui-position.ts';

const T0 = 1_800_000_000_000;
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const ADD_FORM = fixture('sdui-position-add-form.rsc');
const EDIT_FORM = fixture('sdui-position-edit-form.rsc');

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-role-'));
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

/** A profile with one role ("Engine Designer", 1000000001) that saves really change. */
function profile() {
  let roles: Position[] = [
    { positionId: '1000000001', title: 'Engine Designer', payload: { positionId: '1000000001' } },
  ];
  let title = 'Engine Designer';
  const calls: string[] = [];
  const s: RoleSurface = {
    vanity: async () => ({ ok: true, vanity: 'ada-l' }),
    list: async () => ({ ok: true, positions: roles }),
    open: async (_payload, edit) =>
      readPositionForm(
        edit ? EDIT_FORM.replaceAll('"Engine Designer"', JSON.stringify(title)) : ADD_FORM,
      ),
    save: async (form, model) => {
      calls.push(form.del === null ? 'add' : 'edit');
      const t = roleSummary(model).title;
      if (form.del === null)
        roles = [...roles, { positionId: '1000000009', title: t, payload: {} }];
      else title = t;
      return { ok: true };
    },
    remove: async () => {
      calls.push('remove');
      roles = roles.filter((r) => r.positionId !== '1000000001');
      return { ok: true };
    },
  };
  return { s, calls };
}

/** Plan, then confirm with the token the plan returned. */
async function approve(
  sub: string,
  target: string | undefined,
  req: Parameters<typeof runRole>[2],
  s: RoleSurface,
) {
  const plan = await runRole(sub, target, req, T0, planning, s);
  if (!plan.ok) throw new Error(plan.error.message);
  const token = (plan.data as { token: string }).token;
  return { plan, done: await runRole(sub, target, req, T0 + 60_000, confirming(token), s) };
}

const preview = (e: { ok: boolean; data?: unknown }) =>
  ((e.data as { preview: string[] }).preview ?? []).join('\n');

describe('adding a role', () => {
  const role = { title: 'Analyst', company: 'Acme', start: '2020-01', end: '2021-06' };

  test('the plan says what will be added, that the headline is untouched, and notify is off', async () => {
    const { s, calls } = profile();
    const e = await runRole('add', undefined, role, T0, planning, s);
    if (!e.ok) throw new Error(e.error.message);
    const p = preview(e);
    expect(p).toContain('title    "Analyst"');
    expect(p).toContain('company  "Acme"');
    expect(p).toContain('2020-01 – 2021-06');
    expect(p).toContain('headline unchanged');
    expect(p).toContain('notify   off');
    expect(calls).toEqual([]);
  });

  test('on approval it saves and finds the new role on the profile', async () => {
    const { s, calls } = profile();
    const { done } = await approve('add', undefined, role, s);
    if (!done.ok) throw new Error(done.error.message);
    expect(calls).toEqual(['add']);
    expect(done.data).toMatchObject({ added: '1000000009', verified: true });
  });

  test('title, company and start are required', async () => {
    const { s } = profile();
    for (const missing of ['title', 'company', 'start'] as const) {
      const req = { ...role };
      delete req[missing];
      const e = await runRole('add', undefined, req, T0, planning, s);
      if (e.ok) throw new Error(`expected refusal without ${missing}`);
      expect(e.error.message).toContain(missing);
    }
  });

  test('a date that is not YYYY-MM is refused', async () => {
    const { s } = profile();
    const e = await runRole('add', undefined, { ...role, start: 'Jan 2020' }, T0, planning, s);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
  });
});

describe('editing a role', () => {
  test('the plan shows only what changes, from what to what', async () => {
    const { s } = profile();
    const e = await runRole('edit', '1000000001', { title: 'Engine Architect' }, T0, planning, s);
    if (!e.ok) throw new Error(e.error.message);
    const p = preview(e);
    expect(p).toContain('title    "Engine Designer" → "Engine Architect"');
    expect(p).not.toContain('company ');
  });

  test('on approval it saves and reads the role back', async () => {
    const { s, calls } = profile();
    const { done } = await approve('edit', '1000000001', { title: 'Engine Architect' }, s);
    if (!done.ok) throw new Error(done.error.message);
    expect(calls).toEqual(['edit']);
    expect(done.data).toMatchObject({ edited: '1000000001', verified: true });
  });

  test('a role id that is not on the profile is refused, with the ones that are', async () => {
    const { s } = profile();
    const e = await runRole('edit', '999', { title: 'x' }, T0, planning, s);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('1000000001');
  });

  test('an edit with nothing to change is refused', async () => {
    const { s } = profile();
    const e = await runRole('edit', '1000000001', {}, T0, planning, s);
    expect(e.ok).toBe(false);
  });
});

describe('removing a role', () => {
  test('the plan shows the role being removed', async () => {
    const { s } = profile();
    const e = await runRole('remove', '1000000001', {}, T0, planning, s);
    if (!e.ok) throw new Error(e.error.message);
    expect(preview(e)).toContain('Engine Designer');
  });

  test('on approval it is removed and gone from the list', async () => {
    const { s, calls } = profile();
    const { done } = await approve('remove', '1000000001', {}, s);
    if (!done.ok) throw new Error(done.error.message);
    expect(calls).toEqual(['remove']);
    expect(done.data).toMatchObject({ removed: '1000000001', verified: true });
  });
});

describe('the CLI', () => {
  test('`role` without a terminal or approval is refused before anything is read', async () => {
    const e = await dispatch(
      ['role', 'add', '--title', 'x', '--company', 'y', '--start', '2020-01'],
      T0,
    );
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('an unknown subcommand lists the real ones', async () => {
    const e = await dispatch(['role', 'rename'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('add');
  });
});
