import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSTS_PAGER, parsePosts, postsPagerBody } from '../src/engine/posts.ts';

// Captured 2026-10-14: 20 posts for "artificial intelligence" from the posts
// search pager, trimmed to the rows the parser reads and the reference paths
// to them, with a model cut to these posts. Every person and every post text
// is replaced; company names, times and counts are kept. The viewer's
// LinkedIn is in Hungarian, so times read "5 órája" (5 hours ago).
const STREAM = readFileSync(join(import.meta.dir, 'fixtures', 'search-posts.rsc'), 'utf-8');

describe('the pager request', () => {
  test('keywords, start, count and every filter, as the results page sends them', () => {
    const body = postsPagerBody({
      keywords: 'agents',
      filters: { datePosted: ['past-week'], authorCompany: ['1035'] },
      start: 40,
    }) as {
      pagerId: string;
      paginationRequest: { requestedArguments: { payload: Record<string, unknown> } };
    };
    expect(body.pagerId).toBe(POSTS_PAGER);
    const p = body.paginationRequest.requestedArguments.payload;
    expect(p).toMatchObject({
      startIndex: 40,
      keywords: 'agents',
      count: 20,
      datePosted: ['past-week'],
      authorCompany: ['1035'],
      sortBy: [],
      fromMember: [],
    });
  });
});

describe('a page of posts', () => {
  // This page has 20 post cards; the parser emits 20, in LinkedIn's order.
  test('every card becomes one post', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts).toHaveLength(20);
    expect(r.unread).toBe(0);
  });

  test('a post by a person: id, link, author, headline, time, text and counts', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts[0]).toEqual({
      id: 'urn:li:ugcPost:7516026998138306560',
      url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7516026998138306560/',
      author: 'Person 1',
      authorHeadline: 'Headline 1',
      authorUrl: 'https://www.linkedin.com/in/person-1/',
      posted: '5 órája',
      text: expect.stringMatching(/^Text \d+$/),
      reactions: 4,
      comments: 1,
      reposts: 1,
    });
  });

  test('a post by a company page: named by the page, linked to it', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    const page = r.posts.find((p) => p.author === 'Blockchain Council');
    expect(page).toMatchObject({
      authorUrl: 'https://www.linkedin.com/company/blockchaincouncil/',
      posted: '15 órája',
      reactions: 15,
      comments: 5,
    });
    expect(page?.authorHeadline).toBeUndefined();
  });

  test('a page whose link label carries a badge ("Microsoft Premium") is still named', () => {
    const badged = STREAM.replaceAll(
      '"aria-label":"Blockchain Council ',
      '"aria-label":"Blockchain Council Prémium',
    );
    const r = parsePosts(badged);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts.find((p) => p.authorUrl?.includes('blockchaincouncil'))?.author).toBe(
      'Blockchain Council',
    );
  });

  test('reactions add up every reaction type', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts.find((p) => p.id === 'urn:li:ugcPost:7515739028353114113')).toMatchObject({
      reactions: 360,
      comments: 19,
      reposts: 50,
    });
  });

  test('a text keeps its line breaks', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts.some((p) => p.text?.includes('\n'))).toBe(true);
  });

  test('a group post is kept with what it has, not dropped', () => {
    const r = parsePosts(STREAM);
    if (!r.ok) throw new Error(r.message);
    const group = r.posts.find((p) => p.id.startsWith('urn:li:groupPost:'));
    expect(group).toMatchObject({ posted: '2 perce' });
    expect(group?.comments).toBeUndefined();
  });

  test('a stream that is not a posts page is drift', () => {
    expect(parsePosts('0:{"hello":1}').ok).toBe(false);
  });

  test('cards with no post behind them are drift, not an empty page', () => {
    const cards = STREAM.split('\n')
      .filter((l) => l.includes('"viewName":"feed-full-update"'))
      .map((l) => l.replace(/commentCount-/g, 'nothing-'))
      .join('\n');
    expect(parsePosts(cards).ok).toBe(false);
  });
});
