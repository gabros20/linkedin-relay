import { describe, expect, test } from 'bun:test';
import {
  activityIdSegment,
  extractCommentTokens,
  keyMatchesPost,
} from '../src/engine/sdui-harvest.ts';

// The golden pair, taken off the wire on 2026-08-13: this exact activity id
// produced this exact segment in the live client's binding key.
const ID = '7493711068700033024';
// Segment A is UNPADDED base64; the '-' that follows is a separator. This
// sample is degenerate — its segment B also begins with '-', so the pair reads
// like base64 '==' padding. A second post (6620492574320930816 -> …C3AQ-93Oy…)
// is what disambiguated it, and an encoder that padded passed this test alone.
const SEGMENT = 'CgsIgIC6tO+ggf/PAQ';
const KEY = `commentBoxText-${SEGMENT}--C6B_POCUy-WtfBFZljzw4nBJWJuFXssdgUqs8M9nh0FeedType_FEED_DETAIL`;

describe('encoding the post id into a binding key segment', () => {
  test('reproduces the segment the live client produced', () => {
    expect(activityIdSegment(ID)).toBe(SEGMENT);
  });

  // The second, non-degenerate post — the one that caught the padding bug.
  test('reproduces a second post captured from a different page', () => {
    expect(activityIdSegment('6620492574320930816')).toBe('CgsIgMCVqOy62+C3AQ');
  });

  test('never emits base64 padding — the next character is a separator', () => {
    for (const id of ['1', '42', ID, '6620492574320930816']) {
      expect(activityIdSegment(id)).not.toMatch(/[=-]$/);
    }
  });

  // 7493711068700033024 exceeds Number.MAX_SAFE_INTEGER. Doing this in a JS
  // number silently rounds, and a rounded id encodes a segment for a post that
  // does not exist.
  test('does not lose precision on an id beyond Number.MAX_SAFE_INTEGER', () => {
    expect(Number(ID) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(activityIdSegment(ID)).not.toBe(activityIdSegment('7493711068700033025'));
  });

  test('different posts encode to different segments', () => {
    expect(activityIdSegment('1')).not.toBe(activityIdSegment('2'));
  });

  test('refuses a non-numeric id rather than encoding nonsense', () => {
    expect(() => activityIdSegment('urn:li:activity:7')).toThrow();
    expect(() => activityIdSegment('')).toThrow();
  });
});

// This is what makes scraping safe. A harvested key carries the post id inside
// it, so we can prove the key belongs to the post we intend to comment on
// rather than trusting the page we scraped it from.
describe('proving a key belongs to the intended post', () => {
  test('accepts the key harvested for that post', () => {
    expect(keyMatchesPost(KEY, ID)).toBe(true);
  });

  test('rejects a key belonging to a DIFFERENT post', () => {
    const other = `commentBoxText-${activityIdSegment('7000000000000000001')}-xxxxFeedType_FEED_DETAIL`;
    expect(keyMatchesPost(other, ID)).toBe(false);
  });

  test('rejects a malformed key rather than assuming it is fine', () => {
    expect(keyMatchesPost('commentBoxText-', ID)).toBe(false);
    expect(keyMatchesPost('', ID)).toBe(false);
  });
});

describe('extracting tokens from the rendered page', () => {
  // Shaped like the real page: quotes HTML-escaped, a page-level trackingId far
  // from the post beside treeId, and the update's own trackingId adjacent to a
  // mention of the activity id.
  const html =
    `<code>&quot;treeId&quot;:&quot;AAZY88c7ApxdKsLPSS6Duw==&quot;,` +
    `&quot;trackingId&quot;:&quot;PAGELEVELxxxxxxxxxxxxx==&quot;</code>` +
    `${'.'.repeat(5000)}` +
    `<code>&quot;activityId&quot;:&quot;${ID}&quot;,&quot;trackingId&quot;:&quot;NC1yUhvpRcGdV09E17cKUQ==&quot;</code>` +
    `<div data-x="${KEY}"></div>`;

  test('finds the binding key and the tracking id', () => {
    const r = extractCommentTokens(html, ID);
    if (!r.ok) throw new Error(r.message);
    expect(r.bindingKey).toBe(KEY);
    expect(r.trackingId).toBe('NC1yUhvpRcGdV09E17cKUQ==');
  });

  // The page-level id appears FIRST in document order. Taking the first match
  // is the obvious implementation and it is wrong.
  test('does not take the page-level trackingId that appears earlier', () => {
    const r = extractCommentTokens(html, ID);
    if (!r.ok) throw new Error(r.message);
    expect(r.trackingId).not.toContain('PAGELEVEL');
  });

  // The whole point of the id check: a page can legitimately contain comment
  // boxes for OTHER posts (the feed does). Picking the wrong one would comment
  // on someone else's post under the user's name.
  test('ignores a comment box belonging to another post on the same page', () => {
    const foreign = `commentBoxText-${activityIdSegment('123')}-zzzzFeedType_FEED`;
    const mixed =
      `<div>${foreign}</div><div>${KEY}</div>` +
      `&quot;activityId&quot;:&quot;${ID}&quot;,&quot;trackingId&quot;:&quot;NC1yUhvpRcGdV09E17cKUQ==&quot;`;
    const r = extractCommentTokens(mixed, ID);
    if (!r.ok) throw new Error(r.message);
    expect(r.bindingKey).toBe(KEY);
  });

  test('fails loudly when no key for this post is present', () => {
    const r = extractCommentTokens('<html>nothing here</html>', ID);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toMatch(/binding key/i);
  });

  // A missing trackingId must not silently become undefined in a 9 KB payload.
  test('fails when the tracking id is absent', () => {
    const r = extractCommentTokens(`<div>${KEY}</div>`, ID);
    expect(r.ok).toBe(false);
  });

  test('fails when the only trackingId is nowhere near the post', () => {
    const far =
      `<div>${KEY}</div>${'.'.repeat(5000)}` +
      `&quot;trackingId&quot;:&quot;NC1yUhvpRcGdV09E17cKUQ==&quot;`;
    expect(extractCommentTokens(far, ID).ok).toBe(false);
  });

  test('a login or checkpoint page is reported as such, not as a missing key', () => {
    const r = extractCommentTokens('<html><form action="/checkpoint/challenge">', ID);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toMatch(/challenge|sign in|session/i);
  });
});
