import { describe, expect, test } from 'bun:test';
import {
  MEDIA_UPLOAD_URL,
  mediaKindOf,
  parseUploadTicket,
  registerPayload,
  uploadMedia,
} from '../src/engine/voyager-media.ts';

// Captured live 2026-09-25 from POST voyagerVideoDashMediaUploadMetadata?action=upload
// with IMAGE_SHARING. The signed query params (`ut`, `t`) are redacted.
const IMAGE_TICKET = {
  data: {
    value: {
      urn: 'urn:li:digitalmediaAsset:D4D22AQFifLZ1GgyPdg',
      mediaArtifactUrn:
        'urn:li:digitalmediaMediaArtifact:(urn:li:digitalmediaAsset:D4D22AQFifLZ1GgyPdg,urn:li:digitalmediaMediaArtifactClass:uploaded-image)',
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
      singleUploadHeaders: { 'media-type-family': 'STILLIMAGE' },
      pollingUrl: 'https://www.linkedin.com/dms/processStatus/D4D22AQFifLZ1GgyPdg?t=REDACTED',
      singleUploadUrl:
        'https://www.linkedin.com/dms-uploads/sp/sync/v2/D4D22AQFifLZ1GgyPdg/uploaded-image/B4D/0?ut=REDACTED',
      type: 'SINGLE',
      $type: 'com.linkedin.mediauploader.MediaUploadMetadata',
    },
    $type: 'com.linkedin.restli.common.ActionResponse',
  },
  included: [],
};

describe('media kind', () => {
  test('still images are IMAGE', () => {
    for (const f of ['a.png', 'a.jpg', 'a.JPEG', 'a.gif', 'a.webp']) {
      expect(mediaKindOf(f)?.kind).toBe('IMAGE');
    }
  });

  test('mp4 and mov are VIDEO', () => {
    expect(mediaKindOf('clip.mp4')?.kind).toBe('VIDEO');
    expect(mediaKindOf('clip.MOV')?.kind).toBe('VIDEO');
  });

  test('carries the content type the upload must declare', () => {
    expect(mediaKindOf('a.jpg')?.contentType).toBe('image/jpeg');
    expect(mediaKindOf('a.mp4')?.contentType).toBe('video/mp4');
  });

  // Guessing a kind for an unknown file would register it under the wrong
  // recipe; the failure would surface only after upload, as a broken post.
  test('anything else is refused rather than guessed', () => {
    expect(mediaKindOf('notes.txt')).toBeNull();
    expect(mediaKindOf('noextension')).toBeNull();
  });
});

describe('register payload', () => {
  test('an image registers for IMAGE_SHARING with its size and name', () => {
    expect(registerPayload('IMAGE', 193662, 'oversight.png')).toEqual({
      mediaUploadType: 'IMAGE_SHARING',
      fileSize: 193662,
      filename: 'oversight.png',
    });
  });

  test('a video registers for VIDEO_SHARING', () => {
    expect(registerPayload('VIDEO', 10, 'x.mp4').mediaUploadType).toBe('VIDEO_SHARING');
  });
});

describe('upload ticket', () => {
  test('reads the asset urn, the url to PUT to, and the headers it demands', () => {
    const t = parseUploadTicket(IMAGE_TICKET);
    if (!t.ok) throw new Error(t.message);
    expect(t.urn).toBe('urn:li:digitalmediaAsset:D4D22AQFifLZ1GgyPdg');
    expect(t.uploadUrl).toContain('/dms-uploads/');
    expect(t.uploadHeaders).toEqual({ 'media-type-family': 'STILLIMAGE' });
  });

  // Large files come back MULTIPART: several part urls and a completion call
  // we have never observed. Uploading only the first part would "succeed".
  test('a multipart ticket is refused, not half-uploaded', () => {
    const multi = structuredClone(IMAGE_TICKET) as { data: { value: Record<string, unknown> } };
    multi.data.value.type = 'MULTIPART';
    const t = parseUploadTicket(multi);
    expect(t.ok).toBe(false);
    if (t.ok) throw new Error('unreachable');
    expect(t.code).toBe('NOT_IMPLEMENTED');
  });

  test('a ticket missing its upload url is schema drift', () => {
    const broken = structuredClone(IMAGE_TICKET) as { data: { value: Record<string, unknown> } };
    delete broken.data.value.singleUploadUrl;
    const t = parseUploadTicket(broken);
    expect(t.ok).toBe(false);
    if (t.ok) throw new Error('unreachable');
    expect(t.code).toBe('SCHEMA_DRIFT');
  });
});

/** Replies to each request in order; records what was asked. */
function scripted(...replies: ({ ok: true; json: unknown } | { ok: false; code: string })[]) {
  const sent: {
    url: string;
    method?: string;
    body?: unknown;
    bytes?: Uint8Array;
    headers?: Record<string, string>;
  }[] = [];
  return {
    sent,
    request: async (spec: (typeof sent)[number]) => {
      sent.push(spec);
      const r = replies.shift();
      if (r === undefined) throw new Error('unexpected request');
      return r.ok
        ? { ok: true as const, json: r.json, classification: {} as never }
        : { ok: false as const, code: r.code, message: 'refused' };
    },
  };
}

const FILE = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  filename: 'oversight.png',
  kind: 'IMAGE' as const,
  contentType: 'image/png',
};

describe('upload', () => {
  test('registers, then PUTs the bytes to the url the ticket named', async () => {
    const c = scripted({ ok: true, json: IMAGE_TICKET }, { ok: true, json: null });
    const r = await uploadMedia(FILE, c as never);
    expect(r).toEqual({ ok: true, urn: 'urn:li:digitalmediaAsset:D4D22AQFifLZ1GgyPdg' });

    expect(c.sent[0]?.url).toBe(MEDIA_UPLOAD_URL);
    expect(c.sent[0]?.body).toEqual(registerPayload('IMAGE', 4, 'oversight.png'));

    expect(c.sent[1]?.method).toBe('PUT');
    expect(c.sent[1]?.url).toBe(IMAGE_TICKET.data.value.singleUploadUrl);
    expect(c.sent[1]?.bytes).toBe(FILE.bytes);
    expect(c.sent[1]?.headers).toEqual({
      'content-type': 'image/png',
      'media-type-family': 'STILLIMAGE',
    });
  });

  test('a refused registration uploads nothing', async () => {
    const c = scripted({ ok: false, code: 'BLOCKED' });
    const r = await uploadMedia(FILE, c as never);
    expect(r.ok).toBe(false);
    expect(c.sent).toHaveLength(1);
  });

  test('a failed PUT is an error, and says nothing was posted', async () => {
    const c = scripted({ ok: true, json: IMAGE_TICKET }, { ok: false, code: 'FETCH_FAILED' });
    const r = await uploadMedia(FILE, c as never);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('nothing was posted');
  });
});
