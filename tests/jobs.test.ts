import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  jobDetailUrl,
  jobFilterSelection,
  jobFiltersUrl,
  jobIdOf,
  jobSearchUrl,
  parseJobCards,
  parseJobDetail,
  parseJobFilters,
} from '../src/engine/jobs.ts';

// Captured 2026-10-14 from the classic job search the jobs page still runs on:
// one page of "frontend developer" in the EU (remote, past week, mid-senior),
// one page 2 of "react" by a typed location, the detail of an external-apply
// and of an Easy Apply job, and the filter list for "frontend developer".
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const CARDS = fixture('jobs-cards.json');
const LOCATED = fixture('jobs-cards-located.json');
const OFFSITE = fixture('job-detail-offsite.json');
const EASY = fixture('job-detail-easy.json');
const FILTERS = fixture('jobs-filters.json');

const query = (url: string) => decodeURIComponent(new URL(url).searchParams.get('query') ?? '');

describe('the search request', () => {
  test('keywords, a typed location, filters and the page all reach the query', () => {
    const url = jobSearchUrl({
      keywords: 'frontend developer',
      location: 'Vienna, Austria',
      filters: { workplaceType: ['2', '3'], timePostedRange: ['r604800'] },
      start: 25,
      count: 25,
    });
    const u = new URL(url);
    expect(u.pathname).toBe('/voyager/api/voyagerJobsDashJobCards');
    expect(u.searchParams.get('start')).toBe('25');
    expect(u.searchParams.get('count')).toBe('25');
    expect(query(url)).toContain('keywords:frontend developer');
    // The comma in the place name is escaped, not a tuple separator.
    expect(url).toContain('location:Vienna%2C%20Austria');
    expect(query(url)).toContain(
      'selectedFilters:(workplaceType:List(2,3),timePostedRange:List(r604800))',
    );
  });

  test('a geo id is sent as one, in place of a typed location', () => {
    const url = jobSearchUrl({ geoId: '104291169', filters: {}, start: 0, count: 25 });
    expect(query(url)).toContain('locationUnion:(geoId:104291169)');
    expect(query(url)).not.toContain('keywords');
  });

  test('the filter list is asked for the same query', () => {
    const url = jobFiltersUrl({ keywords: 'react', filters: {}, start: 0, count: 25 });
    expect(new URL(url).pathname).toBe('/voyager/api/voyagerJobsDashSearchFilterClustersResource');
    expect(query(url)).toContain('keywords:react');
  });

  test('a job is read by its id', () => {
    expect(jobDetailUrl('4477825502')).toContain('/voyager/api/jobs/jobPostings/4477825502?');
  });
});

describe('job ids', () => {
  test('come from a bare id, a job URL, a search URL or a urn', () => {
    expect(jobIdOf('4477825502')).toBe('4477825502');
    expect(jobIdOf('https://www.linkedin.com/jobs/view/4477825502/?trk=x')).toBe('4477825502');
    expect(jobIdOf('https://www.linkedin.com/jobs/search/?currentJobId=4477825502&k=1')).toBe(
      '4477825502',
    );
    expect(jobIdOf('urn:li:fsd_jobPosting:4477825502')).toBe('4477825502');
    expect(jobIdOf('frontend')).toBeUndefined();
  });
});

