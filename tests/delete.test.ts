import { describe, expect, test } from 'bun:test';
import type { ConfirmedWrite } from '../src/commands/confirm.ts';
import { evictionTarget, findOwnPost, previewLines } from '../src/commands/delete.ts';
import { deletePost, deleteUrl, isDeletableUrn } from '../src/engine/voyager-write.ts';

function confirmed<T>(payload: T): ConfirmedWrite<T> {
  return { action: 'delete a post', payload, token: 'abcd' } as ConfirmedWrite<T>;
}

function client(status: 'ok' | 'notfound' | 'blocked') {
  const sent: { url: string; method?: string }[] = [];
  return {
    sent,
    request: async (spec: { url: string; method?: string }) => {
      sent.push(spec);
      if (status === 'ok') return { ok: true as const, json: null, classification: {} as never };
      return status === 'notfound'
        ? { ok: false as const, code: 'NOT_FOUND', message: 'not found' }
        : { ok: false as const, code: 'BLOCKED', message: 'refused' };
    },
  };
}

describe('which urns may be deleted', () => {
  test('accepts the share urn the endpoint is documented against', () => {
    expect(isDeletableUrn('urn:li:share:7123456789')).toBe(true);
  });

  test('accepts an activity urn, which is what our own reads return', () => {
    expect(isDeletableUrn('urn:li:activity:7123456789')).toBe(true);
  });

  // Refusing early beats URL-encoding whatever we were handed and hoping. A
  // profile urn would be a well-formed request to destroy the wrong kind of
  // thing, and we have no evidence for what the endpoint does with one.
  test('refuses a urn that does not identify a post', () => {
    expect(isDeletableUrn('urn:li:person:ACoAAB')).toBe(false);
    expect(isDeletableUrn('urn:li:fsd_profile:ACoAAB')).toBe(false);
  });

  test('refuses free text and empty input rather than encoding it', () => {
    expect(isDeletableUrn('my last post')).toBe(false);
    expect(isDeletableUrn('')).toBe(false);
  });
});

describe('the delete URL', () => {
  test('percent-encodes the urn — the colons are path-hostile', () => {
    expect(deleteUrl('urn:li:share:71')).toBe(
      'https://www.linkedin.com/voyager/api/contentcreation/normShares/urn%3Ali%3Ashare%3A71',
    );
  });
});

describe('deleting', () => {
  test('issues a DELETE, not a POST', async () => {
    const c = client('ok');
    await deletePost(confirmed({ urn: 'urn:li:share:71' }), c as never);
    expect(c.sent[0]?.method).toBe('DELETE');
  });

  test('reports success', async () => {
    const r = await deletePost(confirmed({ urn: 'urn:li:share:71' }), client('ok') as never);
    expect(r.ok).toBe(true);
  });

  // 404 is ambiguous and the two meanings need different actions from the
  // user: "already gone" is fine, "wrong urn type" means try the other one.
  test('a 404 says both things it could mean rather than picking one', async () => {
    const r = await deletePost(
      confirmed({ urn: 'urn:li:activity:71' }),
      client('notfound') as never,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.hint).toContain('already');
    expect(r.hint).toContain('urn:li:share:');
  });

  test('a refusal is surfaced, not swallowed', async () => {
    const r = await deletePost(confirmed({ urn: 'urn:li:share:71' }), client('blocked') as never);
    expect(r.ok).toBe(false);
  });
});

// Deleting is the one irreversible action here. Showing the human the actual
// text of what they are about to destroy is the whole point of the gate.
describe('finding the post being deleted', () => {
  const posts = [
    { urn: 'urn:li:activity:1', text: 'first post', author: 'Me' },
    { urn: 'urn:li:activity:2', text: 'second post', author: 'Me' },
  ];

  test('finds the post by its urn', () => {
    expect(findOwnPost(posts, 'urn:li:activity:2')?.text).toBe('second post');
  });

  test('returns undefined when the urn is not among your posts', () => {
    expect(findOwnPost(posts, 'urn:li:activity:99')).toBeUndefined();
  });

  // The urn the user has may be a share urn while the read returns an activity
  // urn for the same post. Matching on the numeric id bridges them.
  test('matches across urn namespaces by the id they share', () => {
    expect(findOwnPost(posts, 'urn:li:share:2')?.text).toBe('second post');
  });

  test('does not match a different id that merely starts the same', () => {
    expect(findOwnPost([{ urn: 'urn:li:activity:123' }], 'urn:li:share:12')).toBeUndefined();
  });
});

describe('the preview shown before deleting', () => {
  test('shows the post text so the human sees what they are destroying', () => {
    const lines = previewLines({ urn: 'urn:li:activity:1', text: 'the actual words' });
    expect(lines.join('\n')).toContain('the actual words');
  });

  // Proceeding blind is allowed — the post may simply be older than the window
  // we fetched — but it must be stated, not silently skipped.
  test('says plainly when the post could not be read', () => {
    const lines = previewLines(undefined);
    expect(lines.join('\n')).toMatch(/could not/i);
  });

  test('a long post is truncated rather than flooding the prompt', () => {
    const lines = previewLines({ urn: 'u', text: 'x'.repeat(1000) });
    expect(lines.join('\n').length).toBeLessThan(400);
  });
});

// `sync my-posts` upserts and never evicts, so a deleted post lingers in the
// cache and `my-posts` keeps listing something that no longer exists. Verified
// live: after a successful delete LinkedIn returned 1 post while the cache
// still held 2.
//
// Connections solve this with a snapshot diff, but that machinery exists
// because absence from a LIMITED fetch does not prove removal. Here nothing
// needs inferring — we deleted it, so we know.
describe('a deleted post leaves the cache too', () => {
  test('the urn to evict is the one that was deleted', () => {
    expect(evictionTarget({ ok: true, id: 'urn:li:activity:7' })).toBe('urn:li:activity:7');
  });

  test('a FAILED delete evicts nothing — the post is still there', () => {
    expect(evictionTarget({ ok: false, code: 'NOT_FOUND', message: 'x' })).toBeNull();
  });

  test('a success with no urn evicts nothing rather than guessing', () => {
    expect(evictionTarget({ ok: true, id: null })).toBeNull();
  });
});
