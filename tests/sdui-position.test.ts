import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyChanges,
  deleteBody,
  listPositions,
  mediaBody,
  POSITION,
  positionSaveBody,
  readPositionForm,
  roleSummary,
  saveFromReply,
} from '../src/engine/sdui-position.ts';

// Captured 2026-10-14: the add and edit forms as the server sends them on
// opening, the reply to the media step that carries the save, the browser's
// own add save, and the Experience list. Trimmed and redacted by hand.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const ADD_FORM = fixture('sdui-position-add-form.rsc');
const EDIT_FORM = fixture('sdui-position-edit-form.rsc');
const MEDIA_REPLY = fixture('sdui-position-media-reply.rsc');
const ADD_SAVE = JSON.parse(fixture('sdui-position-add-save.json'));
const LIST = fixture('sdui-experience-list.rsc');

const TEST_ROLE = {
  title: 'lnrelay test role',
  company: 'lnrelay test org',
  start: { month: 1, year: 2020 },
  end: { month: 2, year: 2020 },
  description: 'Temporary test entry, removed right after.',
};

/** Each state as key → value, the part the server reads. */
const values = (body: { states: { key: string; value: unknown }[] }) =>
  Object.fromEntries(
    body.states.map((s) => [s.key.replace(/auto-binding-[0-9a-f-]{36}/, ''), s.value]),
  );

describe('the Experience list', () => {
  // This fixture lists 2 roles; the parser emits 2.
  test('lists each role with the id it is edited by', () => {
    const r = listPositions(LIST);
    if (!r.ok) throw new Error(r.message);
    expect(r.positions.map((p) => [p.positionId, p.title])).toEqual([
      ['1000000002', 'Analyst'],
      ['1000000001', 'Engine Designer'],
    ]);
  });

  test('a list it cannot read is schema drift, not an empty profile', () => {
    expect(listPositions('<html>').ok).toBe(false);
  });
});

describe('adding a role', () => {
  test('reproduces the browser save, except that it never rewrites the headline', () => {
    const form = readPositionForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    const model = applyChanges(form, TEST_ROLE);
    if (!model.ok) throw new Error(model.message);
    expect(mediaBody(form, model.model).ok).toBe(true);

    const save = saveFromReply(MEDIA_REPLY);
    if (!save.ok) throw new Error(save.message);
    const body = positionSaveBody(save.args, model.model, POSITION.addScreen);
    if (!body.ok) throw new Error(body.message);

    const ours = values(body.body as never);
    const theirs = values(ADD_SAVE);
    // The browser's add form defaults this to true, and that is what replaced
    // the owner's headline with "<title> at <org>" on 2026-10-14.
    expect(theirs.ProfilePositionFormdynamicallyCreateHeadline).toBe(true);
    expect(ours.ProfilePositionFormdynamicallyCreateHeadline).toBe(false);
    delete ours.ProfilePositionFormdynamicallyCreateHeadline;
    delete theirs.ProfilePositionFormdynamicallyCreateHeadline;
    expect(ours).toEqual(theirs);
    expect(
      (body.body as { serverRequest: { requestedArguments: { payload: unknown } } }).serverRequest
        .requestedArguments.payload,
    ).toEqual(ADD_SAVE.serverRequest.requestedArguments.payload);
  });

  test('network notifications are off unless asked for', () => {
    const form = readPositionForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    const quiet = applyChanges(form, TEST_ROLE);
    const loud = applyChanges(form, { ...TEST_ROLE, notify: true });
    if (!quiet.ok || !loud.ok) throw new Error('changes refused');
    const flag = (m: typeof quiet.model) =>
      [...m.entries()].find(([k]) =>
        k.endsWith('ProfilePositionFormallowProfileEditBroadcasts'),
      )?.[1].value;
    expect(flag(quiet.model)).toBe(false);
    expect(flag(loud.model)).toBe(true);
  });

  test('a current role has no end date and is marked current', () => {
    const form = readPositionForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    const m = applyChanges(form, { ...TEST_ROLE, end: 'present' });
    if (!m.ok) throw new Error(m.message);
    const current = [...m.model.entries()].find(([k]) => k.endsWith('FormisCurrentPosition'))?.[1]
      .value;
    expect(current).toBe(true);
  });

  test('an end before the start is refused', () => {
    const form = readPositionForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    const m = applyChanges(form, { ...TEST_ROLE, end: { month: 12, year: 2019 } });
    expect(m.ok).toBe(false);
  });
});

describe('an existing role', () => {
  test('is summarised from its form, for the preview', () => {
    const form = readPositionForm(EDIT_FORM);
    if (!form.ok) throw new Error(form.message);
    expect(roleSummary(form.model)).toMatchObject({
      title: 'Engine Designer',
      start: '2018-08',
      current: true,
    });
  });

  test('an edit changes only what was asked', () => {
    const form = readPositionForm(EDIT_FORM);
    if (!form.ok) throw new Error(form.message);
    const m = applyChanges(form, { title: 'New title' });
    if (!m.ok) throw new Error(m.message);
    const before = roleSummary(form.model);
    const after = roleSummary(m.model);
    expect(after.title).toBe('New title');
    expect({ ...after, title: before.title }).toEqual(before);
  });

  test('deleting sends the form back with the delete action and its position id', () => {
    const form = readPositionForm(EDIT_FORM);
    if (!form.ok) throw new Error(form.message);
    const body = deleteBody(form);
    if (!body.ok) throw new Error(body.message);
    const b = body.body as {
      requestId: string;
      serverRequest: { requestedArguments: { payload: { positionId: string } } };
    };
    expect(b.requestId).toBe(POSITION.delete);
    expect(b.serverRequest.requestedArguments.payload.positionId).toBe('1000000001');
  });

  test('the add form has no delete action, and asking for one is refused', () => {
    const form = readPositionForm(ADD_FORM);
    if (!form.ok) throw new Error(form.message);
    expect(deleteBody(form).ok).toBe(false);
  });
});

describe('what is not attempted', () => {
  // Media on a role is sent as a computed list nothing here has observed.
  test('a role with media attached is refused rather than saved without it', () => {
    const withMedia = EDIT_FORM.replace(
      /("id":"[^"]*position-mediaUiCollection-mediaCount"\}\}\},"value":\{"\$case":"intValue","intValue":)0/,
      '$12',
    );
    const form = readPositionForm(withMedia);
    if (!form.ok) throw new Error(form.message);
    const m = applyChanges(form, { title: 'x' });
    if (!m.ok) throw new Error(m.message);
    expect(mediaBody(form, m.model).ok).toBe(false);
  });

  test('a media reply without the save is schema drift', () => {
    expect(saveFromReply('0:{"actions":[]}').ok).toBe(false);
  });
});