describe('a page of results', () => {
  // This page has 25 job cards; the parser emits 25.
  test('every card becomes one flat job', () => {
    const r = parseJobCards(CARDS);
    if (!r.ok) throw new Error(r.message);
    expect(r.jobs).toHaveLength(25);
    expect(r.total).toBe(295);
    expect(r.jobs[0]).toEqual({
      id: '4475432390',
      title: 'Frontend Developer (Remote)',
      company: 'laiout',
      location: 'Poland',
      workplace: 'remote',
      listed: new Date(1791375031000).toISOString().slice(0, 10),
      easyApply: true,
      promoted: true,
      url: 'https://www.linkedin.com/jobs/view/4475432390/',
    });
  });

  test('salary and insight lines are kept when a card has them', () => {
    const r = parseJobCards(CARDS);
    if (!r.ok) throw new Error(r.message);
    expect(r.jobs.some((j) => typeof j.salary === 'string')).toBe(true);
    expect(r.jobs.filter((j) => j.easyApply)).toHaveLength(10);
  });

  test('a typed location is reported as the place LinkedIn resolved it to', () => {
    const r = parseJobCards(LOCATED);
    if (!r.ok) throw new Error(r.message);
    expect(r.location).toEqual({ geoId: expect.any(String), name: 'Hungary' });
    expect(r.total).toBe(183);
    expect(r.start).toBe(25);
    expect(r.jobs).toHaveLength(25);
  });

  test('cards that cannot be found in the response are drift, not an empty page', () => {
    const r = parseJobCards({ ...CARDS, included: [] });
    expect(r.ok).toBe(false);
  });

  test('a claimed total with no cards before it is a failed fetch', () => {
    const r = parseJobCards({
      data: { elements: [], paging: { total: 40, start: 0, count: 25 } },
      included: [],
    });
    expect(r.ok).toBe(false);
  });

  test('past the end is a genuine empty page', () => {
    const r = parseJobCards({
      data: { elements: [], paging: { total: 40, start: 50, count: 25 } },
      included: [],
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.jobs).toEqual([]);
  });

  test('an unknown card kind is counted, not dropped silently', () => {
    const r = parseJobCards({
      ...CARDS,
      data: {
        ...CARDS.data,
        elements: [...CARDS.data.elements, { jobCardUnion: { promoBanner: {} } }],
      },
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.unknownTypes).toEqual({ promoBanner: 1 });
  });
});

describe('a job', () => {
  test('an external application carries the employer link', () => {
    const r = parseJobDetail(OFFSITE);
    if (!r.ok) throw new Error(r.message);
    expect(r.job).toMatchObject({
      id: '4477825502',
      title: 'Frontend Software Engineer',
      company: 'CD PROJEKT RED',
      companyUrl: 'https://www.linkedin.com/company/cd-projekt-red',
      location: 'Warsaw, Mazowieckie, Poland',
      employmentType: 'Full-time',
      apply: {
        type: 'external',
        url: 'https://jobs.smartrecruiters.com/CDPROJEKTRED/744000154653787-frontend-software-engineer',
      },
      ats: 'SmartRecruiters',
      state: 'LISTED',
      applied: false,
      saved: false,
      url: 'https://www.linkedin.com/jobs/view/4477825502/',
    });
    expect(r.job.industries).toEqual(['Computer Games']);
    expect(r.job.listed).toBe(new Date(1791563411000).toISOString().slice(0, 10));
    expect(r.job.description?.length).toBeGreaterThan(500);
  });

  test('an Easy Apply job carries the LinkedIn apply link and its workplace', () => {
    const r = parseJobDetail(EASY);
    if (!r.ok) throw new Error(r.message);
    expect(r.job.apply).toEqual({
      type: 'easy-apply',
      url: 'https://www.linkedin.com/job-apply/4440791718',
    });
    expect(r.job.workplace).toBe('remote');
  });

  test('a response without a posting is drift', () => {
    expect(parseJobDetail({ data: {} }).ok).toBe(false);
  });
});

describe('the filter list', () => {
  // 24 filters arrive (the quick bar repeats the full list); 18 are distinct
  // and carry options, and one is an empty upsell placeholder.
  test('each filter once, with its options, ids and counts', () => {
    const r = parseJobFilters(FILTERS);
    if (!r.ok) throw new Error(r.message);
    expect(r.filters).toHaveLength(18);
    const exp = r.filters.find((f) => f.key === 'experience');
    expect(exp).toMatchObject({ label: 'Experience level' });
    expect(exp?.options).toContainEqual({ value: '4', label: 'Mid-Senior level', count: 1866 });
    expect(r.filters.find((f) => f.key === 'placeholder_upsell')).toBeUndefined();
  });

  test('a response without filters is drift', () => {
    expect(parseJobFilters({ data: { elements: [] } }).ok).toBe(false);
  });
});

describe('friendly filter names', () => {
  test('map onto the parameters LinkedIn takes', () => {
    const r = jobFilterSelection({
      posted: 'week',
      experience: ['entry', 'mid-senior'],
      type: ['full-time', 'contract'],
      workplace: ['remote', 'hybrid'],
      easyApply: true,
      under10: true,
      verified: true,
      inNetwork: true,
      fairChance: true,
      company: ['1035'],
      sort: 'recent',
      distance: 25,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.filters).toEqual({
      timePostedRange: ['r604800'],
      experience: ['2', '4'],
      jobType: ['F', 'C'],
      workplaceType: ['2', '3'],
      applyWithLinkedin: ['true'],
      earlyApplicant: ['true'],
      verifiedJob: ['true'],
      jobInYourNetwork: ['true'],
      fairChanceEmployer: ['true'],
      company: ['1035'],
      sortBy: ['DD'],
      distance: ['25'],
    });
  });

  test('a posted window can be any number of hours or days', () => {
    const r = jobFilterSelection({ posted: '3d' });
    if (!r.ok) throw new Error(r.message);
    expect(r.filters.timePostedRange).toEqual(['r259200']);
  });

  test('a raw key=value filter passes through, for anything without a name', () => {
    const r = jobFilterSelection({ raw: ['industry=4,96', 'benefits=1'] });
    if (!r.ok) throw new Error(r.message);
    expect(r.filters).toEqual({ industry: ['4', '96'], benefits: ['1'] });
  });

  test('an unknown value is refused with the ones that exist', () => {
    const r = jobFilterSelection({ experience: ['wizard'] });
    if (r.ok) throw new Error('expected refusal');
    expect(r.message).toContain('mid-senior');
  });
});
