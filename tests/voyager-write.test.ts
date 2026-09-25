import { describe, expect, test } from 'bun:test';
import type { ConfirmedWrite } from '../src/commands/confirm.ts';
import {
  extractShareUrn,
  mediaDigest,
  SHARE_URL,
  share,
  sharePayload,
} from '../src/engine/voyager-write.ts';

/** The gate is what produces these; tests forge one to reach the transport. */
function confirmed<T>(payload: T): ConfirmedWrite<T> {
  return { action: 'post to your feed', payload, token: 'abcd' } as ConfirmedWrite<T>;
}

/** A stand-in for the real client, recording what it was asked to send. */
function client(result: unknown, ok = true) {
  const sent: { url: string; method?: string; body?: unknown }[] = [];
  return {
    sent,
    request: async (spec: { url: string; method?: string; body?: unknown }) => {
      sent.push(spec);
      return ok
        ? { ok: true as const, json: result, classification: {} as never }
        : { ok: false as const, code: 'BLOCKED', message: 'refused', hint: 'h' };
    },
  };
}

// Four independent OSS clients converge on this body; it is nonetheless
// unverified against live traffic, so the shape is pinned here to make any
// future drift a visible test change rather than a silent behaviour change.
describe('share payload', () => {
  test('carries the text in commentaryV2', () => {
    expect(sharePayload('hello', 'PUBLIC').commentaryV2.text).toBe('hello');
  });

  // Visibility is a BOOLEAN here, not the enum string the OAuth API takes.
  // Getting this backwards would post a private note to the whole internet.
  test('PUBLIC means visibleToConnectionsOnly false', () => {
    expect(sharePayload('x', 'PUBLIC').visibleToConnectionsOnly).toBe(false);
  });

  test('CONNECTIONS means visibleToConnectionsOnly true', () => {
    expect(sharePayload('x', 'CONNECTIONS').visibleToConnectionsOnly).toBe(true);
  });

  test('sends an empty attributes array rather than omitting it', () => {
    // All four reference implementations send it; an absent array is a
    // different request from an empty one and we have not tested the former.
    expect(sharePayload('x', 'PUBLIC').commentaryV2.attributes).toEqual([]);
  });

  test('declares the post published and originating from the feed', () => {
    const p = sharePayload('x', 'PUBLIC');
    expect(p.postState).toBe('PUBLISHED');
    expect(p.origin).toBe('FEED');
  });

  test('text is carried verbatim — newlines, emoji and accents survive', () => {
    const text = 'első sor\nmásodik 🎯 — Székely';
    expect(sharePayload(text, 'PUBLIC').commentaryV2.text).toBe(text);
  });
});

describe('urn extraction', () => {
  test('finds a share urn in the response', () => {
    expect(extractShareUrn({ urn: 'urn:li:share:7123' })).toBe('urn:li:share:7123');
  });

  test('finds an activity urn nested anywhere in the response', () => {
    expect(extractShareUrn({ data: { deep: { x: 'urn:li:activity:99' } } })).toBe(
      'urn:li:activity:99',
    );
  });

  // We have never seen this response, so "no urn" is a real possibility. It
  // must read as "posted, urn unknown" rather than as a failure or a lie.
  test('returns null rather than inventing one when absent', () => {
    expect(extractShareUrn({ ok: true })).toBeNull();
  });

  test('does not mistake an author urn for the created post', () => {
    expect(extractShareUrn({ author: 'urn:li:person:ABC' })).toBeNull();
  });
});

