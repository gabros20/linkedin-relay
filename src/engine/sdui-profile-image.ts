// ─── The profile photo and the cover image ────────────────────────────────────
//
// Captured 2026-10-19 by changing each in the browser. Both are three steps,
// over the same SDUI register request:
//
//   1. server-request profileImageRegister: the file described (name, type,
//      size) as an ORIGINAL and a DISPLAY image, each with an empty
//      asset-urn state. The answer sets those states to two digitalmedia
//      asset ids and carries an upload instruction for each: a /dms-uploads/
//      URL and its headers (`mediaTypeFamily: STILLIMAGE`).
//   2. PUT each file to its URL.
//   3. server-request saveProfilePicture / saveProfileBackgroundImage, naming
//      the display image and both asset ids. This is the step that changes
//      the profile; 1 and 2 leave orphan assets nobody sees.
//
// The browser uploads its editor's render (cropped, scaled) as the display
// image and the picked file as the original. Here the file is both, with the
// crop set to the whole image, so the file must already be the right shape:
// square for the photo, 4:1 for the cover (LinkedIn's 1584 × 396).
//
// The keys (`auto-binding-…`) and file pointers are the client's own choice;
// LinkedIn echoes them back, which is how the answer is read.

import { randomUUID } from 'node:crypto';
import { type Failure, responseErrors } from './sdui-form.ts';

export interface ImageKind {
  name: 'photo' | 'banner';
  /** What the owner calls it. */
  label: string;
  screen: string;
  originalType: string;
  displayType: string;
  save: string;
  /** Width over height the file must have, ±2%. */
  aspect: number;
}

export const IMAGE_KINDS = {
  photo: {
    name: 'photo',
    label: 'profile photo',
    screen: 'com.linkedin.sdui.flagshipnav.profile.ProfileAddPicture',
    originalType: 'ProfileOriginalPhoto',
    displayType: 'ProfileDisplayPhoto',
    save: 'com.linkedin.sdui.requests.profile.saveProfilePicture',
    aspect: 1,
  },
  banner: {
    name: 'banner',
    label: 'cover image',
    screen: 'com.linkedin.sdui.flagshipnav.profile.ProfileAddBackgroundImage',
    originalType: 'ProfileOriginalBackground',
    displayType: 'ProfileDisplayBackground',
    save: 'com.linkedin.sdui.requests.profile.saveProfileBackgroundImage',
    aspect: 4,
  },
} as const satisfies Record<string, ImageKind>;

const REGISTER = 'com.linkedin.sdui.requests.profile.profileImageRegister';
export const REGISTER_REQUEST = REGISTER;
const NS = 'MemoryNamespace';
/** The photo editor's saving flag has a fixed name; the cover's is generated. */
const PHOTO_SAVING = 'ADD_PHOTOPROFILE_PHOTO_UPLOAD_IS_SAVING';

export interface ImageKeys {
  originalMedia: string;
  originalAssetUrns: string;
  displayMedia: string;
  displayAssetUrns: string;
  saving: string;
  originalPointer: string;
  displayPointer: string;
}

const binding = () => `auto-binding-${randomUUID()}`;
const pointer = () => Math.random().toString(36).slice(2, 13).padEnd(11, '0');

export function newKeys(kind: ImageKind): ImageKeys {
  return {
    originalMedia: binding(),
    originalAssetUrns: binding(),
    displayMedia: binding(),
    displayAssetUrns: binding(),
    saving: kind.name === 'photo' ? PHOTO_SAVING : binding(),
    originalPointer: pointer(),
    displayPointer: pointer(),
  };
}

export interface ImageFile {
  name: string;
  mimeType: string;
  size: number;
}

export interface ImageRequest {
  profileId: string;
  vanity: string;
  file: ImageFile;
  keys: ImageKeys;
  /** What the display copy is called; the browser names its render this way. */
  displayName?: string;
}

const focusKey = (vanity: string) =>
  `ProfileComponentStateLastPerformedActionRef${vanity}ProfileComponentState`;
const bind = (key: string) => ({ key, namespace: NS });
const stateKey = (id: string) => ({ key: { value: { $case: 'id', id } } });
const META = { $type: 'proto.sdui.common.RequestMetadata' } as const;

/** The whole image, unscaled and unfiltered: the file is already the shape it should be. */
const WHOLE_IMAGE = {
  $type: 'proto.sdui.media.MediaEditData',
  croppedRegion: {
    $type: 'proto.sdui.common.Rect',
    topLeft: { $type: 'proto.sdui.common.Coordinate2D', x: 0, y: 0 },
    topRight: { $type: 'proto.sdui.common.Coordinate2D', x: 1, y: 0 },
    bottomLeft: { $type: 'proto.sdui.common.Coordinate2D', x: 0, y: 1 },
    bottomRight: { $type: 'proto.sdui.common.Coordinate2D', x: 1, y: 1 },
  },
  scaleRatio: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vignette: 0,
  imageFilter: 'ImageFilter_None',
};

