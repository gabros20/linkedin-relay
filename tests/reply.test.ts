import { describe, expect, test } from 'bun:test';
import type { ConfirmedWrite } from '../src/commands/confirm.ts';
import { REPLY_URL, replyBody, replyToComment } from '../src/engine/voyager-reply.ts';

const REF = {
  activityId: '6620492574320930816',
  commentId: '7494023287287676928',
  threadType: 'activity' as const,
};

function confirmed<T>(payload: T): ConfirmedWrite<T> {
  return { action: 'reply to a comment', payload, token: 'abcd' } as ConfirmedWrite<T>;
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

// Captured live 2026-08-14 from a reply made by hand. Replies do NOT use the
// SDUI createComment that top-level comments use — they go to Voyager, with a
// far simpler payload whose threadUrn IS the parent comment. The previous
// implementation searched the SDUI surface and could never have found this.
describe('the reply endpoint', () => {
  test('is Voyager, not the SDUI action route', () => {
    expect(REPLY_URL).toContain('/voyager/api/voyagerSocialDashNormComments');
    expect(REPLY_URL).not.toContain('rsc-action');
  });

  // Omitting it returned 500, not a 400 — a decorated resource asked for
  // without its recipe. Versioned, so it rotates like a queryId.
  test('carries the decorationId, without which the endpoint 500s', () => {
    expect(REPLY_URL).toContain(
      'decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43',
    );
  });
});

describe('the reply payload', () => {
  const body = replyBody(REF, 'hello there');

  // This is the parent reference the SDUI route never had.
  test('threadUrn is the PARENT COMMENT, not the post', () => {
    expect(body.threadUrn).toBe(
      'urn:li:comment:(activity:6620492574320930816,7494023287287676928)',
    );
  });

  test('uses the short urn form the live client sent — activity without its prefix', () => {
    expect(body.threadUrn).not.toContain('urn:li:activity:');
    expect(body.threadUrn).toContain('(activity:');
  });

  test('keeps a ugcPost-threaded parent in its own namespace', () => {
    expect(replyBody({ ...REF, threadType: 'ugcPost' }, 'x').threadUrn).toBe(
      'urn:li:comment:(ugcPost:6620492574320930816,7494023287287676928)',
    );
  });

  test('carries the text as a TextViewModel', () => {
    expect(body.commentary.text).toBe('hello there');
    expect(body.commentary.$type).toBe('com.linkedin.voyager.dash.common.text.TextViewModel');
  });

  // The captured reply carried a profileMention because LinkedIn's UI
  // pre-fills "@Author ". We send none — an unasked-for mention notifies a
  // real person, and the text should be exactly what the user typed.
  test('sends no attributes — we do not invent an @mention', () => {
    expect(body.commentary.attributesV2).toEqual([]);
  });

  test('text is carried verbatim — newlines, emoji and accents survive', () => {
    const t = 'első sor\nmásodik 🎯 — Székely';
    expect(replyBody(REF, t).commentary.text).toBe(t);
  });
});

describe('sending', () => {
  test('posts to the reply endpoint', async () => {
    const c = client();
    await replyToComment(confirmed({ ref: REF, text: 'hi' }), c as never);
    expect(c.sent[0]?.url).toBe(REPLY_URL);
  });

  test('a refusal is surfaced, not swallowed', async () => {
    const r = await replyToComment(confirmed({ ref: REF, text: 'hi' }), client(false) as never);
    expect(r.ok).toBe(false);
  });
});