describe('share', () => {
  test('posts to the contentcreation endpoint', async () => {
    const c = client({ urn: 'urn:li:share:1' });
    await share(confirmed({ text: 'hi', visibility: 'PUBLIC' as const }), c as never);
    expect(c.sent[0]?.url).toBe(SHARE_URL);
    expect(c.sent[0]?.method).toBe('POST');
  });

  test('returns the urn of the created post', async () => {
    const c = client({ urn: 'urn:li:share:7123' });
    const r = await share(confirmed({ text: 'hi', visibility: 'PUBLIC' as const }), c as never);
    if (!r.ok) throw new Error('expected success');
    expect(r.id).toBe('urn:li:share:7123');
  });

  test('a post whose urn we cannot find still reports success, and says so', async () => {
    const c = client({ acknowledged: true });
    const r = await share(confirmed({ text: 'hi', visibility: 'PUBLIC' as const }), c as never);
    if (!r.ok) throw new Error('expected success');
    expect(r.note).toContain('my-posts');
  });

  test('a refused request is an error, not a silent success', async () => {
    const c = client(null, false);
    const r = await share(confirmed({ text: 'hi', visibility: 'PUBLIC' as const }), c as never);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('BLOCKED');
  });

  test('sends the payload the builder produced, not a reshaped copy', async () => {
    const c = client({});
    await share(confirmed({ text: 'exact', visibility: 'CONNECTIONS' as const }), c as never);
    expect(c.sent[0]?.body).toEqual(sharePayload('exact', 'CONNECTIONS'));
  });
});

describe('share with media', () => {
  const TICKET = {
    data: {
      value: {
        urn: 'urn:li:digitalmediaAsset:ABC',
        singleUploadUrl: 'https://www.linkedin.com/dms-uploads/sp/v2/ABC/0',
        singleUploadHeaders: { 'media-type-family': 'STILLIMAGE' },
        type: 'SINGLE',
      },
    },
  };
  const BYTES = new Uint8Array([1, 2, 3]);
  const MEDIA = {
    filename: 'a.png',
    kind: 'IMAGE' as const,
    contentType: 'image/png',
    size: 3,
    sha256: mediaDigest(BYTES),
  };

  function scripted(...replies: ({ ok: true; json: unknown } | { ok: false; code: string })[]) {
    const sent: { url: string; method?: string; body?: unknown; bytes?: Uint8Array }[] = [];
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

  test('the payload references the asset by urn, with its category', () => {
    expect(
      sharePayload('x', 'PUBLIC', [{ category: 'IMAGE', urn: 'urn:li:digitalmediaAsset:A' }]).media,
    ).toEqual([{ category: 'IMAGE', mediaUrn: 'urn:li:digitalmediaAsset:A', tapTargets: [] }]);
  });

  test('uploads first, then posts with the uploaded urn', async () => {
    const c = scripted(
      { ok: true, json: TICKET },
      { ok: true, json: null },
      { ok: true, json: { urn: 'urn:li:share:9' } },
    );
    const r = await share(
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: MEDIA }),
      c as never,
      BYTES,
    );
    expect(r).toEqual({ ok: true, id: 'urn:li:share:9' });
    expect(c.sent.map((s) => s.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(c.sent[2]?.url).toBe(SHARE_URL);
    const posted = c.sent[2]?.body as { media: unknown } | undefined;
    expect(posted?.media).toEqual([
      { category: 'IMAGE', mediaUrn: 'urn:li:digitalmediaAsset:ABC', tapTargets: [] },
    ]);
  });

  test('a failed upload posts nothing', async () => {
    const c = scripted({ ok: false, code: 'BLOCKED' });
    const r = await share(
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: MEDIA }),
      c as never,
      BYTES,
    );
    expect(r.ok).toBe(false);
    expect(c.sent.some((s) => s.url === SHARE_URL)).toBe(false);
  });

  // The human approved a file by its digest. If the bytes changed between the
  // prompt and the send, what would be published is not what was approved.
  test('bytes that do not match the approved digest are refused before any request', async () => {
    const c = scripted();
    const r = await share(
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: MEDIA }),
      c as never,
      new Uint8Array([9, 9, 9]),
    );
    expect(r.ok).toBe(false);
    expect(c.sent).toHaveLength(0);
  });
});
