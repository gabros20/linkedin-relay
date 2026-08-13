import { describe, expect, test } from 'bun:test';
import type { ConfirmedWrite } from '../src/commands/confirm.ts';
import {
  COMMENT_URL,
  comment,
  commentBody,
  feedTypeFor,
  keyBody,
} from '../src/engine/sdui-comment.ts';
import { activityIdSegment } from '../src/engine/sdui-harvest.ts';

const ID = '7493711068700033024';
const BODY = `${activityIdSegment(ID)}--C6B_POCUy-WtfBFZljzw4nBJWFeedType_FEED_DETAIL`;
const KEY = `commentBoxText-${BODY}`;
const TOKENS = { bindingKey: KEY, trackingId: 'KgqrlKP8QFOsjQ/0KFWlTw==' };

function confirmed<T>(payload: T): ConfirmedWrite<T> {
  return { action: 'comment on a post', payload, token: 'abcd' } as ConfirmedWrite<T>;
}

function client(ok = true) {
  const sent: { url: string; body?: unknown }[] = [];
  return {
    sent,
    request: async (spec: { url: string; body?: unknown }) => {
      sent.push(spec);
      return ok
        ? { ok: true as const, json: null, classification: {} as never }
        : { ok: false as const, code: 'BLOCKED', message: 'refused' };
    },
  };
}

describe('key derivation', () => {
  test('all five state slots share one key body', () => {
    expect(keyBody(KEY)).toBe(BODY);
  });

  test('the feed type is read from the key, not assumed', () => {
    expect(feedTypeFor(KEY)).toBe(3);
  });

  // A permalink fetched over plain HTTP can hand back a FEED key, whose number
  // is unknown. Guessing an integer here is a malformed write on a real post.
  test('an unobserved feed context yields null rather than a guess', () => {
    expect(feedTypeFor('commentBoxText-xxxFeedType_FEED')).toBeNull();
    expect(feedTypeFor('commentBoxText-nosuffix')).toBeNull();
  });
});

describe('the comment payload', () => {
  const body = commentBody(ID, 'hello there', TOKENS, 3);
  const args = body.requestedArguments as {
    states: { key: string; value: unknown; originalProtoCase: string }[];
    requestedStateKeys: { key: { value: { id: string } } }[];
    payload: Record<string, { key?: string }>;
  };

  test('carries the text as a plain string', () => {
    const s = args.states.find((x) => x.key.startsWith('commentBoxText-'));
    expect(s?.value).toBe('hello there');
    expect(s?.originalProtoCase).toBe('stringValue');
  });

  test('carries the same text again as a TextModel', () => {
    const rich = args.states.find((x) => x.key.startsWith('richCommentBoxText-'));
    expect(rich?.value).toEqual({
      text: 'hello there',
      attribute: [],
      $type: 'TextModel',
      source: 'local',
    });
  });

  // The captured client sent all five, including three empty ones. Sending
  // four, or dropping the empties, has never been observed.
  test('sends all five state slots, empties included', () => {
    expect(args.states).toHaveLength(5);
    expect(args.requestedStateKeys).toHaveLength(5);
  });

  test('every state key is echoed in requestedStateKeys', () => {
    const declared = args.requestedStateKeys.map((k) => k.key.value.id).sort();
    expect(args.states.map((s) => s.key).sort()).toEqual(declared);
  });

  test('the trackingId reaches the update item', () => {
    expect(JSON.stringify(body)).toContain('KgqrlKP8QFOsjQ/0KFWlTw==');
  });

  test('the post id appears as a bare numeric id, not a urn', () => {
    const raw = JSON.stringify(body);
    expect(raw).toContain(`"activityId":"${ID}"`);
    expect(raw).not.toContain(`urn:li:activity:${ID}`);
  });

  test('text is carried verbatim — newlines, emoji and accents survive', () => {
    const t = 'első sor\nmásodik 🎯 — Székely';
    const b = commentBody(ID, t, TOKENS, 3) as { states: { value: unknown }[] };
    expect(b.states[0]?.value).toBe(t);
  });
});

// A wrong binding does not error. It comments somewhere else, publicly, under
// the owner's name — so these are refusals before the network, not after.
describe('guards that run before anything is sent', () => {
  test('refuses a binding key belonging to a different post', () => {
    const foreign = `commentBoxText-${activityIdSegment('123')}-xFeedType_FEED_DETAIL`;
    const c = client();
    return comment(
      confirmed({ activityId: ID, text: 'hi', tokens: { ...TOKENS, bindingKey: foreign } }),
      c as never,
    ).then((r) => {
      expect(r.ok).toBe(false);
      expect(c.sent).toHaveLength(0);
    });
  });

  test('refuses an unobserved feed context rather than inventing a number', async () => {
    const c = client();
    const key = `commentBoxText-${activityIdSegment(ID)}-xFeedType_FEED`;
    const r = await comment(
      confirmed({ activityId: ID, text: 'hi', tokens: { ...TOKENS, bindingKey: key } }),
      c as never,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('NOT_IMPLEMENTED');
    expect(c.sent).toHaveLength(0);
  });

  test('a valid comment reaches the SDUI endpoint', async () => {
    const c = client();
    const r = await comment(confirmed({ activityId: ID, text: 'hi', tokens: TOKENS }), c as never);
    expect(r.ok).toBe(true);
    expect(c.sent[0]?.url).toBe(COMMENT_URL);
  });
});
