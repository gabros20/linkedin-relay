// ─── `lnrelay role add|edit|remove`, and `lnrelay experience` ─────────────────
//
// Roles on the owner's Experience section. Every change is planned from the
// form LinkedIn holds now and read back afterwards; see engine/sdui-position.ts
// for how a save is put together and why the headline is never touched.

import type { Session } from '../engine/auth.ts';
import { createEngine, createLiveClient } from '../engine/index.ts';
import type { Failure, Model } from '../engine/sdui-form.ts';
import {
  applyChanges,
  fetchPositions,
  openPositionForm,
  type Position,
  type PositionChanges,
  type PositionForm,
  roleSummary,
  sendPositionDelete,
  sendPositionSave,
  type YearMonth,
} from '../engine/sdui-position.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { refuseUnapprovable, terminalDeps } from './gate.ts';
import { authorLine, gate, prepare } from './write.ts';

/** What a role change needs from LinkedIn. Injectable so tests send nothing. */
export interface RoleSurface {
  vanity(): Promise<{ ok: true; vanity: string } | Failure>;
  list(vanity: string): Promise<{ ok: true; positions: Position[] } | Failure>;
  open(payload: Record<string, unknown>, edit: boolean): Promise<PositionForm | Failure>;
  save(form: PositionForm, model: Model): Promise<{ ok: true } | Failure>;
  remove(form: PositionForm): Promise<{ ok: true } | Failure>;
}

function liveRoles(session: Session, quiet = false): RoleSurface {
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
    list: (vanity) => fetchPositions(vanity, client),
    open: (payload, edit) => openPositionForm(payload, client, edit),
    save: (form, model) => sendPositionSave(form, model, client),
    remove: (form) => sendPositionDelete(form, client),
  };
}

/** What the CLI asked for, before validation. Dates are YYYY-MM. */
export interface RoleRequest {
  title?: string;
  company?: string;
  start?: string;
  end?: string;
  current?: boolean;
  description?: string;
  location?: string;
  notify?: boolean;
}

const SUBCOMMANDS = 'add, edit <position-id>, remove <position-id>';

function yearMonth(flag: string, v: string): YearMonth | Envelope {
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  const month = Number(m?.[2]);
  if (m === null || month < 1 || month > 12) {
    return err(
      'role',
      'INVALID_INPUT',
      `--${flag} '${v}' is not a month`,
      'use YYYY-MM, e.g. 2021-06',
    );
  }
  return { year: Number(m[1]), month };
}

function changesFrom(req: RoleRequest): PositionChanges | Envelope {
  const c: PositionChanges = {};
  if (req.title !== undefined) c.title = req.title;
  if (req.company !== undefined) c.company = req.company;
  if (req.description !== undefined) c.description = req.description;
  if (req.location !== undefined) c.location = req.location;
  if (req.notify === true) c.notify = true;
  if (req.start !== undefined) {
    const d = yearMonth('start', req.start);
    if ('ok' in d) return d;
    c.start = d;
  }
  if (req.current === true && req.end !== undefined) {
    return err('role', 'INVALID_INPUT', '--current and --end contradict each other');
  }
  if (req.current === true) c.end = 'present';
  else if (req.end !== undefined) {
    const d = yearMonth('end', req.end);
    if ('ok' in d) return d;
    c.end = d;
  }
  return c;
}

const span = (s: ReturnType<typeof roleSummary>) =>
  `${s.start ?? '?'} – ${s.current ? 'present' : (s.end ?? '?')}`;
const q = (v: string) => `"${v.length > 160 ? `${v.slice(0, 160)}…` : v.replace(/\n/g, ' ')}"`;

function roleLines(s: ReturnType<typeof roleSummary>): string[] {
  return [
    `title    ${q(s.title)}`,
    `company  ${q(s.company)}`,
    `dates    ${span(s)}`,
    ...(s.location === '' ? [] : [`location ${q(s.location)}`]),
    ...(s.description === '' ? [] : [`about    ${q(s.description)}`]),
  ];
}

