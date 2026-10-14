import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PEOPLE_PAGE,
  parseOrgHits,
  parsePeople,
  parsePeopleFilters,
  peopleFilterSelection,
  peopleSearchUrl,
} from '../src/engine/people.ts';

// Captured 2026-10-14 from the Voyager people search, with every member
// redacted (names, headlines, profile and member ids, vanity URLs, photos):
// "frontend developer" in Budapest with its filter list; engineers at
// Microsoft in Hungary, 50 a page; results 950-999 of a 43,013-person query;
// and a school search, which names schools with the ids `school` takes.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const PAGE = fixture('people-page.json');
const PAGE50 = fixture('people-page-50.json');
const CAPPED = fixture('people-page-capped.json');
const SCHOOLS = fixture('people-schools.json');

const variables = (url: string) =>
  decodeURIComponent(new URL(url).searchParams.get('variables') ?? '');

describe('the search request', () => {
  test('keywords, filters and paging reach the query, 50 a page', () => {
    const url = peopleSearchUrl({
      keywords: 'frontend developer',
      params: { currentCompany: ['1035'], network: ['F', 'S'] },
      start: 50,
    });
    const v = variables(url);
    expect(v).toContain('start:50,count:50');
    expect(v).toContain('keywords:frontend developer');
    expect(v).toContain('(key:currentCompany,value:List(1035))');
    expect(v).toContain('(key:network,value:List(F,S))');
    expect(v).toContain('(key:resultType,value:List(PEOPLE))');
    expect(new URL(url).searchParams.get('queryId')).toStartWith('voyagerSearchDashClusters.');
  });

  // Asking for 100 is answered with an empty success, not an error: a search
  // that would report "nobody" when there are thousands. 50 is the most.
  test('never asks for more than 50', () => {
    expect(PEOPLE_PAGE).toBe(50);
  });

  test('the filter list rides on the same query when asked', () => {
    const url = peopleSearchUrl({ keywords: 'x', params: {}, start: 0, withFilters: true });
    expect(variables(url)).toContain('includeFiltersInResponse:true');
  });

  test('a school or company name is looked up by its own kind of search', () => {
    const url = peopleSearchUrl({ keywords: 'ELTE', params: {}, start: 0, kind: 'SCHOOLS' });
    expect(variables(url)).toContain('(key:resultType,value:List(SCHOOLS))');
  });
});

