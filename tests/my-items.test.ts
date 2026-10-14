import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ITEMS, itemsUrl, parseItems, STAGES } from '../src/engine/my-items.ts';

// Captured 2026-10-14 from the owner's My items: one saved post (its author
// and text replaced), one course in progress, and the job tracker's 6
// archived jobs. Courses and jobs are public listings.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

const variables = (url: string) =>
  decodeURIComponent(new URL(url).searchParams.get('variables') ?? '');

describe('requests', () => {
  test('each list is the search with its own My-items intent', () => {
    expect(ITEMS).toEqual({
      posts: 'SEARCH_MY_ITEMS_SAVED_POSTS',
      learning: 'SEARCH_MY_ITEMS_LEARNING',
      jobs: 'SEARCH_MY_ITEMS_JOB_SEEKER',
    });
    expect(variables(itemsUrl('learning', { start: 10 }))).toBe(
      '(start:10,query:(flagshipSearchIntent:SEARCH_MY_ITEMS_LEARNING))',
    );
  });

  // The stage names are the job tracker's own (?stage=archived, …).
  // LinkedIn does not check the value: a wrong name answers "none".
  test('tracked jobs name their stage', () => {
    expect(STAGES).toEqual({
      saved: 'SAVED',
      'in-progress': 'IN_PROGRESS',
      applied: 'APPLIED',
      interview: 'INTERVIEW',
      archived: 'ARCHIVED',
    });
    expect(variables(itemsUrl('jobs', { start: 0, stage: 'archived' }))).toContain(
      'queryParameters:List((key:cardType,value:List(ARCHIVED)))',
    );
  });

  test('a page token is sent on when LinkedIn gives one', () => {
    expect(variables(itemsUrl('posts', { start: 1, token: 'abc=' }))).toContain(
      'paginationToken:abc=',
    );
  });
});

describe('saved posts', () => {
  // 1 saved post; the parser emits 1.
  test('the post: its id for `post`, link, author, headline, when, text', () => {
    const r = parseItems('posts', fixture('items-saved-posts.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toEqual([
      {
        id: 'urn:li:activity:7513986929265254400',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:7513986929265254400/',
        author: 'Person 1',
        authorHeadline: 'Headline 1',
        posted: '5d',
        text: 'Post text',
      },
    ]);
    expect(r.total).toBe(1);
  });
});

describe('learning', () => {
  test('the course: length, instructor and release, progress, link', () => {
    const r = parseItems('learning', fixture('items-learning.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toEqual([
      {
        id: '2818086',
        name: 'After Effects 2020 New Features',
        length: 'Course · 9m',
        detail: 'By: Mark Christiansen · Released Nov 4, 2019',
        progress: '6m left',
        url: 'https://www.linkedin.com/learning/after-effects-2020-new-features',
      },
    ]);
  });
});

describe('tracked jobs', () => {
  // 6 archived jobs; the parser emits 6.
  test('each job: id for `job`, title, company, place, workplace, its stage, and if it closed', () => {
    const r = parseItems('jobs', fixture('items-jobs-archived.json'), 'archived');
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toHaveLength(6);
    expect(r.items.find((j) => j.id === '4459168502')).toEqual({
      id: '4459168502',
      title: 'AI Developer - Agentic AI',
      company: 'ALDI International IT Services (Hungary)',
      location: 'Budapest, Hungary',
      workplace: 'hybrid',
      stage: 'archived',
      note: 'No longer accepting applications',
      url: 'https://www.linkedin.com/jobs/view/4459168502/',
    });
  });
});

describe('failures', () => {
  test('items listed but not sent is drift', () => {
    const j = fixture('items-jobs-archived.json');
    expect(parseItems('jobs', { ...j, included: [] }, 'archived').ok).toBe(false);
  });
});
