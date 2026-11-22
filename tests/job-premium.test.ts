import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEAR_BACK_HEADERS,
  hearBackBody,
  hearBackUrl,
  jobCollectionUrl,
  jobInsightsUrl,
  matchAnswerUrl,
  matchMessageBody,
  parseJobCollection,
  parseJobIds,
  parseJobInsights,
  parseMatchAnswer,
  parseMatchLink,
  parseMatchSent,
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

describe('the hear-back list', () => {
  const stream = readFileSync(join(import.meta.dir, 'fixtures', 'jobs-hear-back.rsc'), 'utf-8');

  test('the page asks for its list in page data, 25 a page, by start', () => {
    expect(hearBackUrl(50)).toBe(
      'https://www.linkedin.com/flagship-web/jobs/search-results/?showHowYouFit=HOW_YOU_FIT&origin=QUALIFICATION_LANDING&start=50',
    );
    expect(HEAR_BACK_HEADERS['x-li-rsc-stream']).toBe('true');
    expect(hearBackBody().requestedArguments.payload.origin).toBe(
      'JobSearchOrigin_QUALIFICATION_LANDING',
    );
  });

  test('the job ids, in page order, each once', () => {
    expect(parseJobIds(stream)).toEqual({
      ok: true,
      ids: ['4476599932', '4426065909', '4484241937'],
    });
  });

  test('the page itself instead of its data is drift, not an empty list', () => {
    expect(parseJobIds('<!DOCTYPE html><html></html>')).toMatchObject({
      ok: false,
      code: 'SCHEMA_DRIFT',
    });
  });

  test('a page with no cards is an empty page: the end of the list', () => {
    expect(parseJobIds('0:["$","div",null,{}]\n')).toEqual({ ok: true, ids: [] });
  });
});

describe('the match', () => {
  const hyf = readFileSync(join(import.meta.dir, 'fixtures', 'job-how-you-fit.rsc'), 'utf-8');

  test("the job's match link: its question and the assistant's context, as LinkedIn wrote them", () => {
    const r = parseMatchLink(hyf, '4490422837');
    if (!r.ok) throw new Error(r.message);
    expect(r.link.query).toBe('Egyezés részleteinek megjelenítése');
    expect(r.link.contextUrns).toEqual([`urn:li:guide:${'ab12'.repeat(16)}`]);
    expect(r.link.mailbox).toBe('urn:li:guideJobs:ACoAATESTOWNER1');
    expect(r.link.customContext).toEqual([
      { key: 'jobPostingId', value: '4490422837' },
      { key: 'subIntent', value: 'JobSeekerAgentIntent_JOB_FIT_EXPLANATION' },
      { key: 'hasHistory', value: 'false' },
    ]);
  });

  test('no match link (no Premium, or another job) is a failure that says so', () => {
    expect(parseMatchLink('0:null', '4490422837')).toMatchObject({ ok: false });
  });

  test('the question, as the assistant overlay sends it', () => {
    const r = parseMatchLink(hyf, '4490422837');
    if (!r.ok) throw new Error(r.message);
    const body = matchMessageBody(r.link, '4490422837', { interaction: 'i', session: 's' });
    expect(body.variables.query).toBe('Egyezés részleteinek megjelenítése');
    expect(body.variables.guideQueryContext).toMatchObject({
      intent: 'GuideIntent_JOB_SEEKING_AGENT',
      contextUrns: r.link.contextUrns,
      originalThreadMailbox: 'urn:li:guideJobs:ACoAATESTOWNER1',
      pageContext: { jobPostingUrns: ['urn:li:fsd_jobPosting:4490422837'] },
    });
    expect(body.queryId).toContain('voyagerGuideDashMessage.');
  });

  test('the sent question names the conversation and the answer to wait for', () => {
    const r = parseMatchSent(fixture('job-match-sent.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.conversation).toStartWith('urn:li:fsu_guideConversationV2:urn:li:guide:');
    expect(r.response).toBe('urn:li:fsd_coachRealtimeResponse:hR7RFhxBoWFJuUFj68TQzg==');
    expect(decodeURIComponent(matchAnswerUrl(r.conversation))).toContain(
      `guideConversationV2Urn:${r.conversation},syncToken:null`,
    );
  });

  test('the answer: the verdict, its lines, and which qualifications are met', () => {
    const answer = fixture('job-match-answer.json');
    const r = parseMatchAnswer(answer, 'urn:li:fsd_coachRealtimeResponse:hR7RFhxBoWFJuUFj68TQzg==');
    expect(r).toEqual({
      ok: true,
      done: true,
      match: {
        summary: 'Job match is medium',
        met: ['Five years of web development.', 'Good written English.'],
        missing: ['Experience with Java. (No mention of Java)'],
        text: [
          'Your profile meets some of the required qualifications.',
          'Matches 2 of the 3 required qualifications:',
          '✓ Five years of web development.',
          '✓ Good written English.',
          '? Experience with Java. (No mention of Java)',
          'There are qualifications that will likely be evaluated in the interview:',
          '• Work authorisation in Hungary.',
        ].join('\n'),
      },
    });
  });

  test('an answer still being written is not done', () => {
    const answer = fixture('job-match-answer.json');
    for (const x of answer.included)
      if (x.responseV2) delete x.responseV2.streamingResponse.finalComponentPosition;
    expect(
      parseMatchAnswer(answer, 'urn:li:fsd_coachRealtimeResponse:hR7RFhxBoWFJuUFj68TQzg=='),
    ).toEqual({
      ok: true,
      done: false,
    });
  });
});
