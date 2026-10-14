// ─── Editing the profile ──────────────────────────────────────────────────────
//
// Profile edits are SDUI forms. Voyager's partial update on
// `identity/dash/profiles` answers 400 (mguttmann/linkedin-internal-api), and
// the web client saves through `saveProfileIntroForm` / `saveProfileAboutForm`.
//
// The intro save sends the WHOLE form back — name, location, current
// position, education, industry, website — not just the field that changed.
// A body built by hand would have to know every one of those, and getting one
// wrong moves the owner to another city. So, as with the comment menu
// (sdui-menu.ts), nothing here is hand-built: the form is opened the way the
// browser opens it, and the server's own save action and initial values are
// sent back with exactly one value replaced. If the form changes shape, the
// read changes with it.
//
// Captured 2026-10-13 by editing each field by one character in the browser
// and reverting; tests/sdui-profile.test.ts rebuilds those saves byte-for-byte
// from the form reads.

import type { Client } from './client.ts';
import {
  type Failure,
  findRequest,
  keysOf,
  type Model,
  type ModelValue,
  navBody,
  type RequestArgs,
  readModel,
  requestBody,
  responseErrors,
  wireStates,
} from './sdui-form.ts';

export const NAV_URL = 'https://www.linkedin.com/flagship-web/rsc-action/actions/navigation';
export const ACTION_URL = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';

export interface ProfileField {
  name: 'headline' | 'about';
  /** The form's SDUI screen. */
  screen: string;
  /** The save action the form carries. */
  save: string;
  /** The save payload's property that binds this field's value. */
  binding: string;
  maxLength: number;
}

export const PROFILE_FIELDS = {
  headline: {
    name: 'headline',
    screen: 'com.linkedin.sdui.flagshipnav.profile.ProfileEditIntroForm',
    save: 'com.linkedin.sdui.requests.profile.saveProfileIntroForm',
    binding: 'headline',
    // The web form refuses more ("Exceeded maximum length of 220 characters").
    maxLength: 220,
  },
  about: {
    name: 'about',
    screen: 'com.linkedin.sdui.flagshipnav.profile.ProfileAboutForm',
    save: 'com.linkedin.sdui.requests.profile.saveProfileAboutForm',
    binding: 'about',
    maxLength: 2600,
  },
} as const satisfies Record<string, ProfileField>;

/** Open a form as the browser does. A read, though it is issued as a POST. */
export function formNavBody(screen: string, vanityName: string) {
  return navBody(screen, { vanityName, isVanityNameResolved: true });
}

export interface ProfileForm {
  ok: true;
  /** The save action's arguments, verbatim: which states it reads, and its payload. */
  args: RequestArgs;
  states: Model;
  screen: string;
  save: string;
}

export const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'Re-capture the profile form with scripts/observe-write.ts (edit one character, then revert).',
});

export function readForm(stream: string, field: ProfileField): ProfileForm | Failure {
  const states = readModel(stream);
  if (states === null) return drift('the profile form carried no initial values');
  const args = findRequest(stream, field.save);
  if (args === null)
    return drift(`the profile form carried no ${field.save.split('.').pop()} action`);
  return { ok: true, args, states, screen: field.screen, save: field.save };
}

/** The state key a payload property is bound to, e.g. headline → headlineIntroForm. */
function boundKey(form: ProfileForm, property: string): string | undefined {
  const ref = form.args.payload[property] as { key?: string } | undefined;
  return ref?.key;
}

export function currentValue(form: ProfileForm, field: ProfileField): string | undefined {
  const key = boundKey(form, field.binding);
  const v = key === undefined ? undefined : form.states.get(key)?.value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * The About save carries the top-skills list as an expression over a
 * client-side collection, which starts as `initialSkills` and is sent unchanged
 * when skills are not touched.
 */
function topSkills(form: ProfileForm) {
  return (key: string): { ok: true; value: unknown } | Failure | undefined => {
    if (!key.endsWith('ReorderableSkillsFormBindingsskillIdsBinding')) return undefined;
    const initial = [...form.states.entries()].find(([k]) => k.startsWith('initialSkills'))?.[1];
    if (initial === undefined) return drift('the About form carried no initial top skills');
    // Only the empty list has been seen on the wire. Sending a guessed list could
    // clear the owner's top skills, so a non-empty one is refused until observed.
    if (!Array.isArray(initial.value) || initial.value.length > 0) {
      return {
        ok: false,
        code: 'NOT_IMPLEMENTED',
        message: 'your About section has top skills, and saving it with them has not been verified',
        hint: 'Edit About in the browser for now; nothing was changed.',
      };
    }
    return { ok: true, value: [] };
  };
}

/** The save the browser would send after the owner changed this one field. */
export function saveBody(
  form: ProfileForm,
  field: ProfileField,
  value: string,
): { ok: true; body: Record<string, unknown> } | Failure {
  if (value.length > field.maxLength) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `the ${field.name} is ${value.length} characters; LinkedIn allows ${field.maxLength}`,
    };
  }
  const target = boundKey(form, field.binding);
  const current = target === undefined ? undefined : form.states.get(target);
  if (target === undefined || current === undefined) {
    return drift(`the profile form has no ${field.name} field`);
  }
  const model: Model = new Map(form.states);
  model.set(target, { ...(current as ModelValue), value });
  const states = wireStates(keysOf(form.args), model, topSkills(form));
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(form.save, form.args, states, form.screen) };
}

/** Open the form for a field. */
export async function fetchProfileForm(
  field: ProfileField,
  vanityName: string,
  client: Client,
): Promise<ProfileForm | Failure> {
  const stream = await openForm(
    field.screen,
    { vanityName, isVanityNameResolved: true },
    client,
    `profile-${field.name}-form`,
  );
  return typeof stream === 'string' ? readForm(stream, field) : stream;
}

/** POST a navigation and hand back the raw stream. */
export async function openForm(
  screen: string,
  payload: Record<string, unknown>,
  client: Client,
  operation: string,
): Promise<string | Failure> {
  const result = await client.request({
    url: `${NAV_URL}?screenId=${screen}&sduiid=${screen}`,
    method: 'POST',
    body: navBody(screen, payload),
    spendClass: 'page',
    operation,
  });
  if (!result.ok) {
    const out: Failure = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return (result.classification as { raw?: string }).raw ?? '';
}

/** POST a server action; the raw stream back, or why it failed. A 200 can carry errors. */
export async function sendAction(
  requestId: string,
  body: unknown,
  client: Client,
  operation: string,
  spendClass: 'write' | 'page' = 'write',
): Promise<string | Failure> {
  const result = await client.request({
    url: `${ACTION_URL}?sduiid=${requestId}`,
    method: 'POST',
    body,
    spendClass,
    operation,
  });
  if (!result.ok) {
    const out: Failure = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  const raw = (result.classification as { raw?: string }).raw ?? '';
  const errors = responseErrors(raw);
  if (errors !== null) {
    return { ok: false, code: 'INVALID_INPUT', message: `LinkedIn refused it: ${errors}` };
  }
  return raw;
}

/** Send a save built by `saveBody`. */
export async function sendProfileSave(
  form: ProfileForm,
  body: Record<string, unknown>,
  client: Client,
): Promise<{ ok: true } | Failure> {
  const r = await sendAction(form.save, body, client, 'profile-save');
  return typeof r === 'string' ? { ok: true } : r;
}
