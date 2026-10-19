import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMAGE_KINDS,
  type ImageKeys,
  imageSizeOf,
  parseRegister,
  picturesOf,
  registerBody,
  saveBody,
} from '../src/engine/sdui-profile-image.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const json = (name: string) => JSON.parse(fixture(name));

/** The keys and file pointers the browser chose, read off its own request. */
function keysOf(kind: 'photo' | 'banner'): ImageKeys {
  const reg = json(`profile-image-${kind}-register-request.json`);
  const p = reg.serverRequest.requestedArguments.payload;
  const states = reg.states as { key: string; value: { mediaFiles?: { filePointer: string }[] } }[];
  const pointer = (key: string) =>
    states.find((s) => s.key === key)?.value.mediaFiles?.[0]?.filePointer as string;
  return {
    originalMedia: p.originalMedia.key,
    originalAssetUrns: p.originalAssetUrns.key,
    displayMedia: p.displayMedia.key,
    displayAssetUrns: p.displayAssetUrns.key,
    saving: p.isSaving.key,
    originalPointer: pointer(p.originalMedia.key),
    displayPointer: pointer(p.displayMedia.key),
  };
}

/** The browser's request with what is the browser's own choice put back to ours. */
function asCaptured(kind: 'photo' | 'banner', which: 'register' | 'save') {
  const body = json(`profile-image-${kind}-${which}-request.json`);
  // The editor's own render: its file name, size and crop. We upload the file as given.
  const text = JSON.stringify(body)
    .replace(/edited-image-[0-9TZ-]+\.png/g, 'edited-image.png')
    .replace(/"editData":\{[\s\S]*?"imageFilter":"ImageFilter_None"\}/g, '"editData":EDIT');
  return JSON.parse(text.replace(/"editData":EDIT/g, `"editData":${JSON.stringify(EDIT)}`));
}

const EDIT = {
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

const FILES = {
  photo: { name: 'photo-green.png', mimeType: 'image/png', size: 1053, displaySize: 4792 },
  banner: { name: 'banner-green.png', mimeType: 'image/png', size: 2504, displaySize: 13807 },
};

describe('the register request', () => {
  for (const kind of ['photo', 'banner'] as const) {
    test(`${kind}: what the browser sends, with our file as both the original and the display`, () => {
      const f = FILES[kind];
      const want = asCaptured(kind, 'register');
      // The browser uploads its own render as the display image; we upload the file itself.
      const display = want.states.find(
        (s: { key: string }) =>
          s.key === want.serverRequest.requestedArguments.payload.displayMedia.key,
      );
      display.value.mediaFiles[0].size = String(f.size);
      display.value.mediaFiles[0].source.localFile.size = String(f.size);
      want.requestedArguments.states = want.states;
      const body = registerBody(IMAGE_KINDS[kind], {
        profileId: 'ACoAATESTPERSON1',
        vanity: 'person-1',
        file: { name: f.name, mimeType: f.mimeType, size: f.size },
        keys: keysOf(kind),
        displayName: 'edited-image.png',
      });
      expect(body).toEqual(want);
    });
  }
});

describe('the register answer', () => {
  test('the two asset ids, and where each file goes', () => {
    const keys = keysOf('photo');
    const r = parseRegister(fixture('profile-image-photo-register-response.rsc'), keys);
    if (!r.ok) throw new Error(r.message);
    expect(r.originalId).toBe('D4DORIGINALPHOTO');
    expect(r.displayId).toBe('D4DDISPLAYPHOTO');
    expect(r.uploads.original.url).toContain('/D4DORIGINALPHOTO/profile-original-uploadedImage/');
    expect(r.uploads.display.url).toContain('/D4DDISPLAYPHOTO/profile-uploadedImage/');
    expect(r.uploads.display.headers).toEqual({ 'media-type-family': 'STILLIMAGE' });
  });

  test('the banner answer the same way', () => {
    const r = parseRegister(
      fixture('profile-image-banner-register-response.rsc'),
      keysOf('banner'),
    );
    if (!r.ok) throw new Error(r.message);
    expect([r.originalId, r.displayId]).toEqual(['D4DORIGINALBANNER', 'D4DDISPLAYBANNER']);
    expect(r.uploads.original.url).toContain('profile-original-uploadedBackgroundImage');
  });

  test('an answer without upload instructions is drift; nothing was uploaded', () => {
    expect(parseRegister('0:{"states":[]}', keysOf('photo'))).toMatchObject({
      ok: false,
      code: 'SCHEMA_DRIFT',
    });
  });

  test('a refusal is passed on', () => {
    const refused = '0:{"response":{"errors":[{"message":"Image too small"}]}}';
    expect(parseRegister(refused, keysOf('photo'))).toMatchObject({ ok: false });
  });
});

describe('the save request', () => {
  for (const kind of ['photo', 'banner'] as const) {
    test(`${kind}: what the browser sends`, () => {
      const f = FILES[kind];
      const want = asCaptured(kind, 'save');
      for (const s of want.states) {
        if (s.value?.mediaFiles !== undefined) {
          s.value.mediaFiles[0].size = String(f.size);
          s.value.mediaFiles[0].source.localFile.size = String(f.size);
        }
      }
      want.requestedArguments.states = want.states;
      const ids =
        kind === 'photo'
          ? { originalId: 'D4DORIGINALPHOTO', displayId: 'D4DDISPLAYPHOTO' }
          : { originalId: 'D4DORIGINALBANNER', displayId: 'D4DDISPLAYBANNER' };
      const body = saveBody(IMAGE_KINDS[kind], {
        profileId: 'ACoAATESTPERSON1',
        vanity: 'person-1',
        file: { name: f.name, mimeType: f.mimeType, size: f.size },
        keys: keysOf(kind),
        displayName: 'edited-image.png',
        ...ids,
      });
      expect(body).toEqual(want);
    });
  }
});

describe('imageSizeOf', () => {
  test('PNG and JPEG dimensions from the header; anything else is unknown', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 1584);
    new DataView(png.buffer).setUint32(20, 396);
    expect(imageSizeOf(png)).toEqual({ width: 1584, height: 396, mimeType: 'image/png' });

    // SOI, an APP0 segment, then SOF0 with height 400 and width 300.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90,
      0x01, 0x2c,
    ]);
    expect(imageSizeOf(jpeg)).toEqual({ width: 300, height: 400, mimeType: 'image/jpeg' });

    expect(imageSizeOf(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('picturesOf', () => {
  test('the profile id and each picture asset, from the full profile', () => {
    const json = {
      data: { '*elements': ['urn:li:fsd_profile:ACoAATESTPERSON1'] },
      included: [
        {
          entityUrn: 'urn:li:fsd_profile:ACoAATESTPERSON1',
          profilePicture: {
            displayImageUrn: 'urn:li:digitalmediaAsset:D4DDISPLAYPHOTO',
            originalImageUrn: 'urn:li:digitalmediaAsset:D4DORIGINALPHOTO',
          },
          backgroundPicture: null,
        },
      ],
    };
    expect(picturesOf(json)).toEqual({
      ok: true,
      profileId: 'ACoAATESTPERSON1',
      photo: 'D4DDISPLAYPHOTO',
    });
    expect(picturesOf({ data: {} })).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
