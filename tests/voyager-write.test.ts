import { describe, expect, test } from 'bun:test';
import type { ConfirmedWrite } from '../src/commands/confirm.ts';
import {
  editPost,
  editPostBody,
  extractShareUrn,
  mediaDigest,
  pollDuration,
  pollUrnOf,
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
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: [MEDIA] }),
      c as never,
      [BYTES],
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
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: [MEDIA] }),
      c as never,
      [BYTES],
    );
    expect(r.ok).toBe(false);
    expect(c.sent.some((s) => s.url === SHARE_URL)).toBe(false);
  });

  // The human approved a file by its digest. If the bytes changed between the
  // prompt and the send, what would be published is not what was approved.
  test('bytes that do not match the approved digest are refused before any request', async () => {
    const c = scripted();
    const r = await share(
      confirmed({ text: 'hi', visibility: 'PUBLIC' as const, media: [MEDIA] }),
      c as never,
      [new Uint8Array([9, 9, 9])],
    );
    expect(r.ok).toBe(false);
    expect(c.sent).toHaveLength(0);
  });
});

describe('share with several images', () => {
  const ticket = (id: string) => ({
    data: {
      value: {
        urn: `urn:li:digitalmediaAsset:${id}`,
        singleUploadUrl: `https://www.linkedin.com/dms-uploads/${id}`,
        singleUploadHeaders: { 'media-type-family': 'STILLIMAGE' },
        type: 'SINGLE',
      },
    },
  });
  const A = new Uint8Array([1]);
  const B = new Uint8Array([2]);
  const approved = (bytes: Uint8Array, name: string, alt?: string) => ({
    filename: name,
    kind: 'IMAGE' as const,
    contentType: 'image/png',
    size: 1,
    sha256: mediaDigest(bytes),
    ...(alt === undefined ? {} : { alt }),
  });

  function scripted(...replies: unknown[]) {
    const sent: { url: string; method?: string; body?: unknown }[] = [];
    return {
      sent,
      request: async (spec: (typeof sent)[number]) => {
        sent.push(spec);
        return { ok: true as const, json: replies.shift(), classification: {} as never };
      },
    };
  }

  test('uploads each in order and posts them in that order', async () => {
    const c = scripted(ticket('A'), null, ticket('B'), null, { urn: 'urn:li:share:5' });
    const r = await share(
      confirmed({
        text: 'hi',
        visibility: 'PUBLIC' as const,
        media: [approved(A, 'a.png'), approved(B, 'b.png')],
      }),
      c as never,
      [A, B],
    );
    expect(r.ok).toBe(true);
    expect(c.sent.map((s) => s.method)).toEqual(['POST', 'PUT', 'POST', 'PUT', 'POST']);
    const posted = c.sent[4]?.body as { media: { mediaUrn: string }[] } | undefined;
    expect(posted?.media.map((m) => m.mediaUrn)).toEqual([
      'urn:li:digitalmediaAsset:A',
      'urn:li:digitalmediaAsset:B',
    ]);
  });

  test('any file that changed since approval stops everything before a request', async () => {
    const c = scripted();
    const r = await share(
      confirmed({
        text: 'hi',
        visibility: 'PUBLIC' as const,
        media: [approved(A, 'a.png'), approved(B, 'b.png')],
      }),
      c as never,
      [A, new Uint8Array([7])],
    );
    expect(r.ok).toBe(false);
    expect(c.sent).toHaveLength(0);
  });

  test('alt text rides on its own media entry, and is omitted when not given', () => {
    const p = sharePayload('x', 'PUBLIC', [
      { category: 'IMAGE', urn: 'urn:li:digitalmediaAsset:A', alt: 'a radar icon' },
      { category: 'IMAGE', urn: 'urn:li:digitalmediaAsset:B' },
    ]);
    expect(p.media).toEqual([
      {
        category: 'IMAGE',
        mediaUrn: 'urn:li:digitalmediaAsset:A',
        tapTargets: [],
        altText: 'a radar icon',
      },
      { category: 'IMAGE', mediaUrn: 'urn:li:digitalmediaAsset:B', tapTargets: [] },
    ]);
  });
});

