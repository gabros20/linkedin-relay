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