/** Only what differs, from → to. */
function diffLines(a: ReturnType<typeof roleSummary>, b: ReturnType<typeof roleSummary>): string[] {
  const out: string[] = [];
  const row = (label: string, x: string, y: string) => {
    if (x !== y) out.push(`${label.padEnd(8)} ${q(x)} → ${q(y)}`);
  };
  row('title', a.title, b.title);
  row('company', a.company, b.company);
  row('dates', span(a), span(b));
  row('location', a.location, b.location);
  row('about', a.description, b.description);
  return out;
}

const SAFETY = (notify: boolean) => [
  'headline unchanged (LinkedIn would otherwise rewrite it from this role)',
  `notify   ${notify ? 'ON — your network may be told' : 'off'}`,
];

export async function runRole(
  sub: string | undefined,
  target: string | undefined,
  req: RoleRequest,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  surface?: RoleSurface,
): Promise<Envelope> {
  if (sub !== 'add' && sub !== 'edit' && sub !== 'remove') {
    return err(
      'role',
      'INVALID_INPUT',
      `unknown role subcommand '${sub ?? ''}'`,
      `lnrelay role ${SUBCOMMANDS}`,
    );
  }
  if (sub === 'add') {
    const missing = (['title', 'company', 'start'] as const).filter(
      (f) => req[f] === undefined || req[f] === '',
    );
    if (missing.length > 0) {
      return err(
        'role',
        'INVALID_INPUT',
        `a new role needs ${missing.map((f) => `--${f}`).join(', ')}`,
      );
    }
  } else if (target === undefined || !/^\d+$/.test(target)) {
    return err(
      'role',
      'INVALID_INPUT',
      `role ${sub} needs a position id`,
      'list them with `lnrelay experience`',
    );
  }
  const changes = changesFrom(req);
  if ('ok' in changes) return changes;
  if (sub === 'edit' && Object.keys(changes).filter((k) => k !== 'notify').length === 0) {
    return err(
      'role',
      'INVALID_INPUT',
      'nothing to change',
      'pass --title, --company, --start, --end, --current, --location or --description',
    );
  }

  const unapprovable = refuseUnapprovable('role', 'changing a role', deps);
  if (unapprovable !== null) return unapprovable;
  const ctx = prepare('role', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('role', 'NOT_IMPLEMENTED', 'role changes go over the browser session only');
  }
  const roles = surface ?? liveRoles(ctx.transport.session);
  const me = await roles.vanity();
  if (!me.ok) return err('role', me.code, me.message, me.hint);
  const listed = await roles.list(me.vanity);
  if (!listed.ok) return err('role', listed.code, listed.message, listed.hint);

  if (sub === 'add') return addRole(changes, me.vanity, listed.positions, roles, ctx, deps);
  const position = listed.positions.find((p) => p.positionId === target);
  if (position === undefined) {
    return err(
      'role',
      'NOT_FOUND',
      `no role ${target} on your profile`,
      `your roles: ${listed.positions.map((p) => `${p.positionId} (${p.title})`).join(', ') || 'none'}`,
    );
  }
  const form = await roles.open({ ...position.payload, vanityName: me.vanity }, true);
  if (!form.ok) return err('role', form.code, form.message, form.hint);
  return sub === 'edit'
    ? editRole(position, form, changes, me.vanity, roles, ctx, deps)
    : removeRole(position, form, me.vanity, roles, ctx, deps);
}

type Ctx = Exclude<ReturnType<typeof prepare>, Envelope>;