function mediaList(file: ImageFile, name: string, ptr: string, edited: boolean) {
  const size = String(file.size);
  return {
    $type: 'proto.sdui.media.MediaList',
    mediaFiles: [
      {
        mediaAttributions: [],
        analysisData: {},
        fileName: name,
        source: {
          $case: 'localFile',
          localFile: {
            fileName: name,
            mimeType: file.mimeType,
            filePointer: ptr,
            size,
            shouldIncludeFileContents: false,
          },
        },
        size,
        mimeType: file.mimeType,
        filePointer: ptr,
        mediaFileId: ptr,
        ...(edited ? { editData: WHOLE_IMAGE } : {}),
        captions: [],
        thumbnails: [],
      },
    ],
  };
}

type Value = Record<string, unknown> | string[] | string | boolean;
const CASES: Record<string, string> = {
  object: 'mediaListValue',
  array: 'stringListValue',
  string: 'stringValue',
  boolean: 'booleanValue',
};

function state(key: string, value: Value) {
  const kind = Array.isArray(value) ? 'array' : typeof value;
  return {
    key,
    namespace: NS,
    value,
    originalProtoCase: CASES[kind] as string,
    protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: key } },
  };
}

function serverRequest(
  requestId: string,
  payload: Record<string, unknown>,
  states: ReturnType<typeof state>[],
  screenId: string,
) {
  const requestedStateKeys = states.map((s) => stateKey(s.key));
  const requestedArguments = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys,
    payload,
    requestMetadata: META,
  };
  return {
    requestId,
    serverRequest: {
      requestId,
      requestedArguments,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states,
    requestedArguments: { ...requestedArguments, states, screenId, knownTemplateIds: [] },
  };
}

const displayNameOf = (req: ImageRequest) =>
  req.displayName ??
  `edited-image-${new Date().toISOString().replace(/[:.]/g, '-')}.${req.file.name.split('.').pop()}`;

/** The save's payload, and which states it reads, in the browser's order. */
function savePlan(kind: ImageKind, req: ImageRequest) {
  const k = req.keys;
  const focus = focusKey(req.vanity);
  if (kind.name === 'photo') {
    return {
      payload: {
        profileId: req.profileId,
        vanityName: req.vanity,
        newMedia: bind(k.displayMedia),
        originalAssetUrns: bind(k.originalAssetUrns),
        displayAssetUrns: bind(k.displayAssetUrns),
        isSavingProfilePhoto: bind(k.saving),
        focusableComponentRefKey: bind(focus),
      },
      keys: [k.displayMedia, k.originalAssetUrns, k.displayAssetUrns, k.saving, focus],
      focusValue: 'topcard-logo-image-referencekey',
    };
  }
  return {
    payload: {
      vanityName: req.vanity,
      profileId: req.profileId,
      editedMedia: bind(k.displayMedia),
      displayAssetUrns: bind(k.displayAssetUrns),
      originalAssetUrns: bind(k.originalAssetUrns),
      focusableComponentRefKey: bind(focus),
      isSaving: bind(k.saving),
      omitDefaultPhotoFilterEditInfo: true,
    },
    keys: [k.displayMedia, k.displayAssetUrns, k.originalAssetUrns, focus],
    focusValue: `${req.vanity}_cover_edit_button`,
  };
}

/** Step 1: describe the file and ask where to upload it. Changes nothing visible. */
export function registerBody(kind: ImageKind, req: ImageRequest) {
  const k = req.keys;
  const save = savePlan(kind, req);
  const payload = {
    profileId: req.profileId,
    originalMedia: bind(k.originalMedia),
    originalAssetUrns: bind(k.originalAssetUrns),
    originalMediaType: kind.originalType,
    displayMedia: bind(k.displayMedia),
    displayMediaType: kind.displayType,
    displayAssetUrns: bind(k.displayAssetUrns),
    uploadOriginal: true,
    followUpRequest: { key: kind.save, data: save.payload, stateKeys: save.keys.map(bind) },
    skipEdit: false,
    isSaving: bind(k.saving),
  };
  return serverRequest(
    REGISTER,
    payload,
    [
      state(k.originalMedia, mediaList(req.file, req.file.name, k.originalPointer, false)),
      state(k.originalAssetUrns, []),
      state(k.displayMedia, mediaList(req.file, displayNameOf(req), k.displayPointer, true)),
      state(k.displayAssetUrns, []),
      state(k.saving, true),
    ],
    kind.screen,
  );
}

/** Step 3: put the uploaded image on the profile. */
export function saveBody(
  kind: ImageKind,
  req: ImageRequest & { originalId: string; displayId: string },
) {
  const k = req.keys;
  const save = savePlan(kind, req);
  const values: Record<string, Value> = {
    [k.displayMedia]: mediaList(req.file, displayNameOf(req), k.displayPointer, true),
    [k.originalAssetUrns]: [req.originalId],
    [k.displayAssetUrns]: [req.displayId],
    [k.saving]: true,
    [focusKey(req.vanity)]: save.focusValue,
  };
  return serverRequest(
    kind.save,
    save.payload,
    save.keys.map((key) => state(key, values[key] as Value)),
    kind.screen,
  );
}

// ─── The register answer ──────────────────────────────────────────────────────

