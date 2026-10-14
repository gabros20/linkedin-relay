import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseResults, SEARCH_KINDS, searchUrl } from '../src/engine/search.ts';

// Captured 2026-10-14: one page of 50 for "artificial intelligence" in each
// kind the search box offers beside people and jobs, with its filter list.
// Services rows are people, redacted like the people fixtures.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

const variables = (url: string) =>
  decodeURIComponent(new URL(url).searchParams.get('variables') ?? '');

describe('the request', () => {
  test('each kind asks for its own result type, 50 a page', () => {
    expect(SEARCH_KINDS).toEqual({
      companies: 'COMPANIES',
      groups: 'GROUPS',
      events: 'EVENTS',
      courses: 'LEARNING',
      products: 'PRODUCTS',
      services: 'SERVICES',
      schools: 'SCHOOLS',
    });
    const v = variables(
      searchUrl({
        kind: 'courses',
        keywords: 'python',
        params: { difficultyLevel: ['Beginner'] },
        start: 50,
      }),
    );
    expect(v).toContain('start:50,count:50');
    expect(v).toContain('(key:difficultyLevel,value:List(Beginner))');
    expect(v).toContain('(key:resultType,value:List(LEARNING))');
  });
});

// Each fixture: how many results it holds (the parser emits that many), and
// its first row as LinkedIn ranked it.
const CASES = [
  {
    kind: 'companies',
    count: 50,
    first: {
      id: '24468',
      name: 'Artificial Intelligence',
      subtitle: 'Education • New York',
      detail: '32K followers',
      url: 'https://www.linkedin.com/company/ai-iura/',
    },
  },
  {
    kind: 'groups',
    count: 50,
    first: {
      id: '7036558',
      subtitle: '1M members',
      url: 'https://www.linkedin.com/groups/7036558',
    },
  },
  {
    kind: 'events',
    count: 65,
    first: {
      id: '7504163229280026624',
      name: 'Artificial Intelligence and Emerging Technologies in GMP',
      subtitle: 'Wed, Sep 30, 5:00 PM GST',
      detail: 'Online • By Paul R. Palmer Limited',
      url: 'https://www.linkedin.com/events/7504163229280026624/',
    },
  },
  {
    kind: 'courses',
    count: 50,
    first: {
      id: '3915031',
      name: 'Introduction to Artificial Intelligence',
      subtitle: 'Course • 2h 26m',
      detail: 'By: Doug Rose • Released Nov 21, 2024',
      url: 'https://www.linkedin.com/learning/introduction-to-artificial-intelligence-24947908',
    },
  },
  {
    kind: 'products',
    count: 49,
    first: {
      id: '105122645',
      name: 'Artificial Intelligence for Business',
      subtitle: 'AI-Powered Coaching Software by Ateliware',
    },
  },
  {
    kind: 'services',
    count: 50,
    first: { id: 'ACoAATESTPERSON1', name: 'Person 12', detail: 'Budapest Metropolitan Area' },
  },
  {
    kind: 'schools',
    count: 50,
    first: {
      id: '124313919',
      name: 'Artificial Intelligence Institute',
      detail: '1 student and alumni on LinkedIn',
    },
  },
] as const;

describe('a page of results', () => {
  for (const c of CASES) {
    test(`${c.kind}: ${c.count} results, each a flat row`, () => {
      const r = parseResults(fixture(`search-${c.kind}.json`));
      if (!r.ok) throw new Error(r.message);
      expect(r.items).toHaveLength(c.count);
      expect(r.items[0]).toMatchObject(c.first);
      expect(Object.keys(r.unknownTypes)).toEqual([]);
    });
  }

  test('a summary is kept, trimmed of LinkedIn padding', () => {
    const r = parseResults(fixture('search-groups.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items[0]?.summary).toStartWith('Welcome to the Technology Investor Club');
  });

  test('promo and text cards are page furniture, not unknown results', () => {
    const r = parseResults(fixture('search-services.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.excluded).toBe(3);
  });

  test('LinkedIn claims more than it pages: both counts are kept', () => {
    const r = parseResults(fixture('search-companies.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.claimed).toBe(190112);
    expect(r.total).toBe(1000);
  });

  test('results listed but not sent is drift, not an empty page', () => {
    expect(parseResults({ ...fixture('search-groups.json'), included: [] }).ok).toBe(false);
  });
});
