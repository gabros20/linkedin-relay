import { describe, expect, test } from 'bun:test';
import { menuBody, parseCommentUrn } from '../src/engine/sdui-menu.ts';

// Three forms are live at once. `post` returns the fsd_ form; the same comment
// is written two other ways elsewhere, with the members in the OPPOSITE order.
// Reading the id positionally instead of by shape gets the post and the comment
// backwards — and then an action lands on the wrong thing.
describe('comment urns, in every form LinkedIn uses', () => {
  const expected = {
    activityId: '6620492574320930816',
    commentId: '7493773969058062336',
    threadType: 'activity' as const,
  };

  test('the fsd_ form returned by `post` — comment id FIRST', () => {
    expect(
      parseCommentUrn(
        'urn:li:fsd_comment:(7493773969058062336,urn:li:activity:6620492574320930816)',
      ),
    ).toEqual(expected);
  });

  test('the short form — activity FIRST, and without its urn prefix', () => {
    expect(
      parseCommentUrn('urn:li:comment:(activity:6620492574320930816,7493773969058062336)'),
    ).toEqual(expected);
  });

  test('the fully-qualified form — activity first, with its prefix', () => {
    expect(
      parseCommentUrn('urn:li:comment:(urn:li:activity:6620492574320930816,7493773969058062336)'),
    ).toEqual(expected);
  });

  // A comment's thread is NOT always an activity urn. Found by trying to reply
  // to a real comment in the feed: `post` returned a thread keyed to a ugcPost,
  // and the parser silently returned null — so `edit` and `delete` refused a
  // perfectly valid comment urn. ENGINE-RESEARCH already warns that activity
  // and ugcPost are distinct and not derivable from each other.
  test('accepts a thread keyed to a ugcPost, not just an activity', () => {
    expect(
      parseCommentUrn(
        'urn:li:fsd_comment:(7492591966757715969,urn:li:ugcPost:7492281375731998720)',
      ),
    ).toEqual({
      commentId: '7492591966757715969',
      activityId: '7492281375731998720',
      threadType: 'ugcPost',
    });
  });

  test('records which namespace the thread used, rather than assuming', () => {
    expect(parseCommentUrn('urn:li:fsd_comment:(1,urn:li:activity:2)')?.threadType).toBe(
      'activity',
    );
    expect(parseCommentUrn('urn:li:fsd_comment:(1,urn:li:ugcPost:2)')?.threadType).toBe('ugcPost');
  });

  test('a post urn is not a comment urn', () => {
    expect(parseCommentUrn('urn:li:activity:6620492574320930816')).toBeNull();
  });

  test('rejects malformed input rather than half-parsing it', () => {
    expect(parseCommentUrn('urn:li:comment:(nonsense)')).toBeNull();
    expect(parseCommentUrn('')).toBeNull();
  });

  // Both members are numeric, so a swap is undetectable downstream.
  test('never returns the two ids the wrong way round', () => {
    for (const urn of [
      'urn:li:fsd_comment:(7493773969058062336,urn:li:activity:6620492574320930816)',
      'urn:li:comment:(activity:6620492574320930816,7493773969058062336)',
    ]) {
      const r = parseCommentUrn(urn);
      expect(r?.activityId).toBe('6620492574320930816');
      expect(r?.commentId).toBe('7493773969058062336');
    }
  });
});

// The menu payload names the thread explicitly. Building it as `urn:li:activity:`
// when the comment actually hangs off a ugcPost sends the server a urn for a
// different entity — the kind of mismatch that does not error, it just acts on
// the wrong thing or silently finds nothing.
describe('the thread urn is rebuilt in the namespace it came from', () => {
  test('an activity-threaded comment keeps urn:li:activity', () => {
    const b = menuBody(
      { activityId: '66', commentId: '749', threadType: 'activity' },
      'T',
    ) as never as {
      requestedArguments: { payload: { commentUrn: { thread: string } } };
    };
    expect(b.requestedArguments.payload.commentUrn.thread).toBe('urn:li:activity:66');
  });

  test('a ugcPost-threaded comment keeps urn:li:ugcPost', () => {
    const b = menuBody(
      { activityId: '66', commentId: '749', threadType: 'ugcPost' },
      'T',
    ) as never as {
      requestedArguments: { payload: { commentUrn: { thread: string } } };
    };
    expect(b.requestedArguments.payload.commentUrn.thread).toBe('urn:li:ugcPost:66');
  });

  test('a urn round-trips through parse and rebuild unchanged', () => {
    for (const urn of [
      'urn:li:fsd_comment:(749,urn:li:activity:66)',
      'urn:li:fsd_comment:(749,urn:li:ugcPost:66)',
    ]) {
      const ref = parseCommentUrn(urn);
      if (ref === null) throw new Error(`did not parse: ${urn}`);
      const b = menuBody(ref, 'T') as never as {
        requestedArguments: { payload: { commentUrn: { thread: string } } };
      };
      expect(b.requestedArguments.payload.commentUrn.thread).toBe(`urn:li:${ref.threadType}:66`);
    }
  });
});
