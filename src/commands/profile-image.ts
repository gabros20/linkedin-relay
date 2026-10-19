// ─── `lnrelay edit photo|banner <file>` ───────────────────────────────────────
//
// Replace the owner's profile photo or cover image with a file, as the
// browser does (engine/sdui-profile-image.ts): register, upload, save. The
// file is checked before anything is sent, the owner approves it by its
// digest, and the profile is read back afterwards: the new image must be the
// one showing, or the command fails.

import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Session } from '../engine/auth.ts';
import { fullProfileUrl } from '../engine/full-profile.ts';
import { createEngine, createLiveClient } from '../engine/index.ts';
import type { Failure } from '../engine/sdui-form.ts';
import { sendAction } from '../engine/sdui-profile.ts';
import {
  IMAGE_KINDS,
  type ImageKeys,
  type ImageKind,
  type ImageRequest,
  imageSizeOf,
  newKeys,
  parseRegister,
  picturesOf,
  REGISTER_REQUEST,
  registerBody,
  saveBody,
  type Upload,
} from '../engine/sdui-profile-image.ts';
import { mediaDigest } from '../engine/voyager-write.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { refuseUnapprovable, terminalDeps } from './gate.ts';
import { authorLine, gate, prepare } from './write.ts';

/** What an image change needs from LinkedIn. Injectable so tests send nothing. */
export interface ImageSurface {
  vanity(): Promise<{ ok: true; vanity: string } | Failure>;
  pictures(
    vanity: string,
  ): Promise<{ ok: true; profileId: string; photo?: string; banner?: string } | Failure>;
  register(body: unknown): Promise<{ ok: true; raw: string } | Failure>;
  put(upload: Upload, bytes: Uint8Array, mimeType: string): Promise<{ ok: true } | Failure>;
  save(kind: ImageKind, body: unknown): Promise<{ ok: true } | Failure>;
}

function liveImages(session: Session): ImageSurface {
  const client = createLiveClient(session);
  return {
    vanity: async () => {
      const me = await createEngine(session).whoami();
      if (!me.ok) return me;
      const id = me.value?.publicIdentifier;
      return typeof id === 'string' && id !== ''
        ? { ok: true, vanity: id }
        : { ok: false, code: 'SCHEMA_DRIFT', message: 'whoami returned no public profile id' };
    },
    pictures: async (vanity) => {
      const r = await client.request({
        url: fullProfileUrl(vanity),
        spendClass: 'profile',
        operation: 'profile-pictures',
      });
      return r.ok ? picturesOf(r.json) : r;
    },
    register: async (body) => {
      const raw = await sendAction(REGISTER_REQUEST, body, client, 'image-register');
      return typeof raw === 'string' ? { ok: true, raw } : raw;
    },
    put: async (upload, bytes, mimeType) => {
      const r = await client.request({
        url: upload.url,
        method: 'PUT',
        bytes,
        headers: { 'content-type': mimeType, ...upload.headers },
        spendClass: 'write',
        operation: 'image-upload',
      });
      return r.ok ? { ok: true } : r;
    },
    save: async (kind, body) => {
      const raw = await sendAction(kind.save, body, client, `${kind.name}-save`);
      return typeof raw === 'string' ? { ok: true } : raw;
    },
  };
}

/** LinkedIn's own limit on either image. */
const MAX_BYTES = 8 * 1024 * 1024;

type Picked = { bytes: Uint8Array; width: number; height: number; mimeType: string };

/** Read the file and check it is a PNG or JPEG of the shape `kind` takes. */
function pick(kind: ImageKind, path: string): Picked | Envelope {
  let bytes: Uint8Array;
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return err('edit', 'INVALID_INPUT', `cannot read ${path}`);
  }
  if (bytes.byteLength > MAX_BYTES)
    return err('edit', 'INVALID_INPUT', `${basename(path)} is over LinkedIn's 8 MB limit`);
  const size = imageSizeOf(bytes);
  if (size === null)
    return err('edit', 'INVALID_INPUT', `${basename(path)} is not a PNG or JPEG image`);
  const ratio = size.width / size.height;
  if (Math.abs(ratio / kind.aspect - 1) > 0.02) {
    const want = kind.name === 'photo' ? 'square' : '4:1 (1584 × 396)';
    return err(
      'edit',
      'INVALID_INPUT',
      `${basename(path)} is ${size.width} × ${size.height}; a ${kind.label} must be ${want}`,
      'It is uploaded as it is, uncropped: crop it to that shape first.',
    );
  }
  return { bytes, ...size };
}