// Both verified live 2026-10-13 with scheduled probes, read back from LinkedIn's
// own scheduled-posts list: the time, the title and the page count all matched.
describe('documents and scheduling in the payload', () => {
  test('a document is NATIVE_DOCUMENT and carries its title', () => {
    const p = sharePayload('x', 'PUBLIC', [
      { category: 'DOCUMENT', urn: 'urn:li:digitalmediaAsset:D', title: 'Q3 review' },
    ]);
    expect(p.media).toEqual([
      {
        category: 'NATIVE_DOCUMENT',
        mediaUrn: 'urn:li:digitalmediaAsset:D',
        tapTargets: [],
        title: { text: 'Q3 review' },
      },
    ]);
  });

  test('a scheduled post is SCHEDULED with the time in epoch ms', () => {
    const p = sharePayload('x', 'PUBLIC', [], 1792497600000);
    expect(p.postState).toBe('SCHEDULED');
    expect(p.scheduledAt).toBe(1792497600000);
  });

  // The default must stay the body verified on 2026-08-13: no stray field.
  test('without a time it is PUBLISHED and has no scheduledAt at all', () => {
    const p = sharePayload('x', 'PUBLIC');
    expect(p.postState).toBe('PUBLISHED');
    expect('scheduledAt' in p).toBe(false);
  });
});

describe('share carries what was approved into the body', () => {
  test('the approved time schedules the post', async () => {
    const c = client({ data: { status: { urn: 'urn:li:share:9' } } });
    await share(
      confirmed({ text: 'later', visibility: 'PUBLIC' as const, scheduledAt: 1792497600000 }),
      c as never,
    );
    expect(c.sent[0]?.body).toEqual(sharePayload('later', 'PUBLIC', [], 1792497600000));
  });

  test("a document's approved title goes on its media entry", async () => {
    const BYTES = new Uint8Array([5]);
    const sent: { body?: unknown }[] = [];
    const replies: unknown[] = [
      {
        data: {
          value: {
            urn: 'urn:li:digitalmediaAsset:D',
            singleUploadUrl: 'https://x/u',
            type: 'SINGLE',
          },
        },
      },
      null,
      { data: { status: { urn: 'urn:li:ugcPost:3' } } },
    ];
    const c = {
      request: async (spec: { body?: unknown }) => {
        sent.push(spec);
        return { ok: true as const, json: replies.shift(), classification: {} as never };
      },
    };
    await share(
      confirmed({
        text: 'deck',
        visibility: 'PUBLIC' as const,
        media: [
          {
            filename: 'deck.pdf',
            kind: 'DOCUMENT' as const,
            contentType: 'application/pdf',
            size: 1,
            sha256: mediaDigest(BYTES),
            title: 'Q3 review',
          },
        ],
      }),
      c as never,
      [BYTES],
    );
    const posted = sent[2]?.body as { media: unknown[] } | undefined;
    expect(posted?.media[0]).toMatchObject({
      category: 'NATIVE_DOCUMENT',
      title: { text: 'Q3 review' },
    });
  });
});

// Verified live 2026-10-13: a Rest.li partial update on normShares/<urn>
// replaced the text and the response echoed it, media untouched.
describe('editing a post', () => {
  test('the body replaces only the text', () => {
    expect(editPostBody('new words')).toEqual({
      patch: { $set: { commentaryV2: { text: 'new words', attributes: [] } } },
    });
  });

  test('posts the patch to that post, urn encoded', async () => {
    const c = client({ data: { commentary: { text: 'new words' } } });
    const r = await editPost(confirmed({ urn: 'urn:li:share:7', text: 'new words' }), c as never);
    expect(r.ok).toBe(true);
    expect(c.sent[0]?.method).toBe('POST');
    expect(c.sent[0]?.url).toBe(`${SHARE_URL}/${encodeURIComponent('urn:li:share:7')}`);
    expect(c.sent[0]?.body).toEqual(editPostBody('new words'));
  });

  // The response carries the post as LinkedIn now holds it. If that is not the
  // text we sent, saying "edited" would be the reassuring lie.
  test('a response holding different text is not reported as success', async () => {
    const c = client({ data: { commentary: { text: 'something else' } } });
    const r = await editPost(confirmed({ urn: 'urn:li:share:7', text: 'new words' }), c as never);
    expect(r.ok).toBe(false);
  });

  test('a refused edit is an error', async () => {
    const c = client(null, false);
    const r = await editPost(confirmed({ urn: 'urn:li:share:7', text: 'x' }), c as never);
    expect(r.ok).toBe(false);
  });
});

