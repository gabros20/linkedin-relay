// ─── `lnrelay skill add|remove`, and `lnrelay skills` ─────────────────────────
//
// See engine/sdui-skill.ts. Every change is planned from what the profile
// holds now and read back afterwards.

import type { Session } from '../engine/auth.ts';
import { createEngine, createLiveClient } from '../engine/index.ts';
import type { Failure } from '../engine/sdui-form.ts';
import {
  addSkillBody,
  fetchSkills,
  openSkillForm,
  removeSkillBody,
  SKILL,
  type Skill,
  type SkillForm,
  sendSkill,
  skillNameOf,
} from '../engine/sdui-skill.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { refuseUnapprovable, terminalDeps } from './gate.ts';
import { authorLine, gate, prepare } from './write.ts';

/** What a skill change needs from LinkedIn. Injectable so tests send nothing. */
export interface SkillSurface {
  vanity(): Promise<{ ok: true; vanity: string } | Failure>;
  list(vanity: string): Promise<{ ok: true; skills: Skill[] } | Failure>;
  open(payload: Record<string, unknown>, edit: boolean): Promise<SkillForm | Failure>;
  send(body: unknown, requestId: string): Promise<{ ok: true } | Failure>;
}

function liveSkills(session: Session, quiet = false): SkillSurface {
  const client = createLiveClient(session, undefined, quiet);
  return {
    vanity: async () => {
      const me = await createEngine(session, undefined, quiet).whoami();
      if (!me.ok) return me;
      const id = me.value?.publicIdentifier;
      return typeof id === 'string' && id !== ''
        ? { ok: true, vanity: id }
        : { ok: false, code: 'SCHEMA_DRIFT', message: 'whoami returned no public profile id' };
    },
    list: (vanity) => fetchSkills(vanity, client),
    open: (payload, edit) => openSkillForm(payload, client, edit),
    send: (body, requestId) => sendSkill(body, requestId, client),
  };
}

const listed = (skills: Skill[]) =>
  skills.map((s) => `${s.skillId} (${s.name ?? '?'})`).join(', ') || 'none';

export async function runSkill(
  sub: string | undefined,
  arg: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  surface?: SkillSurface,
): Promise<Envelope> {
  if (sub !== 'add' && sub !== 'remove') {
    return err(
      'skill',
      'INVALID_INPUT',
      `unknown skill subcommand '${sub ?? ''}'`,
      'lnrelay skill add "<name>" | lnrelay skill remove <skill-id>',
    );
  }
  if (arg === undefined || arg.trim() === '') {
    return err(
      'skill',
      'INVALID_INPUT',
      sub === 'add' ? 'the skill name is required' : 'the skill id is required',
      'ids come from `lnrelay skills`',
    );
  }
  const unapprovable = refuseUnapprovable('skill', 'changing your skills', deps);
  if (unapprovable !== null) return unapprovable;
  const ctx = prepare('skill', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager')
    return err('skill', 'NOT_IMPLEMENTED', 'skill changes go over the browser session only');

  const skills = surface ?? liveSkills(ctx.transport.session);
  const me = await skills.vanity();
  if (!me.ok) return err('skill', me.code, me.message, me.hint);
  const before = await skills.list(me.vanity);
  if (!before.ok) return err('skill', before.code, before.message, before.hint);

  return sub === 'add'
    ? addSkill(arg.trim(), before.skills, me.vanity, skills, ctx, deps)
    : removeSkill(arg, before.skills, me.vanity, skills, ctx, deps);
}

type Ctx = Exclude<ReturnType<typeof prepare>, Envelope>;

async function addSkill(
  name: string,
  current: Skill[],
  vanity: string,
  skills: SkillSurface,
  ctx: Ctx,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const dup = current.find((s) => s.name?.toLowerCase() === name.toLowerCase());
  if (dup !== undefined)
    return err(
      'skill',
      'INVALID_INPUT',
      `"${dup.name}" is already on your profile (${dup.skillId})`,
    );
  const form = await skills.open({ vanityName: vanity }, false);
  if (!form.ok) return err('skill', form.code, form.message, form.hint);
  const body = addSkillBody(form, name);
  if (!body.ok) return err('skill', body.code, body.message, body.hint);

  const plan: WritePlan<{ name: string }> = {
    action: 'add a skill to your profile',
    payload: { name },
    summary: [
      authorLine(ctx.transport),
      `skill    "${name}"`,
      'linked   to nothing (no roles, schools or projects)',
    ],
    reversibility: 'removable with `lnrelay skill remove <skill-id>`',
    transport: 'voyager',
  };
  const gated = await gate('skill', plan, ctx, deps);
  if ('ok' in gated) return gated;
  const sent = await skills.send(body.body, SKILL.save);
  if (!sent.ok) return err('skill', sent.code, sent.message, sent.hint);
  const after = await skills.list(vanity);
  const known = new Set(current.map((s) => s.skillId));
  const added = after.ok ? after.skills.find((s) => !known.has(s.skillId)) : undefined;
  if (added === undefined)
    return err(
      'skill',
      'SCHEMA_DRIFT',
      'LinkedIn accepted the skill, but it does not appear on your profile',
    );
  return ok('skill', { added: added.skillId, name: added.name, verified: true });
}

async function removeSkill(
  arg: string,
  current: Skill[],
  vanity: string,
  skills: SkillSurface,
  ctx: Ctx,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const target = current.find((s) => s.skillId === arg);
  if (target === undefined)
    return err(
      'skill',
      'NOT_FOUND',
      `no skill ${arg} on your profile`,
      `your skills: ${listed(current)}`,
    );
  const form = await skills.open({ ...target.payload, vanityName: vanity }, true);
  if (!form.ok) return err('skill', form.code, form.message, form.hint);
  const body = removeSkillBody(form);
  if (!body.ok) return err('skill', body.code, body.message, body.hint);
  const name = skillNameOf(form) ?? target.name ?? '?';

  const plan: WritePlan<{ skillId: string; name: string }> = {
    action: 'remove a skill from your profile',
    payload: { skillId: target.skillId, name },
    summary: [authorLine(ctx.transport), `skill    "${name}" (${target.skillId})`],
    reversibility:
      'NONE for its endorsements, which go with it; the skill itself can be added again',
    transport: 'voyager',
  };
  const gated = await gate('skill', plan, ctx, deps);
  if ('ok' in gated) return gated;
  const sent = await skills.send(body.body, SKILL.delete);
  if (!sent.ok) return err('skill', sent.code, sent.message, sent.hint);
  const after = await skills.list(vanity);
  if (!after.ok || after.skills.some((s) => s.skillId === target.skillId)) {
    return err(
      'skill',
      'SCHEMA_DRIFT',
      'LinkedIn accepted the removal, but the skill is still listed',
    );
  }
  return ok('skill', { removed: target.skillId, verified: true });
}

/** `lnrelay skills`: the skills on the owner's profile, with their ids. */
export async function runSkills(quiet = false): Promise<Envelope> {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('skills', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const skills = liveSkills(session.session, quiet);
  const me = await skills.vanity();
  if (!me.ok) return err('skills', me.code, me.message, me.hint);
  const listedSkills = await skills.list(me.vanity);
  if (!listedSkills.ok)
    return err('skills', listedSkills.code, listedSkills.message, listedSkills.hint);
  return ok('skills', {
    items: listedSkills.skills.map((s) => ({ skillId: s.skillId, name: s.name })),
    meta: { state: 'complete', returnedCount: listedSkills.skills.length },
  });
}