type Approved = { image: string; file: string; sha256: string; was: string | null };

function planOf(
  kind: ImageKind,
  file: string,
  picked: Picked,
  was: string | undefined,
  author: string,
): WritePlan<Approved> {
  const sha256 = mediaDigest(picked.bytes);
  return {
    action: `replace your ${kind.label}`,
    payload: { image: kind.name, file, sha256, was: was ?? null },
    summary: [
      author,
      `image    ${kind.label}`,
      `file     ${file}`,
      `         ${picked.width} × ${picked.height}, ${picked.bytes.byteLength} bytes, sha256 ${sha256.slice(0, 16)}…`,
      `now      ${was === undefined ? 'none' : `asset ${was}`}`,
    ],
    reversibility:
      'replaceable again with any file, but the current image is not kept here: have the ' +
      'original file before replacing it. Everyone who can see your profile sees the change.',
    transport: 'voyager',
  };
}

/** Register, upload both copies, save. The display asset id, or why not. */
async function send(
  li: ImageSurface,
  kind: ImageKind,
  req: Omit<ImageRequest, 'displayName'> & { displayName: string },
  picked: Picked,
): Promise<{ ok: true; displayId: string } | Envelope> {
  const nothing = (f: Failure, step: string) =>
    err('edit', f.code, `${step} failed (${f.message}); nothing changed on your profile`, f.hint);
  const registered = await li.register(registerBody(kind, req));
  if (!registered.ok) return nothing(registered, 'registering the image');
  const ticket = parseRegister(registered.raw, req.keys);
  if (!ticket.ok) return nothing(ticket, 'registering the image');
  for (const upload of [ticket.uploads.original, ticket.uploads.display]) {
    const put = await li.put(upload, picked.bytes, picked.mimeType);
    if (!put.ok) return nothing(put, 'uploading the image');
  }
  const saved = await li.save(kind, saveBody(kind, { ...req, ...ticket }));
  if (!saved.ok)
    return err('edit', saved.code, `saving the ${kind.label} failed: ${saved.message}`);
  return { ok: true, displayId: ticket.displayId };
}

export async function runEditImage(
  name: string,
  path: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  surface?: ImageSurface,
  keys?: ImageKeys,
): Promise<Envelope> {
  const kind = (IMAGE_KINDS as Record<string, ImageKind>)[name];
  if (kind === undefined)
    return err('edit', 'INVALID_INPUT', `'${name}' is not an image this edits`, 'photo, banner');
  if (path === undefined || path.trim() === '')
    return err('edit', 'INVALID_INPUT', 'an image file is required', `lnrelay edit ${name} <file>`);
  const file = resolve(path);
  const picked = pick(kind, file);
  if ('ok' in picked) return picked;

  const unapprovable = refuseUnapprovable('edit', 'editing', deps);
  if (unapprovable !== null) return unapprovable;
  // register, two uploads, save
  const ctx = prepare('edit', now, 'voyager', 4);
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager')
    return err('edit', 'NOT_IMPLEMENTED', 'profile edits go over the browser session only');
  const li = surface ?? liveImages(ctx.transport.session);

  const me = await li.vanity();
  if (!me.ok) return err('edit', me.code, me.message, me.hint);
  const before = await li.pictures(me.vanity);
  if (!before.ok) return err('edit', before.code, before.message, before.hint);

  const plan = planOf(kind, file, picked, before[kind.name], authorLine(ctx.transport));
  const gated = await gate('edit', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const ext = picked.mimeType === 'image/png' ? 'png' : 'jpg';
  const sent = await send(
    li,
    kind,
    {
      profileId: before.profileId,
      vanity: me.vanity,
      file: { name: basename(file), mimeType: picked.mimeType, size: picked.bytes.byteLength },
      keys: keys ?? newKeys(kind),
      displayName: `edited-image-${new Date(now).toISOString().replace(/[:.]/g, '-')}.${ext}`,
    },
    picked,
  );
  if (!('displayId' in sent)) return sent;

  // Never an empty success: the new image must be the one showing.
  const after = await li.pictures(me.vanity);
  if (!after.ok || after[kind.name] !== sent.displayId) {
    return err(
      'edit',
      'SCHEMA_DRIFT',
      `LinkedIn accepted the save, but your ${kind.label} does not read back as the new image`,
      after.ok
        ? `It shows asset ${after[kind.name] ?? 'none'}; the upload was ${sent.displayId}.`
        : `The read-back failed: ${after.message}`,
    );
  }
  return ok('edit', { image: kind.name, verified: true, asset: sent.displayId });
}
