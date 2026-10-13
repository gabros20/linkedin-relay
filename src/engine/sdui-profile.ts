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

const NAV_URL = 'https://www.linkedin.com/flagship-web/rsc-action/actions/navigation';
const ACTION_URL = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';

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
  return {
    clientArguments: {
      $type: 'proto.sdui.actions.requests.RequestedArguments',
      requestedStateKeys: [],
      payload: { vanityName, isVanityNameResolved: true },
      requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
      states: [],
      screenId: screen,
      knownTemplateIds: [],
    },
    isModal: true,
  };
}

/** One initial value, as the form declares it. */
interface ModelValue {
  protoCase: string;
  value: unknown;
}

export interface ProfileForm {
  ok: true;
  /** The save action's arguments, verbatim: which states it reads, and its payload. */
  args: {
    requestedStateKeys: { key: { value: { id: string } } }[];
    payload: Record<string, unknown>;
  };
  states: Map<string, ModelValue>;
  screen: string;
  save: string;
}

type Failure = { ok: false; code: string; message: string; hint?: string };

const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'Re-capture the profile form with scripts/observe-write.ts (edit one character, then revert).',
});

/** The balanced JSON array or object starting at `start`. */
function balanced(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === open) depth++;
    else if (!inString && ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseAt<T>(s: string, start: number): T | null {
  const text = start === -1 ? null : balanced(s, start);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A model state's value in the shape the save sends it. */
function plain(v: Record<string, unknown>): ModelValue {
  const protoCase = String(v.$case);
  const raw = v[protoCase];
  if (protoCase === 'stringListValue') {
    return { protoCase, value: (raw as { stringValues?: string[] })?.stringValues ?? [] };
  }
  return { protoCase, value: raw };
}

export function readForm(stream: string, field: ProfileField): ProfileForm | Failure {
  // Initial values live in the form's `modelStates`. The same keys reappear
  // inside actions (SetState on a checkbox, a reset); those are not values.
  const at = stream.indexOf('"modelStates":[');
  const model = parseAt<
    { key?: { key?: { value?: { id?: string } } }; value?: Record<string, unknown> }[]
  >(stream, at === -1 ? -1 : stream.indexOf('[', at));
  if (model === null) return drift('the profile form carried no initial values');

  const states = new Map<string, ModelValue>();
  for (const entry of model) {
    const id = entry.key?.key?.value?.id;
    if (id !== undefined && entry.value !== undefined && !states.has(id)) {
      states.set(id, plain(entry.value));
    }
  }

  const req = stream.indexOf(`"requestId":"${field.save}","requestedArguments":`);
  const args =
    req === -1
      ? null
      : parseAt<ProfileForm['args']>(
          stream,
          stream.indexOf('{', stream.indexOf('"requestedArguments":', req)),
        );
  if (args === null || !Array.isArray(args.requestedStateKeys) || args.payload === undefined) {
    return drift(`the profile form carried no ${field.save.split('.').pop()} action`);
  }
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
 * Values the browser computes rather than reads. The About save carries the
 * top-skills list as an expression over a client-side collection, which starts
 * as `initialSkills` and is sent unchanged when skills are not touched.
 */
function computed(form: ProfileForm, key: string): ModelValue | Failure | undefined {
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
  return { protoCase: 'expression', value: [] };
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
  if (target === undefined || !form.states.has(target)) {
    return drift(`the profile form has no ${field.name} field`);
  }

  const states: unknown[] = [];
  for (const { key } of form.args.requestedStateKeys) {
    const id = key.value.id;
    let state: ModelValue | Failure | undefined = form.states.get(id);
    if (state?.protoCase === 'expression') state = computed(form, id);
    if (state === undefined) continue; // absent from the form: the browser omits it too
    if ('ok' in state) return state;
    states.push({
      key: id,
      namespace: 'MemoryNamespace',
      value: id === target ? value : state.value,
      originalProtoCase: state.protoCase,
      protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id } },
    });
  }

  const requestedArguments = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: form.args.requestedStateKeys,
    payload: form.args.payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  const body = {
    requestId: form.save,
    serverRequest: {
      requestId: form.save,
      requestedArguments,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states,
    requestedArguments: {
      ...requestedArguments,
      states,
      screenId: form.screen,
      knownTemplateIds: [],
    },
  };
  return { ok: true, body };
}

/** Open the form for a field. */
export async function fetchProfileForm(
  field: ProfileField,
  vanityName: string,
  client: Client,
): Promise<ProfileForm | Failure> {
  const result = await client.request({
    url: `${NAV_URL}?screenId=${field.screen}&sduiid=${field.screen}`,
    method: 'POST',
    body: formNavBody(field.screen, vanityName),
    spendClass: 'page',
    operation: `profile-${field.name}-form`,
  });
  if (!result.ok) {
    const out: Failure = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return readForm((result.classification as { raw?: string }).raw ?? '', field);
}

/** Send a save built by `saveBody`. A 200 can still carry errors; they are read. */
export async function sendProfileSave(
  form: ProfileForm,
  body: Record<string, unknown>,
  client: Client,
): Promise<{ ok: true } | Failure> {
  const result = await client.request({
    url: `${ACTION_URL}?sduiid=${form.save}`,
    method: 'POST',
    body,
    spendClass: 'write',
    operation: 'profile-save',
  });
  if (!result.ok) {
    const out: Failure = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  const raw = (result.classification as { raw?: string }).raw ?? '';
  const errors = raw.match(/"errors":\[([^\]]+)\]/)?.[1];
  if (errors !== undefined) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `LinkedIn refused the save: ${errors.slice(0, 300)}`,
    };
  }
  return { ok: true };
}