// Verified live 2026-10-13: the mutation returned a pollSummary urn, and a
// scheduled normShares referencing it showed as a poll in LinkedIn's own list.
describe('polls', () => {
  test('durations map to the enum LinkedIn takes, and only those', () => {
    expect(pollDuration('1d')).toBe('ONE_DAY');
    expect(pollDuration('3d')).toBe('THREE_DAYS');
    expect(pollDuration('1w')).toBe('ONE_WEEK');
    expect(pollDuration('2w')).toBe('TWO_WEEKS');
    expect(pollDuration('5d')).toBeNull();
  });

  test('the poll urn is read from the mutation result', () => {
    const json = {
      data: {
        data: { doCreatePollFeedDashPollsPollSummary: { '*result': 'urn:li:fsd_pollSummary:42' } },
      },
    };
    expect(pollUrnOf(json)).toBe('urn:li:fsd_pollSummary:42');
  });

  // GraphQL reports a validation failure as HTTP 200 with an errors array.
  test('a 200 carrying errors yields no poll urn', () => {
    expect(pollUrnOf({ data: { errors: [{ message: 'bad' }] } })).toBeNull();
    expect(pollUrnOf({ errors: [{ message: 'bad' }] })).toBeNull();
  });

  const POLL = {
    question: 'Which layer?',
    options: ['Discover', 'Guard'],
    duration: 'ONE_WEEK' as const,
  };

  function scripted(...replies: { ok: boolean; json?: unknown }[]) {
    const sent: { url: string; method?: string; body?: unknown }[] = [];
    return {
      sent,
      request: async (spec: (typeof sent)[number]) => {
        sent.push(spec);
        const r = replies.shift();
        return r?.ok
          ? { ok: true as const, json: r.json, classification: {} as never }
          : { ok: false as const, code: 'BLOCKED', message: 'refused' };
      },
    };
  }

  test('creates the poll, then posts it as an URN_REFERENCE', async () => {
    const c = scripted(
      { ok: true, json: { data: { data: { x: { '*result': 'urn:li:fsd_pollSummary:42' } } } } },
      { ok: true, json: { data: { status: { urn: 'urn:li:ugcPost:5' } } } },
    );
    const r = await share(
      confirmed({ text: 'vote', visibility: 'PUBLIC' as const, poll: POLL }),
      c as never,
    );
    expect(r).toEqual({ ok: true, id: 'urn:li:ugcPost:5' });
    expect(c.sent[0]?.url).toContain('queryId=voyagerFeedDashPollsPollSummary.');
    expect(c.sent[0]?.body).toMatchObject({ variables: { poll: POLL } });
    const posted = c.sent[1]?.body as { media: unknown[] } | undefined;
    expect(posted?.media).toEqual([
      { category: 'URN_REFERENCE', mediaUrn: 'urn:li:fsd_pollSummary:42', tapTargets: [] },
    ]);
  });

  test('a poll LinkedIn would not create posts nothing', async () => {
    const c = scripted({
      ok: true,
      json: { data: { errors: [{ message: 'question too long' }] } },
    });
    const r = await share(
      confirmed({ text: 'vote', visibility: 'PUBLIC' as const, poll: POLL }),
      c as never,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('question too long');
    expect(c.sent).toHaveLength(1);
  });
});
