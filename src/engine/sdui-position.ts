// ─── Experience: adding, editing and removing a role ──────────────────────────
//
// Captured 2026-10-14 by adding a test role in the browser and deleting it.
// Three things learned the hard way:
//
// 1. The save is not in the form. The form's Save fires `uploadPositionMedia`,
//    and the REPLY to that carries the `saveProfilePositionForm` action. So a
//    save is: open the form (read), send the media step, take the save from its
//    reply, send it.
// 2. The add form defaults `dynamicallyCreateHeadline` to true. Saving the test
//    role replaced the owner's headline with "<title> at <org>", on the live
//    profile, unnoticed until the owner saw it. Here it is always false.
// 3. "Notify network" (`allowProfileEditBroadcasts`) also defaults on in the
//    browser. Here it is off unless asked for.
//
// As with the intro and About (sdui-profile.ts), nothing is hand-built: every
// value is the form's own, and only the fields asked for are replaced.

import type { Client } from './client.ts';
import {
  balanced,
  type Failure,
  findRequest,
  keysOf,
  type Model,
  type RequestArgs,
  readModel,
  requestBody,
  wireStates,
} from './sdui-form.ts';
import { drift, openForm, sendAction } from './sdui-profile.ts';

export const POSITION = {
  addScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfilePositionAddForm',
  editScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfilePositionDetailsEditForm',
  listScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfileExperienceDetails',
  media: 'com.linkedin.sdui.impl.profile.components.forms.uploadPositionMedia',
  save: 'com.linkedin.sdui.requests.profile.saveProfilePositionForm',
  delete: 'com.linkedin.sdui.requests.profile.deleteProfilePositionForm',
} as const;

export interface Position {
  positionId: string;
  title: string;
  /** What the Experience list opens this role's edit form with. */
  payload: Record<string, unknown>;
}

const EDIT_NAV = `{"$type":"proto.sdui.actions.core.NavigateToScreen","screenId":"${POSITION.editScreen}"`;

/** Every role on the Experience screen, with the id it is edited by. */
export function listPositions(stream: string): { ok: true; positions: Position[] } | Failure {
  if (readModel(stream) === null && !stream.includes(EDIT_NAV) && !stream.includes('"rows"')) {
    return drift('the Experience screen could not be read');
  }
  const positions: Position[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (;;) {
    i = stream.indexOf(EDIT_NAV, i);
    if (i === -1) break;
    const text = balanced(stream, i);
    i += EDIT_NAV.length;
    if (text === null) continue;
    const payload = (
      JSON.parse(text) as { requestedArguments?: { payload?: Record<string, unknown> } }
    ).requestedArguments?.payload;
    const id = payload?.positionId;
    if (typeof id !== 'string' || seen.has(id) || payload === undefined) continue;
    seen.add(id);
    positions.push({ positionId: id, title: String(payload.title ?? ''), payload });
  }
  if (positions.length === 0 && !stream.includes('"rows"') && !stream.includes('Experience')) {
    return drift('the Experience screen listed no roles and did not look like one');
  }
  return { ok: true, positions };
}

export interface PositionForm {
  ok: true;
  model: Model;
  /** Shared by every field key: `auto-binding-<uuid>ProfilePositionForm`. */
  prefix: string;
  media: RequestArgs;
  del: RequestArgs | null;
  screen: string;
}

export function readPositionForm(stream: string): PositionForm | Failure {
  const model = readModel(stream);
  if (model === null) return drift('the position form carried no initial values');
  const media = findRequest(stream, POSITION.media);
  const prefix = media?.payload.formIdPrefix;
  if (media === null || typeof prefix !== 'string') {
    return drift('the position form carried no save step (uploadPositionMedia)');
  }
  const del = findRequest(stream, POSITION.delete);
  return {
    ok: true,
    model,
    prefix,
    media,
    del,
    screen: del === null ? POSITION.addScreen : POSITION.editScreen,
  };
}

export interface YearMonth {
  month: number;
  year: number;
}

export interface PositionChanges {
  title?: string;
  company?: string;
  description?: string;
  location?: string;
  start?: YearMonth;
  /** `present` marks it a current role. */
  end?: YearMonth | 'present';
  /** Tell the network about it. Off unless asked. */
  notify?: boolean;
}

const date = (d: YearMonth) => ({
  $type: 'proto.sdui.common.Date',
  day: 0,
  month: d.month,
  year: d.year,
});
const ym = (v: unknown) => {
  const d = v as { month?: number; year?: number } | undefined;
  return d?.year ? `${d.year}-${String(d.month ?? 0).padStart(2, '0')}` : null;
};

/** The form's values with the asked-for changes, and the two safety overrides. */
export function applyChanges(
  form: PositionForm,
  changes: PositionChanges,
): { ok: true; model: Model } | Failure {
  const model: Model = new Map(form.model);
  const set = (field: string, value: unknown) => {
    const key = `${form.prefix}${field}`;
    const current = model.get(key);
    if (current === undefined) return false;
    model.set(key, { ...current, value });
    return true;
  };
  const missing: string[] = [];
  const need = (field: string, value: unknown) => {
    if (!set(field, value)) missing.push(field);
  };

  if (changes.title !== undefined) need('title', changes.title);
  if (changes.description !== undefined) need('description', changes.description);
  if (changes.location !== undefined) need('location', changes.location);
  if (changes.company !== undefined) {
    // Free text: not linked to a company page, as when typed without picking one.
    need('companyName', changes.company);
    need('organizationId', -1);
    need('organizationEntityId', { type: 'bigint', value: '-1' });
  }
  if (changes.start !== undefined) need('startDate', date(changes.start));
  if (changes.end === 'present') need('isCurrentPosition', true);
  else if (changes.end !== undefined) {
    need('isCurrentPosition', false);
    need('endDate', date(changes.end));
  }
  need('dynamicallyCreateHeadline', false);
  need('allowProfileEditBroadcasts', changes.notify === true);
  if (missing.length > 0) return drift(`the position form has no ${missing.join(', ')} field`);

  const s = roleSummary(model);
  if (!s.current && s.start !== null && s.end !== null && s.end < s.start) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `the role ends (${s.end}) before it starts (${s.start})`,
    };
  }
  return { ok: true, model };
}

