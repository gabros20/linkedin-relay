import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  jobCollectionUrl,
  jobInsightsUrl,
  parseJobCollection,
  parseJobInsights,
} from '../src/engine/job-premium.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

describe('the requests', () => {
  test('the top-applicant collection, as the collection page asks for it', () => {
    const url = decodeURIComponent(jobCollectionUrl('top-applicant', 100, 100));
    expect(url).toContain('queryId=voyagerJobsDashJobCards.');
    expect(url).toContain(
      'variables=(count:100,jobCollectionSlug:top-applicant,query:(origin:GENERIC_JOB_COLLECTIONS_LANDING),start:100)',
    );
  });

  test("a job's applicant and company insights, in one call", () => {
    const url = decodeURIComponent(jobInsightsUrl('4486910766'));
    expect(url).toContain('queryId=voyagerJobsDashJobPostingDetailSections.');
    expect(url).toContain(
      'cardSectionTypes:List(JOB_APPLICANT_INSIGHTS,COMPANY_INSIGHTS_CARD),jobPostingUrn:urn:li:fsd_jobPosting:4486910766',
    );
  });
});

describe('parseJobCollection', () => {
  // The fixture: the first 3 cards of 83, captured 2026-11-22.
  test('the cards, as job search reads them, and the total', () => {
    const r = parseJobCollection(fixture('job-collection-top-applicant.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.total).toBe(83);
    expect(r.jobs.map((j) => j.id)).toEqual(['4490422837', '4492738054', '4458162429']);
    expect(r.jobs[0]).toMatchObject({
      title: 'Senior Full Stack Developer (Angular / Java)',
      easyApply: true,
      insights: ['Actively reviewing applicants'],
    });
    expect(r.unknownTypes).toEqual({});
  });

  test('a collection LinkedIn would not serve is a failure, not an empty list', () => {
    const refused = {
      data: {
        data: { jobsDashJobCardsByJobCollections: null },
        errors: [{ message: 'downstream' }],
      },
    };
    expect(parseJobCollection(refused)).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});

describe('parseJobInsights', () => {
  const r = parseJobInsights(fixture('job-premium-insights.json'));

  test('who applied: how many, in the last day, their seniority and education', () => {
    if (!r.ok) throw new Error(r.message);
    expect(r.applicants).toEqual({
      total: 38,
      lastDay: 0,
      seniority: [
        { level: 'Entry', share: 67, count: 18 },
        { level: 'Senior', share: 15, count: 4 },
        { level: 'Manager', share: 4, count: 1 },
      ],
      education: [
        { degree: "Master's Degree", share: 26 },
        { degree: "Bachelor's Degree", share: 22 },
        { degree: 'Master of Science', share: 15 },
      ],
    });
  });

  test('the company: headcount over two years, the function, and what LinkedIn says of it', () => {
    if (!r.ok) throw new Error(r.message);
    const c = r.company;
    expect(c?.name).toBe('Citi');
    expect(c?.headcount).toMatchObject({ asOf: '2026-11', now: 191057 });
    expect(c?.headcount?.yearAgo).toBeNumber();
    expect(c?.headcount?.growth1y).toBeNumber();
    expect(c?.function).toMatchObject({ name: 'Information Technology', now: 300 });
    expect(c?.medianTenure).toContain('years');
    expect(c?.competitors?.map((x) => x.name)).toEqual([
      'Bank of America',
      'HSBC',
      'JPMorganChase',
    ]);
    expect(c?.competitors?.[0]).toEqual({
      name: 'Bank of America',
      industry: 'Banking',
      url: 'https://www.linkedin.com/company/bank-of-america/',
    });
    expect(c?.hiring).toBeString();
    expect(c?.priorities).toBeString();
    expect(c?.landscape).toBeString();
    expect(r.unknownSections).toEqual({});
  });

  test('neither section (no Premium) reads as none, not drift', () => {
    const none = {
      data: { data: { jobsDashJobPostingDetailSectionsByCardSectionTypes: { elements: [] } } },
      included: [],
    };
    expect(parseJobInsights(none)).toEqual({ ok: true, unknownSections: {} });
  });

  test('no section list at all is drift', () => {
    expect(parseJobInsights({ data: {} })).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