async function addRole(
  changes: PositionChanges,
  vanity: string,
  before: Position[],
  roles: RoleSurface,
  ctx: Ctx,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const form = await roles.open({ vanityName: vanity }, false);
  if (!form.ok) return err('role', form.code, form.message, form.hint);
  const applied = applyChanges(form, changes);
  if (!applied.ok) return err('role', applied.code, applied.message, applied.hint);
  const role = roleSummary(applied.model);

  const plan: WritePlan<{ changes: PositionChanges }> = {
    action: 'add a role to your profile',
    payload: { changes },
    summary: [authorLine(ctx.transport), ...roleLines(role), ...SAFETY(changes.notify === true)],
    reversibility: 'removable with `lnrelay role remove <position-id>`',
    transport: 'voyager',
  };
  const gated = await gate('role', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const saved = await roles.save(form, applied.model);
  if (!saved.ok) return err('role', saved.code, saved.message, saved.hint);
  const after = await roles.list(vanity);
  const known = new Set(before.map((p) => p.positionId));
  const added = after.ok
    ? after.positions.find((p) => !known.has(p.positionId) && p.title === role.title)
    : undefined;
  if (added === undefined) {
    return err(
      'role',
      'SCHEMA_DRIFT',
      'LinkedIn accepted the role, but it does not appear on your profile',
    );
  }
  return ok('role', { added: added.positionId, verified: true });
}

async function editRole(
  position: Position,
  form: PositionForm,
  changes: PositionChanges,
  vanity: string,
  roles: RoleSurface,
  ctx: Ctx,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const applied = applyChanges(form, changes);
  if (!applied.ok) return err('role', applied.code, applied.message, applied.hint);
  const was = roleSummary(form.model);
  const will = roleSummary(applied.model);
  const diff = diffLines(was, will);
  if (diff.length === 0)
    return err('role', 'INVALID_INPUT', 'the role already reads exactly that; nothing to save');

  // `was` is bound: a role that changed after the preview is a different edit.
  const plan: WritePlan<{ positionId: string; was: typeof was; changes: PositionChanges }> = {
    action: 'edit a role on your profile',
    payload: { positionId: position.positionId, was, changes },
    summary: [
      authorLine(ctx.transport),
      `role     ${position.positionId}`,
      ...diff,
      ...SAFETY(changes.notify === true),
    ],
    reversibility: 'editable again; the old values are kept only in this preview and the audit log',
    transport: 'voyager',
  };
  const gated = await gate('role', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const saved = await roles.save(form, applied.model);
  if (!saved.ok) return err('role', saved.code, saved.message, saved.hint);
  const reread = await roles.open({ ...position.payload, vanityName: vanity }, true);
  const now = reread.ok ? roleSummary(reread.model) : null;
  if (now === null || diffLines(will, now).length > 0) {
    return err(
      'role',
      'SCHEMA_DRIFT',
      'LinkedIn accepted the edit, but the role does not read back as edited',
    );
  }
  return ok('role', { edited: position.positionId, verified: true });
}

async function removeRole(
  position: Position,
  form: PositionForm,
  vanity: string,
  roles: RoleSurface,
  ctx: Ctx,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const role = roleSummary(form.model);
  const plan: WritePlan<{ positionId: string; role: typeof role }> = {
    action: 'remove a role from your profile',
    payload: { positionId: position.positionId, role },
    summary: [authorLine(ctx.transport), `role     ${position.positionId}`, ...roleLines(role)],
    reversibility: 'NONE. LinkedIn deletes it; re-adding makes a new role.',
    transport: 'voyager',
  };
  const gated = await gate('role', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const removed = await roles.remove(form);
  if (!removed.ok) return err('role', removed.code, removed.message, removed.hint);
  const after = await roles.list(vanity);
  if (!after.ok || after.positions.some((p) => p.positionId === position.positionId)) {
    return err(
      'role',
      'SCHEMA_DRIFT',
      'LinkedIn accepted the removal, but the role is still listed',
    );
  }
  return ok('role', { removed: position.positionId, verified: true });
}

/** `lnrelay experience`: the roles on the owner's profile, with their ids. */
export async function runExperience(quiet = false): Promise<Envelope> {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('experience', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const roles = liveRoles(session.session, quiet);
  const me = await roles.vanity();
  if (!me.ok) return err('experience', me.code, me.message, me.hint);
  const listed = await roles.list(me.vanity);
  if (!listed.ok) return err('experience', listed.code, listed.message, listed.hint);
  return ok('experience', {
    items: listed.positions.map((p) => ({ positionId: p.positionId, title: p.title })),
    meta: { state: 'complete', returnedCount: listed.positions.length },
  });
}