describe('a page of people', () => {
  // This page has 10 people, a feedback card and an empty slot; the parser emits 10.
  test('every person becomes one flat row, in the order LinkedIn ranked them', () => {
    const r = parsePeople(PAGE);
    if (!r.ok) throw new Error(r.message);
    expect(r.people).toHaveLength(10);
    expect(r.people.map((p) => p.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ACoAATESTPERSON${i + 1}`),
    );
    expect(r.claimed).toBe(2512);
    expect(r.total).toBe(1000);
    expect(r.excluded).toBe(2);
  });

  test('a row carries name, headline, place, degree, badge, insight and a clean url', () => {
    const r = parsePeople(PAGE);
    if (!r.ok) throw new Error(r.message);
    const p = r.people.find((x) => x.insight === '1 mutual connection');
    expect(p).toMatchObject({
      name: expect.stringMatching(/^Person \d+$/),
      headline: expect.stringMatching(/^Headline \d+$/),
      location: expect.any(String),
      degree: '2nd',
      verified: true,
      url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/in\/person-\d+\/$/),
    });
  });

  test('a member LinkedIn will not name stays unnamed, with no profile url', () => {
    const r = parsePeople(PAGE);
    if (!r.ok) throw new Error(r.message);
    const hidden = r.people.filter((p) => p.degree === 'out of network');
    expect(hidden.length).toBeGreaterThan(0);
    for (const p of hidden) {
      expect(p.name).toBe('LinkedIn Member');
      expect(p.url).toBeUndefined();
    }
  });

  // 50 people on this page; the parser emits 50.
  test('a page of 50 gives 50', () => {
    const r = parsePeople(PAGE50);
    if (!r.ok) throw new Error(r.message);
    expect(r.people).toHaveLength(50);
    expect(r.claimed).toBe(56);
  });

  test('deep in a big query: LinkedIn claims tens of thousands but pages 1000', () => {
    const r = parsePeople(CAPPED);
    if (!r.ok) throw new Error(r.message);
    expect(r.people).toHaveLength(50);
    expect(r.start).toBe(950);
    expect(r.claimed).toBe(43013);
    expect(r.total).toBe(1000);
  });

  test('people listed but not sent is drift, not an empty page', () => {
    expect(parsePeople({ ...PAGE, included: [] }).ok).toBe(false);
  });

  test('a claimed count with nobody on the first page is a failed fetch', () => {
    const d = PAGE.data.data.searchDashClustersByAll;
    const empty = {
      data: {
        data: {
          searchDashClustersByAll: { ...d, elements: [], paging: { ...d.paging, total: 40 } },
        },
      },
      included: [],
    };
    expect(parsePeople(empty).ok).toBe(false);
  });

  test('an item kind we do not read is counted, not dropped silently', () => {
    const d = PAGE.data.data.searchDashClustersByAll;
    const odd = structuredClone(PAGE);
    odd.data.data.searchDashClustersByAll.elements = [
      ...d.elements,
      { items: [{ item: { '*mysteryCard': 'urn:li:x:1' } }] },
    ];
    const r = parsePeople(odd);
    if (!r.ok) throw new Error(r.message);
    expect(r.unknownTypes).toEqual({ '*mysteryCard': 1 });
  });
});

describe('the filter list', () => {
  // 18 filters arrive; one (resultType) only switches to another kind of
  // search. The other 17 are knobs, including free-text and look-up ones
  // that carry no options.
  test('every people filter, with its options, ids and counts', () => {
    const r = parsePeopleFilters(PAGE);
    if (!r.ok) throw new Error(r.message);
    expect(r.filters.map((f) => f.key)).toEqual([
      'network',
      'activelyHiringForJobTitles',
      'geoUrn',
      'currentCompany',
      'connectionOf',
      'followerOf',
      'pastCompany',
      'schoolFilter',
      'industry',
      'profileLanguage',
      'openToVolunteer',
      'serviceCategory',
      'firstName',
      'lastName',
      'title',
      'company',
      'schoolFreetext',
    ]);
    const school = r.filters.find((f) => f.key === 'schoolFilter');
    expect(school).toMatchObject({ label: 'School', input: 'select', lookup: 'SCHOOL' });
    expect(school?.options).toContainEqual({
      value: '15978',
      label: 'Budapest University of Technology and Economics',
      count: 318,
    });
    expect(r.filters.find((f) => f.key === 'title')).toMatchObject({ input: 'text', options: [] });
  });

  test('a page without a filter list is drift', () => {
    expect(parsePeopleFilters(PAGE50).ok).toBe(false);
  });
});

describe('names to ids', () => {
  test('a school search gives each school with its id', () => {
    const r = parseOrgHits(SCHOOLS);
    if (!r.ok) throw new Error(r.message);
    expect(r.hits[0]).toEqual({
      id: '15978',
      name: 'Budapest University of Technology and Economics',
    });
    expect(r.hits).toHaveLength(5);
  });
});

describe('friendly filter names', () => {
  test('map onto the parameters LinkedIn takes', () => {
    const r = peopleFilterSelection({
      network: ['1st', '2nd', '3rd+'],
      company: ['1035'],
      pastCompany: ['4972'],
      school: ['15978'],
      geo: ['104291169'],
      industry: ['4'],
      language: ['en'],
      service: ['602'],
      connectionOf: 'urn:li:fsd_profile:ACoAATESTPERSON1',
      followerOf: 'ACoAATESTPERSON2',
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'engineering manager',
      companyText: 'Microsoft',
      schoolText: 'ELTE',
      openToVolunteer: true,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.params).toEqual({
      network: ['F', 'S', 'O'],
      currentCompany: ['1035'],
      pastCompany: ['4972'],
      schoolFilter: ['15978'],
      geoUrn: ['104291169'],
      industry: ['4'],
      profileLanguage: ['en'],
      serviceCategory: ['602'],
      connectionOf: ['ACoAATESTPERSON1'],
      followerOf: ['ACoAATESTPERSON2'],
      firstName: ['Ada'],
      lastName: ['Lovelace'],
      title: ['engineering manager'],
      company: ['Microsoft'],
      schoolFreetext: ['ELTE'],
      openToVolunteer: ['true'],
    });
  });

  test('a raw key=value filter passes through', () => {
    const r = peopleFilterSelection({ raw: ['activelyHiringForJobTitles=-100'] });
    if (!r.ok) throw new Error(r.message);
    expect(r.params).toEqual({ activelyHiringForJobTitles: ['-100'] });
  });

  test('an unknown degree is refused with the ones that exist', () => {
    const r = peopleFilterSelection({ network: ['4th'] });
    if (r.ok) throw new Error('expected refusal');
    expect(r.message).toContain('3rd+');
  });

  test('a connection-of that is not a profile id is refused', () => {
    expect(peopleFilterSelection({ connectionOf: 'ada-lovelace' }).ok).toBe(false);
  });
});
