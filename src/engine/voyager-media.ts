// ─── Media upload over Voyager ───────────────────────────────────────────────
//
// An image or video post is three requests, not one:
//
//   1. POST voyagerVideoDashMediaUploadMetadata?action=upload
//        { mediaUploadType, fileSize, filename }
//      → a ticket: the digitalmediaAsset urn, the url to PUT the bytes to, and
//        the headers that PUT must carry (`media-type-family`).
//   2. PUT <singleUploadUrl>  — the raw file.
//   3. POST contentcreation/normShares with media: [{ category, mediaUrn }].
//
// PROVENANCE: step 1 VERIFIED LIVE 2026-09-25 for both IMAGE_SHARING and
// VIDEO_SHARING (the ticket shape below is from those responses). The web
// client no longer uses this path — it uploads through SDUI
// (registerMediaUpload → the same /dms-uploads/ PUT → CreatePost), captured the
// same day — but the Voyager endpoints answer, and they are three small JSON
// bodies against SDUI's kilobytes of memory-namespace bindings.
//
// Steps 1-2 publish nothing. An asset uploaded and never referenced is an
// orphan in LinkedIn's media store, invisible to anyone — which is why a
// failure here can honestly say "nothing was posted".

import type { Client } from './client.ts';

export const MEDIA_UPLOAD_URL =
  'https://www.linkedin.com/voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload';

export type MediaKind = 'IMAGE' | 'VIDEO';

const TYPES: Record<string, { kind: MediaKind; contentType: string }> = {
  png: { kind: 'IMAGE', contentType: 'image/png' },
  jpg: { kind: 'IMAGE', contentType: 'image/jpeg' },
  jpeg: { kind: 'IMAGE', contentType: 'image/jpeg' },
  gif: { kind: 'IMAGE', contentType: 'image/gif' },
  webp: { kind: 'IMAGE', contentType: 'image/webp' },
  mp4: { kind: 'VIDEO', contentType: 'video/mp4' },
  mov: { kind: 'VIDEO', contentType: 'video/quicktime' },
};

/** The kind and content type a file uploads as, by extension — or null. */
export function mediaKindOf(filename: string): { kind: MediaKind; contentType: string } | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return ext === undefined ? null : (TYPES[ext] ?? null);
}

export function registerPayload(kind: MediaKind, fileSize: number, filename: string) {
  return {
    mediaUploadType: kind === 'IMAGE' ? 'IMAGE_SHARING' : 'VIDEO_SHARING',
    fileSize,
    filename,
  };
}

export type UploadTicket =
  | { ok: true; urn: string; uploadUrl: string; uploadHeaders: Record<string, string> }
  | { ok: false; code: string; message: string };

export function parseUploadTicket(json: unknown): UploadTicket {
  const v = (json as { data?: { value?: Record<string, unknown> } } | null)?.data?.value;
  if (v?.type !== undefined && v.type !== 'SINGLE') {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message:
        `LinkedIn asked for a ${String(v.type)} upload, which is only used for large files and ` +
        'has not been observed here. Nothing was uploaded or posted. Try a smaller file.',
    };
  }
  const urn = v?.urn;
  const uploadUrl = v?.singleUploadUrl;
  if (typeof urn !== 'string' || typeof uploadUrl !== 'string') {
    return {
      ok: false,
      code: 'SCHEMA_DRIFT',
      message: 'the upload ticket carried no asset urn or upload url; nothing was posted',
    };
  }
  const headers = v?.singleUploadHeaders;
  return {
    ok: true,
    urn,
    uploadUrl,
    uploadHeaders:
      headers !== null && typeof headers === 'object' ? (headers as Record<string, string>) : {},
  };
}

export interface MediaFile {
  bytes: Uint8Array;
  filename: string;
  kind: MediaKind;
  contentType: string;
}

export type UploadResult =
  | { ok: true; urn: string }
  | { ok: false; code: string; message: string; hint?: string };

/** Register an asset and PUT the file to it. Publishes nothing. */
export async function uploadMedia(file: MediaFile, client: Client): Promise<UploadResult> {
  const registered = await client.request({
    url: MEDIA_UPLOAD_URL,
    method: 'POST',
    body: registerPayload(file.kind, file.bytes.byteLength, file.filename),
    spendClass: 'write',
    operation: 'register-upload',
  });
  if (!registered.ok) {
    return {
      ok: false,
      code: registered.code,
      message: `${registered.message}; nothing was posted`,
    };
  }

  const ticket = parseUploadTicket(registered.json);
  if (!ticket.ok) return ticket;

  const put = await client.request({
    url: ticket.uploadUrl,
    method: 'PUT',
    bytes: file.bytes,
    headers: { 'content-type': file.contentType, ...ticket.uploadHeaders },
    spendClass: 'write',
    operation: 'upload',
  });
  if (!put.ok) {
    return {
      ok: false,
      code: put.code,
      message: `uploading ${file.filename} failed (${put.message}); nothing was posted`,
    };
  }
  return { ok: true, urn: ticket.urn };
}
