import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentValue,
  formNavBody,
  PROFILE_FIELDS,
  readForm,
  saveBody,
} from '../src/engine/sdui-profile.ts';

// Captured live 2026-10-13: each form as the server sends it on opening, and
// the save the browser sent after one character was added. Trimmed to what the
// save uses, with the owner's name, text and ids replaced by hand.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const INTRO = fixture('sdui-profile-intro-form.rsc');
const ABOUT = fixture('sdui-profile-about-form.rsc');
const INTRO_SAVE = JSON.parse(fixture('sdui-profile-intro-save.json'));
const ABOUT_SAVE = JSON.parse(fixture('sdui-profile-about-save.json'));

/** The parts of a save the server reads; the rest is client-side UI. */
function served(body: Record<string, unknown>) {
  const b = body as {
    requestId: unknown;
    states: unknown;
    requestedArguments: unknown;
    serverRequest: { requestId: unknown; requestedArguments: unknown };
  };
  return {
    requestId: b.requestId,
    states: b.states,
    requestedArguments: b.requestedArguments,
    inner: [b.serverRequest.requestId, b.serverRequest.requestedArguments],
  };
}

describe('reading a profile form', () => {
  test('reads the current value of the field', () => {
    const form = readForm(INTRO, PROFILE_FIELDS.headline);
    if (!form.ok) throw new Error(form.message);
    expect(currentValue(form, PROFILE_FIELDS.headline)).toBe('Analyst | Engines | London');
  });

  // The stream re-declares fields inside actions (a checkbox, a reset). Only
  // the form's initial model state is the value the profile holds now.
  test('a value set by an action elsewhere in the stream is not the current value', () => {
    const form = readForm(INTRO, PROFILE_FIELDS.headline);
    if (!form.ok) throw new Error(form.message);
    expect(JSON.stringify([...form.states.values()])).not.toContain('NOT THE INITIAL VALUE');
  });

  test('a stream without the save action is schema drift', () => {
    const form = readForm(
      INTRO.replace('saveProfileIntroForm', 'somethingElse'),
      PROFILE_FIELDS.headline,
    );
    expect(form.ok).toBe(false);
    if (form.ok) throw new Error('unreachable');
    expect(form.code).toBe('SCHEMA_DRIFT');
  });

  test('a stream without initial values is schema drift', () => {
    expect(readForm(INTRO.replace('"modelStates"', '"other"'), PROFILE_FIELDS.headline).ok).toBe(
      false,
    );
  });

  test('the form is opened with the profile it belongs to', () => {
    const body = formNavBody(PROFILE_FIELDS.about.screen, 'ada-l') as {
      clientArguments: { payload: unknown; screenId: string };
    };
    expect(body.clientArguments.payload).toEqual({
      vanityName: 'ada-l',
      isVanityNameResolved: true,
    });
    expect(body.clientArguments.screenId).toBe(PROFILE_FIELDS.about.screen);
  });
});

describe('the save', () => {
  // The whole intro form is sent back on every save: name, location, current
  // position, education. Rebuilding it from the form read, changing one field,
  // must reproduce what the browser sent, or a headline edit moves you.
  test('a headline edit sends every other intro field exactly as it was', () => {
    const form = readForm(INTRO, PROFILE_FIELDS.headline);
    if (!form.ok) throw new Error(form.message);
    const body = saveBody(form, PROFILE_FIELDS.headline, 'Analyst | Engines | London.');
    if (!body.ok) throw new Error(body.message);
    expect(served(body.body)).toEqual(served(INTRO_SAVE));
  });

  test('an About edit matches what the browser sent', () => {
    const form = readForm(ABOUT, PROFILE_FIELDS.about);
    if (!form.ok) throw new Error(form.message);
    const body = saveBody(form, PROFILE_FIELDS.about, 'I write about engines.\nSecond paragraph..');
    if (!body.ok) throw new Error(body.message);
    expect(served(body.body)).toEqual(served(ABOUT_SAVE));
  });

  // The About save also carries your top skills, as a list the browser
  // computes. With none it is empty — what was captured. With some, sending
  // the wrong list would clear them; that case was never observed, so refuse.
  test('an About edit refuses when top skills are set, rather than risk clearing them', () => {
    const withSkills = ABOUT.replace(
      /("id":"initialSkills[^"]*"\}\}\},"value":\{"\$case":"stringListValue","stringListValue":\{"\$type":"proto.sdui.StringList","stringValues":)\[\]/,
      '$1["123"]',
    );
    const form = readForm(withSkills, PROFILE_FIELDS.about);
    if (!form.ok) throw new Error(form.message);
    const body = saveBody(form, PROFILE_FIELDS.about, 'new');
    expect(body.ok).toBe(false);
  });

  test('a headline over 220 characters is refused before anything is sent', () => {
    const form = readForm(INTRO, PROFILE_FIELDS.headline);
    if (!form.ok) throw new Error(form.message);
    const body = saveBody(form, PROFILE_FIELDS.headline, 'x'.repeat(221));
    expect(body.ok).toBe(false);
  });
});
