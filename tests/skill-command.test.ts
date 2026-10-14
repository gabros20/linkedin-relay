import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, saveJson } from '../src/cache/store.ts';
import { dispatch } from '../src/cli.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { runSkill, type SkillSurface } from '../src/commands/skill.ts';
import { readSkillForm, type Skill } from '../src/engine/sdui-skill.ts';

const T0 = 1_800_000_000_000;
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const ADD_FORM = fixture('sdui-skill-add-form.rsc');
const EDIT_FORM = fixture('sdui-skill-edit-form.rsc');

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-skill-'));
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

function profile() {
  let skills: Skill[] = [
    { skillId: '956173471', name: 'lnrelay test skill', payload: { skillId: '956173471' } },
    { skillId: '31', name: 'TypeScript', payload: { skillId: '31' } },
  ];
  const sent: string[] = [];
  const s: SkillSurface = {
    vanity: async () => ({ ok: true, vanity: 'ada-l' }),
    list: async () => ({ ok: true, skills }),
    open: async (_p, edit) => readSkillForm(edit ? EDIT_FORM : ADD_FORM),
    send: async (_body, requestId) => {
      sent.push(requestId.split('.').pop() as string);
      if (requestId.endsWith('deleteProfileSkillForm'))
        skills = skills.filter((k) => k.skillId !== '956173471');
      else skills = [...skills, { skillId: '99', name: 'Rust', payload: {} }];
      return { ok: true };
    },
  };
  return { s, sent };
}

async function approve(sub: string, arg: string, s: SkillSurface) {
  const plan = await runSkill(sub, arg, T0, planning, s);
  if (!plan.ok) throw new Error(plan.error.message);
  const token = (plan.data as { token: string }).token;
  return { plan, done: await runSkill(sub, arg, T0 + 60_000, confirming(token), s) };
}

describe('skills', () => {
  test('adding plans the name, saves, and finds it on the profile', async () => {
    const { s, sent } = profile();
    const { plan, done } = await approve('add', 'Rust', s);
    expect((plan.data as { preview: string[] }).preview.join('\n')).toContain('skill    "Rust"');
    if (!done.ok) throw new Error(done.error.message);
    expect(sent).toEqual(['saveProfileSkillForm']);
    expect(done.data).toMatchObject({ added: '99', verified: true });
  });

  test('a skill already on the profile is refused, case-insensitively', async () => {
    const { s } = profile();
    const e = await runSkill('add', 'typescript', T0, planning, s);
    expect(e.ok).toBe(false);
  });

  test('removing shows the skill by name, removes it, and checks it is gone', async () => {
    const { s, sent } = profile();
    const { plan, done } = await approve('remove', '956173471', s);
    expect((plan.data as { preview: string[] }).preview.join('\n')).toContain('lnrelay test skill');
    if (!done.ok) throw new Error(done.error.message);
    expect(sent).toEqual(['deleteProfileSkillForm']);
    expect(done.data).toMatchObject({ removed: '956173471', verified: true });
  });

  test('a skill id not on the profile is refused, with the ones that are', async () => {
    const { s } = profile();
    const e = await runSkill('remove', '12345', T0, planning, s);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('TypeScript');
  });

  test('the CLI refuses without a terminal or approval', async () => {
    const e = await dispatch(['skill', 'add', 'Rust'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('an unknown subcommand lists the real ones', async () => {
    const e = await dispatch(['skill', 'endorse', 'x'], T0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('remove');
  });
});