export interface Upload {
  url: string;
  headers: Record<string, string>;
}

export type Registered =
  | {
      ok: true;
      originalId: string;
      displayId: string;
      uploads: { original: Upload; display: Upload };
    }
  | Failure;

type Node = Record<string, unknown>;

function* walk(v: unknown): Generator<Node> {
  if (Array.isArray(v)) for (const x of v) yield* walk(x);
  else if (v !== null && typeof v === 'object') {
    yield v as Node;
    for (const x of Object.values(v)) yield* walk(x);
  }
}

/** `mediaTypeFamily` as the HTTP header the upload takes, `media-type-family`. */
const headerName = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The asset id a SetState puts in each key, keyed by that key. */
function assetIdOf(n: Node): [string, string] | undefined {
  if (n.$type !== 'proto.sdui.actions.core.SetState') return undefined;
  const s = (n.value as Node | undefined)?.state as Node | undefined;
  const id = ((s?.key as Node | undefined)?.key as Node | undefined)?.value as Node | undefined;
  const list = ((s?.value as Node | undefined)?.stringListValue as Node | undefined)
    ?.stringValues as unknown[] | undefined;
  return typeof id?.id === 'string' && typeof list?.[0] === 'string' ? [id.id, list[0]] : undefined;
}

/** An upload instruction's file pointer, and its URL and headers ('multipart' if not one PUT). */
function uploadOf(n: Node): [string, Upload | 'multipart'] | undefined {
  if (typeof n.fileReference !== 'string') return undefined;
  const instruction = (n.uploadInstruction as Node | undefined)?.instruction as Node | undefined;
  const single = instruction?.singleRequestUploadInstruction as Node | undefined;
  if (typeof single?.uploadUrl !== 'string') return [n.fileReference, 'multipart'];
  const headers: Record<string, string> = {};
  for (const h of (single.uploadHeaders as Node[] | undefined) ?? [])
    if (typeof h.key === 'string' && typeof h.value === 'string')
      headers[headerName(h.key)] = h.value;
  return [n.fileReference, { url: single.uploadUrl, headers }];
}

function rowZero(raw: string): unknown {
  const row = raw.match(/(?:^|\n)0:(\{.*)/)?.[1];
  try {
    return row === undefined ? undefined : JSON.parse(row);
  } catch {
    return undefined;
  }
}

export function parseRegister(raw: string, keys: ImageKeys): Registered {
  const refused = responseErrors(raw);
  if (refused !== null)
    return { ok: false, code: 'INVALID_INPUT', message: `LinkedIn refused the image: ${refused}` };
  const ids = new Map<string, string>();
  const uploads = new Map<string, Upload | 'multipart'>();
  for (const n of walk(rowZero(raw))) {
    const id = assetIdOf(n);
    if (id !== undefined) ids.set(...id);
    const up = uploadOf(n);
    if (up !== undefined) uploads.set(...up);
  }
  const originalId = ids.get(keys.originalAssetUrns);
  const displayId = ids.get(keys.displayAssetUrns);
  const original = uploads.get(keys.originalPointer);
  const display = uploads.get(keys.displayPointer);
  if (original === 'multipart' || display === 'multipart')
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message:
        'LinkedIn asked for a multi-part upload, which has not been observed here. Nothing was ' +
        'uploaded. Try a smaller file.',
    };
  if (originalId === undefined || displayId === undefined || !original || !display)
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the image registration carried no asset ids or upload urls; nothing was uploaded',
    };
  return { ok: true, originalId, displayId, uploads: { original, display } };
}

// ─── The file ─────────────────────────────────────────────────────────────────

/** A PNG's or JPEG's dimensions from its header, or null for anything else. */
export function imageSizeOf(
  bytes: Uint8Array,
): { width: number; height: number; mimeType: string } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && png.every((b, i) => bytes[i] === b))
    return { width: view.getUint32(16), height: view.getUint32(20), mimeType: 'image/png' };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
        mimeType: 'image/jpeg',
      };
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

// ─── Reading it back ──────────────────────────────────────────────────────────

/**
 * The owner's profile id and the asset id of each picture showing now, from
 * the full profile (engine/full-profile.ts). A picture not set is left out.
 */
export function picturesOf(
  json: unknown,
): { ok: true; profileId: string; photo?: string; banner?: string } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const urn = (root?.data?.['*elements'] as unknown[] | undefined)?.[0];
  const p = (root?.included ?? []).find((n) => n.entityUrn === urn);
  const profileId = typeof urn === 'string' ? urn.split(':').pop() : undefined;
  if (p === undefined || profileId === undefined)
    return { ok: false, code: 'SCHEMA_DRIFT', message: 'the profile answer carried no profile' };
  const asset = (pic: unknown) =>
    String((pic as Node | null)?.displayImageUrn ?? '').match(/digitalmediaAsset:(.+)$/)?.[1];
  const photo = asset(p.profilePicture);
  const banner = asset(p.backgroundPicture);
  return {
    ok: true,
    profileId,
    ...(photo !== undefined ? { photo } : {}),
    ...(banner !== undefined ? { banner } : {}),
  };
}
