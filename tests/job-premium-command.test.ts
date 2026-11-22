import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type JobsFetch, runJob, runJobs } from '../src/commands/jobs.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const COLLECTION = fixture('job-collection-top-applicant.json');
const INSIGHTS = fixture('job-premium-insights.json');
const OFFSITE = fixture('job-detail-offsite.json');

function linkedin(fails: string[] = []) {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: JobsFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    const which = url.includes('jobCollectionSlug')
      ? 'collection'
      : url.includes('JOB_APPLICANT_INSIGHTS')
        ? 'insights'
        : 'job';
    if (fails.includes(which)) return { ok: false, code: 'FETCH_FAILED', message: '500' };
    const json = { collection: COLLECTION, insights: INSIGHTS, job: OFFSITE }[which];
    return { ok: true, json };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runJobs>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as Record<string, unknown> & {
    items: Record<string, unknown>[];
    meta: Record<string, unknown>;
  };
};

describe('lnrelay jobs --top-applicant', () => {
  test('the collection, no keywords needed, one job-search call', async () => {
    const { fetch, asked } = linkedin();
    const d = data(await runJobs({ collection: 'top-applicant', limit: 25 }, {}, fetch));
    expect(asked.map((a) => a.spendClass)).toEqual(['jobSearch']);
    expect(decodeURIComponent(asked[0]?.url ?? '')).toContain('jobCollectionSlug:top-applicant');
    expect(d.collection).toBe('top-applicant');
    expect(d.items.map((j) => j.id)).toEqual(['4490422837', '4492738054', '4458162429']);
    expect(d.meta).toMatchObject({ claimedCount: 83, returnedCount: 3 });
  });

  test('keywords or filters with a collection are refused: it takes none', async () => {
    const e = await runJobs(
      { collection: 'top-applicant', keywords: 'react', limit: 25 },
      {},
      linkedin().fetch,
    );
    expect(e).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  test('the collection failing is a failure', async () => {
    const e = await runJobs(
      { collection: 'top-applicant', limit: 25 },
      {},
      linkedin(['collection']).fetch,
    );
    expect(e.ok).toBe(false);
  });
});

describe('lnrelay job --insights', () => {
  test('the job, with its applicants and company insights, one more job read', async () => {
    const { fetch, asked } = linkedin();
    const e = await runJob('4486910766', {}, fetch, { insights: true });
    if (!e.ok) throw new Error(e.error.message);
    expect(asked.map((a) => a.spendClass)).toEqual(['jobRead', 'jobRead']);
    const job = e.data as { premium?: { applicants?: { total: number }; company?: object } };
    expect(job.premium?.applicants?.total).toBe(38);
    expect(job.premium?.company).toMatchObject({ name: 'Citi' });
  });

  test('insights that could not be read say so; the job is still returned', async () => {
    const e = await runJob('4486910766', {}, linkedin(['insights']).fetch, { insights: true });
    if (!e.ok) throw new Error(e.error.message);
    expect(e.data).toMatchObject({ premiumError: 'FETCH_FAILED: 500' });
  });
});

const RSC = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const BATCH = fixture('job-detail-batch.json');

/** The hear-back list: `pages` pages of card ids, then an empty page. */
function hearBack(pages: string[][], fails: string[] = []) {
  const asked: { url: string; spendClass: string; headers?: Record<string, string> }[] = [];
  const fetch: JobsFetch = async (url, spendClass, _body, headers) => {
    asked.push({ url, spendClass, ...(headers !== undefined ? { headers } : {}) });
    if (url.includes('search-results')) {
      if (fails.includes('list')) return { ok: false, code: 'FETCH_FAILED', message: '500' };
      const page = Number(new URL(url).searchParams.get('start')) / 25;
      const ids = pages[page] ?? [];
      return {
        ok: true,
        raw: ids.map((id, i) => `${i}:{"componentKey":"job-card-component-ref-${id}"}`).join('\n'),
      };
    }
    return { ok: true, json: BATCH };
  };
  return { fetch, asked };
}

describe('lnrelay jobs --hear-back', () => {
  test('pages the list 25 at a time until a short page, then reads the jobs', async () => {
    const full = Array.from({ length: 25 }, (_, i) => String(4479000000 + i));
    const last = ['4479054333', '4478000001'];
    const { fetch, asked } = hearBack([full, last]);
    const d = data(await runJobs({ collection: 'hear-back', limit: 100 }, {}, fetch));
    const pages = asked.filter((a) => a.url.includes('search-results'));
    expect(pages.map((a) => new URL(a.url).searchParams.get('start'))).toEqual(['0', '25']);
    expect(pages.every((a) => a.spendClass === 'jobSearch')).toBe(true);
    expect(pages[0]?.headers?.['x-li-rsc-stream']).toBe('true');
    expect(asked.filter((a) => a.spendClass === 'jobRead')).toHaveLength(1);
    expect(d.collection).toBe('hear-back');
    // 27 listed; the batch answers for one of them: the other 26 are named unread.
    expect(d.meta).toMatchObject({ state: 'partial', claimedCount: 27, returnedCount: 1 });
    expect(d.meta.unread).toHaveLength(26);
  });

  test('a short first page is the whole list: every job read, complete', async () => {
    const ids = [
      '4479098214',
      '4476087651',
      '4479054333',
      '4478384247',
      '4476411475',
      '4479007259',
      '4478760759',
      '4478153344',
      '4475432390',
      '4475218240',
    ];
    const d = data(
      await runJobs({ collection: 'hear-back', limit: 100 }, {}, hearBack([ids]).fetch),
    );
    expect(d.items.map((j) => j.id)).toEqual(ids);
    expect(d.meta).toMatchObject({ state: 'complete', claimedCount: 10, returnedCount: 10 });
  });

  test('the limit stops the paging and the list is partial', async () => {
    const full = Array.from({ length: 25 }, (_, i) => String(4479000000 + i));
    const { fetch, asked } = hearBack([full, full.map((id) => `${id}1`)]);
    const d = data(await runJobs({ collection: 'hear-back', limit: 10 }, {}, fetch));
    expect(asked.filter((a) => a.url.includes('search-results'))).toHaveLength(1);
    expect(d.meta).toMatchObject({ state: 'partial' });
  });

  test('the list failing is a failure', async () => {
    const e = await runJobs(
      { collection: 'hear-back', limit: 25 },
      {},
      hearBack([], ['list']).fetch,
    );
    expect(e.ok).toBe(false);
  });
});

/** The match: the job's link, the question, then the answer after `pending` polls. */
function assistant(pending = 0, fails: string[] = []) {
  const asked: { url: string; spendClass: string }[] = [];
  let polls = 0;
  const fetch: JobsFetch = async (url, spendClass, body) => {
    asked.push({ url, spendClass });
    if (url.includes('howYouFitGuide')) {
      if (fails.includes('link')) return { ok: true, raw: '0:null' };
      // The captured link is for job 4490422837; answer for the job asked about.
      const job = (body as { clientArguments: { payload: { jobId: string } } }).clientArguments
        .payload.jobId;
      return { ok: true, raw: RSC('job-how-you-fit.rsc').replaceAll('4490422837', job) };
    }
    if (url.includes('action=execute')) return { ok: true, json: fixture('job-match-sent.json') };
    if (url.includes('voyagerGuideDashBionicMessageV2')) {
      const answer = fixture('job-match-answer.json');
      if (polls++ < pending)
        for (const x of answer.included)
          if (x.responseV2) delete x.responseV2.streamingResponse.finalComponentPosition;
      return { ok: true, json: answer };
    }
    return { ok: true, json: OFFSITE };
  };
  return { fetch, asked };
}

describe('lnrelay job --match', () => {
  test("the job, with the assistant's match: verdict, met, missing, and its text", async () => {
    const { fetch, asked } = assistant(1);
    const e = await runJob('4490422837', {}, fetch, { match: true, pollMs: 0 });
    if (!e.ok) throw new Error(e.error.message);
    expect(e.data).toMatchObject({
      match: {
        summary: 'Job match is medium',
        met: ['Five years of web development.', 'Good written English.'],
        missing: ['Experience with Java. (No mention of Java)'],
      },
    });
    // the job, the link, the question, two polls
    expect(asked.map((a) => a.spendClass)).toEqual(['jobRead', 'page', 'page', 'page', 'page']);
  });

  test('a job without match details says why; the job is still returned', async () => {
    const e = await runJob('4490422837', {}, assistant(0, ['link']).fetch, {
      match: true,
      pollMs: 0,
    });
    if (!e.ok) throw new Error(e.error.message);
    expect((e.data as { matchError?: string }).matchError).toContain('NOT_FOUND');
  });

  test('an answer that never finishes stops waiting and says so', async () => {
    const e = await runJob('4490422837', {}, assistant(99).fetch, { match: true, pollMs: 0 });
    if (!e.ok) throw new Error(e.error.message);
    expect((e.data as { matchError?: string }).matchError).toContain('not finished');
  });
});
