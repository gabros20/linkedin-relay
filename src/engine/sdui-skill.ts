// ─── Skills: listing, adding and removing ─────────────────────────────────────
//
// Captured 2026-10-14 by adding a free-text test skill in the browser. Unlike
// a role, the add form carries its save (`saveProfileSkillForm`) directly; an
// existing skill's form carries `deleteProfileSkillForm`. The list is a pager
// (`pagers.profile.details.skills`) whose payload the Skills screen hands out.
// A skill is added on its own: no links to roles, schools or projects.

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

export const SKILL = {
  addScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfileSkillAddForm',
  editScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfileSkillDetailsEditForm',
  listScreen: 'com.linkedin.sdui.flagshipnav.profile.ProfileSkillDetails',
  pager: 'com.linkedin.sdui.pagers.profile.details.skills',
  save: 'com.linkedin.sdui.requests.profile.saveProfileSkillForm',
  delete: 'com.linkedin.sdui.requests.profile.deleteProfileSkillForm',
} as const;

export interface Skill {
  skillId: string;
  /** Null when the name could not be paired with its row for certain. */
  name: string | null;
  /** What the list opens this skill's form with. */
  payload: Record<string, unknown>;
}

const EDIT_NAV = `{"$type":"proto.sdui.actions.core.NavigateToScreen","screenId":"${SKILL.editScreen}"`;
const TEXT = /"children":\["((?:[^"\\]|\\.)*)"\]/g;

/**
 * One page of skills. Each row's name is the single text node between the
 * previous row's edit action and its own; any other count leaves it null.
 */
export function skillsFromPage(stream: string): { ok: true; skills: Skill[] } | Failure {
  if (
    !stream.includes(SKILL.pager) &&
    !stream.includes(EDIT_NAV) &&
    !stream.includes('isPartialPage')
  ) {
    return drift('the skills page could not be read');
  }
  const skills: Skill[] = [];
  let from = 0;
  let i = 0;
  for (;;) {
    i = stream.indexOf(EDIT_NAV, i);
    if (i === -1) break;
    const text = balanced(stream, i);
    const end = i;
    i += EDIT_NAV.length;
    if (text === null) continue;
    const payload = (
      JSON.parse(text) as { requestedArguments?: { payload?: Record<string, unknown> } }
    ).requestedArguments?.payload;
    const id = payload?.skillId;
    if (typeof id !== 'string' || payload === undefined || skills.some((s) => s.skillId === id))
      continue;
    const names = [...stream.slice(from, end).matchAll(TEXT)].map(
      (m) => JSON.parse(`"${m[1]}"`) as string,
    );
    skills.push({ skillId: id, name: names.length === 1 ? (names[0] ?? null) : null, payload });
    from = end + text.length;
  }
  return { ok: true, skills };
}

/** The pager request for the page starting at `start`, from the screen's own payload. */
export function pagerFrom(payload: Record<string, unknown>, start: number) {
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload: { ...payload, start },
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    pagerId: SKILL.pager,
    clientArguments: { ...args, states: [], screenId: SKILL.listScreen, knownTemplateIds: [] },
    paginationRequest: {
      $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: SKILL.pager,
      retryCount: 0,
      requestedArguments: args,
    },
  };
}

export interface SkillForm {
  ok: true;
  model: Model;
  save: RequestArgs | null;
  del: RequestArgs | null;
  screen: string;
}

export function readSkillForm(stream: string): SkillForm | Failure {
  const model = readModel(stream);
  if (model === null) return drift('the skill form carried no initial values');
  const save = findRequest(stream, SKILL.save);
  const del = findRequest(stream, SKILL.delete);
  if (save === null && del === null)
    return drift('the skill form carried neither a save nor a delete');
  return { ok: true, model, save, del, screen: del === null ? SKILL.addScreen : SKILL.editScreen };
}

const nameKey = (model: Model) =>
  [...model.keys()].find((k) => k.startsWith('addSkillsTypeaheadSkillName'));

export function skillNameOf(form: SkillForm): string | null {
  const key = nameKey(form.model);
  const v = key === undefined ? undefined : form.model.get(key)?.value;
  return typeof v === 'string' ? v : null;
}

/** The add, as typed free text: no catalogue id, linked to nothing. */
export function addSkillBody(form: SkillForm, name: string): { ok: true; body: unknown } | Failure {
  if (name.trim() === '')
    return { ok: false, code: 'INVALID_INPUT', message: 'a skill needs a name' };
  if (form.save === null) return drift('this form has no save action (it is not the add form)');
  const key = nameKey(form.model);
  const current = key === undefined ? undefined : form.model.get(key);
  if (key === undefined || current === undefined) return drift('the skill form has no name field');
  const model: Model = new Map(form.model);
  model.set(key, { ...current, value: name.trim() });
  const states = wireStates(keysOf(form.save), model, () => undefined);
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(SKILL.save, form.save, states, form.screen) };
}

export function removeSkillBody(form: SkillForm): { ok: true; body: unknown } | Failure {
  if (form.del === null)
    return drift('this form has no delete action (it is not an existing skill)');
  const states = wireStates(keysOf(form.del), form.model, () => undefined);
  if (!Array.isArray(states)) return states;
  return { ok: true, body: requestBody(SKILL.delete, form.del, states, form.screen) };
}

// ─── Over the wire ────────────────────────────────────────────────────────────

const PAGER_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${SKILL.pager}`;
const MAX_PAGES = 10;

/** Every skill: the Skills screen for the pager's payload, then its pages. */
export async function fetchSkills(
  vanityName: string,
  client: Client,
): Promise<{ ok: true; skills: Skill[] } | Failure> {
  const screen = await openForm(
    SKILL.listScreen,
    { vanityName, isVanityNameResolved: true },
    client,
    'skills-screen',
  );
  if (typeof screen !== 'string') return screen;
  // The "All" filter's first-page request, as the screen hands it out.
  const at = screen.indexOf('"filter":"ProfileSkillCategory_ALL"');
  const open = at === -1 ? -1 : screen.lastIndexOf('"payload":{', at);
  const text = open === -1 ? null : balanced(screen, open + '"payload":'.length);
  if (text === null) return drift('the Skills screen carried no list request');
  const payload = JSON.parse(text) as Record<string, unknown>;
  const count = typeof payload.count === 'number' ? payload.count : 10;

  const skills: Skill[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.request({
      url: PAGER_URL,
      method: 'POST',
      body: pagerFrom(payload, skills.length),
      spendClass: 'page',
      operation: 'skills',
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const parsed = skillsFromPage((result.classification as { raw?: string }).raw ?? '');
    if (!parsed.ok) return parsed;
    const fresh = parsed.skills.filter((s) => !skills.some((k) => k.skillId === s.skillId));
    skills.push(...fresh);
    if (parsed.skills.length < count || fresh.length === 0) break;
  }
  return { ok: true, skills };
}

export async function openSkillForm(
  payload: Record<string, unknown>,
  client: Client,
  edit: boolean,
) {
  const stream = await openForm(
    edit ? SKILL.editScreen : SKILL.addScreen,
    { ...payload, isVanityNameResolved: true },
    client,
    edit ? 'skill-edit-form' : 'skill-add-form',
  );
  return typeof stream === 'string' ? readSkillForm(stream) : stream;
}

export async function sendSkill(
  body: unknown,
  requestId: string,
  client: Client,
): Promise<{ ok: true } | Failure> {
  const sent = await sendAction(
    requestId,
    body,
    client,
    requestId === SKILL.save ? 'skill-add' : 'skill-remove',
  );
  return typeof sent === 'string' ? { ok: true } : sent;
}
