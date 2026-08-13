import { describe, expect, test } from 'bun:test';
import { parseCommentUrn } from '../src/engine/sdui-menu.ts';

// Three forms are live at once. `post` returns the fsd_ form; the same comment
// is written two other ways elsewhere, with the members in the OPPOSITE order.
// Reading the id positionally instead of by shape gets the post and the comment
// backwards — and then an action lands on the wrong thing.
describe('comment urns, in every form LinkedIn uses', () => {
  const expected = { activityId: '6620492574320930816', commentId: '7493773969058062336' };

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
