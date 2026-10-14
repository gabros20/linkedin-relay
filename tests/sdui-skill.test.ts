import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addSkillBody,
  pagerFrom,
  readSkillForm,
  removeSkillBody,
  SKILL,
  skillNameOf,
  skillsFromPage,
} from '../src/engine/sdui-skill.ts';

// Captured 2026-10-14: the skills list page, the add and edit forms as the
// server sends them on opening, and the browser's own add save.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const PAGE = fixture('sdui-skills-page.rsc');
const ADD_FORM = fixture('sdui-skill-add-form.rsc');
const EDIT_FORM = fixture('sdui-skill-edit-form.rsc');
const ADD_SAVE = JSON.parse(fixture('sdui-skill-add-save.json'));

const values = (body: { states: { key: string; value: unknown }[] }) =>
  Object.fromEntries(body.states.map((s) => [s.key, s.value]));

describe('the skills list', () => {
  // This page lists 10 skills; the parser emits 10.
  test('each skill comes with its id and name', () => {
    const r = skillsFromPage(PAGE);
    if (!r.ok) throw new Error(r.message);
    expect(r.skills).toHaveLength(10);
    expect(r.skills[0]).toMatchObject({ skillId: '956173471', name: 'lnrelay test skill' });
    expect(r.skills[1]).toMatchObject({ skillId: '31', name: 'TypeScript' });
  });

  test('a page it cannot read is schema drift, not an empty list', () => {
    expect(skillsFromPage('<html>').ok).toBe(false);
  });

  test('the pager is asked for from where the last page ended', () => {
    const body = pagerFrom(
      {
        vanityName: 'ada-l',
        profileId: 'p',
        start: 0,
        count: 10,
        filter: 'ProfileSkillCategory_ALL',
      },
      10,
    ) as {
      paginationRequest: { requestedArguments: { payload: { start: number; filter: string } } };
    };
    expect(body.paginationRequest.requestedArguments.payload).toMatchObject({
      start: 10,
      filter: 'ProfileSkillCategory_ALL',
    });
  });
});

describe('adding a skill', () => {
  test('reproduces the browser save: the name, no catalogue id, no associations', () => {
    const form = readSkillForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    const body = addSkillBody(form, 'lnrelay test skill');
    if (!body.ok) throw new Error(body.message);
    expect(values(body.body as never)).toEqual(values(ADD_SAVE));
    expect((body.body as { requestId: string }).requestId).toBe(SKILL.save);
  });

  test('an empty name is refused', () => {
    const form = readSkillForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    expect(addSkillBody(form, '  ').ok).toBe(false);
  });
});

describe('removing a skill', () => {
  test('names the skill from its own form, for the preview', () => {
    const form = readSkillForm(EDIT_FORM);
    if (!form.ok) throw new Error(form.message);
    expect(skillNameOf(form)).toBe('lnrelay test skill');
  });

  test('sends the delete action with the form as it is', () => {
    const form = readSkillForm(EDIT_FORM);
    if (!form.ok) throw new Error(form.message);
    const body = removeSkillBody(form);
    if (!body.ok) throw new Error(body.message);
    expect((body.body as { requestId: string }).requestId).toBe(SKILL.delete);
  });

  test('the add form has no delete, and asking for one is refused', () => {
    const form = readSkillForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    expect(removeSkillBody(form).ok).toBe(false);
  });
});