/** What a role says now, for the preview. */
export function roleSummary(model: Model) {
  const get = (field: string) =>
    [...model.entries()].find(([k]) => k.endsWith(`ProfilePositionForm${field}`))?.[1].value;
  const current = get('isCurrentPosition') === true;
  return {
    title: String(get('title') ?? ''),
    company: String(get('companyName') ?? ''),
    start: ym(get('startDate')),
    end: current ? null : ym(get('endDate')),
    current,
    location: String(get('location') ?? ''),
    description: String(get('description') ?? ''),
  };
}

/** Media on a role is a computed list nothing here has observed; refuse rather than drop it. */
function noMedia(model: Model): Failure | null {
  const count = [...model.entries()].find(([k]) =>
    k.endsWith('position-mediaUiCollection-mediaCount'),
  )?.[1].value;
  return typeof count === 'number' && count > 0
    ? {
        ok: false,
        code: 'NOT_IMPLEMENTED',
        message: 'this role has media attached, and saving one with media has not been verified',
        hint: 'Edit it in the browser for now; nothing was changed.',
      }
    : null;
}

const resolver = (key: string) =>
  key.endsWith('position-mediaIds') ? { ok: true as const, value: [] } : undefined;

/** The media step the browser sends on Save; its reply carries the save. */
export function mediaBody(form: PositionForm, model: Model): { ok: true; body: unknown } | Failure {
  const refused = noMedia(model);
  if (refused !== null) return refused;
  const states = wireStates(keysOf(form.media), model, resolver);
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(POSITION.media, form.media, states, form.screen) };
}

export function saveFromReply(reply: string): { ok: true; args: RequestArgs } | Failure {
  const args = findRequest(reply, POSITION.save);
  return args === null
    ? drift('the media step did not hand back the save action')
    : { ok: true, args };
}

/** The save, from the action the media step returned. */
export function positionSaveBody(
  save: RequestArgs,
  model: Model,
  screen: string,
): { ok: true; body: unknown } | Failure {
  // The browser flips its "saving" flag on before the request leaves; mirror it.
  const sending: Model = new Map(model);
  for (const [k, v] of sending)
    if (k.endsWith('isActiveProfileFormLoading')) sending.set(k, { ...v, value: true });
  const states = wireStates(keysOf(save), sending, resolver);
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(POSITION.save, save, states, screen) };
}

export function deleteBody(form: PositionForm): { ok: true; body: unknown } | Failure {
  if (form.del === null)
    return drift('this form has no delete action (it is not an existing role)');
  const states = wireStates(keysOf(form.del), form.model, resolver);
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(POSITION.delete, form.del, states, form.screen) };
}

// ─── Over the wire ────────────────────────────────────────────────────────────

export async function fetchPositions(vanityName: string, client: Client) {
  const stream = await openForm(
    POSITION.listScreen,
    { vanityName, isVanityNameResolved: true },
    client,
    'experience-list',
  );
  return typeof stream === 'string' ? listPositions(stream) : stream;
}

export async function openPositionForm(
  payload: Record<string, unknown>,
  client: Client,
  edit: boolean,
): Promise<PositionForm | Failure> {
  const stream = await openForm(
    edit ? POSITION.editScreen : POSITION.addScreen,
    { ...payload, isVanityNameResolved: true },
    client,
    edit ? 'position-edit-form' : 'position-add-form',
  );
  return typeof stream === 'string' ? readPositionForm(stream) : stream;
}

/** Media step, then the save it hands back. */
export async function sendPositionSave(
  form: PositionForm,
  model: Model,
  client: Client,
): Promise<{ ok: true } | Failure> {
  const media = mediaBody(form, model);
  if (!media.ok) return media;
  const reply = await sendAction(POSITION.media, media.body, client, 'position-media-step', 'page');
  if (typeof reply !== 'string') return reply;
  const save = saveFromReply(reply);
  if (!save.ok) return save;
  const body = positionSaveBody(save.args, model, form.screen);
  if (!body.ok) return body;
  const sent = await sendAction(POSITION.save, body.body, client, 'position-save');
  return typeof sent === 'string' ? { ok: true } : sent;
}

export async function sendPositionDelete(
  form: PositionForm,
  client: Client,
): Promise<{ ok: true } | Failure> {
  const body = deleteBody(form);
  if (!body.ok) return body;
  const sent = await sendAction(POSITION.delete, body.body, client, 'position-delete');
  return typeof sent === 'string' ? { ok: true } : sent;
}
