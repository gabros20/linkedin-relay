import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type JobsFetch, runJob, runJobFilters, runJobs } from '../src/commands/jobs.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const CARDS = fixture('jobs-cards.json');
const OFFSITE = fixture('job-detail-offsite.json');
const FILTERS = fixture('jobs-filters.json');

/** Serves the captured page for every start, shifted so ids stay distinct. */
function linkedin(opts: { total?: number; failAt?: number } = {}) {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: JobsFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    const u = new URL(url);
    if (u.pathname.includes('jobPostings')) return { ok: true, json: OFFSITE };
    if (u.pathname.includes('FilterClusters')) return { ok: true, json: FILTERS };
    const start = Number(u.searchParams.get('start'));
    if (opts.failAt !== undefined && start >= opts.failAt)
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'search budget spent' };
    const shift = (s: string) =>
      s.replace(/(jobPosting(?:Card)?:\(?)(\d+)/g, (_, p, id) => `${p}${Number(id) + start}`);
    const json = JSON.parse(shift(JSON.stringify(CARDS)));
    json.data.paging = { ...json.data.paging, start, total: opts.total ?? 295 };
    return { ok: true, json };
  };
  return { fetch, asked };
}

const items = (e: Awaited<ReturnType<typeof runJobs>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as { items: Record<string, unknown>[]; meta: Record<string, unknown> };
};

describe('lnrelay jobs', () => {
  test('pages until the limit and says the list is partial', async () => {
    const { fetch, asked } = linkedin();
    const r = items(await runJobs({ keywords: 'frontend', limit: 30 }, {}, fetch));
    expect(r.items).toHaveLength(30);
    expect(asked.map((a) => new URL(a.url).searchParams.get('start'))).toEqual(['0', '25']);
    expect(asked.every((a) => a.spendClass === 'search')).toBe(true);
    expect(r.meta).toMatchObject({ state: 'partial', claimedCount: 295, returnedCount: 30 });
  });

  test('stops at the end of the results and says the list is complete', async () => {
    const { fetch, asked } = linkedin({ total: 40 });
    const r = items(await runJobs({ keywords: 'frontend', limit: 100 }, {}, fetch));
    expect(asked).toHaveLength(2);
    expect(r.items).toHaveLength(50);
    expect(r.meta.state).toBe('complete');
  });

  test('a later page failing keeps what arrived, marked partial with the reason', async () => {
    const { fetch } = linkedin({ failAt: 25 });
    const r = items(await runJobs({ keywords: 'frontend', limit: 50 }, {}, fetch));
    expect(r.items).toHaveLength(25);
    expect(r.meta).toMatchObject({ state: 'partial', stoppedBy: 'BUDGET_EXHAUSTED' });
  });

  test('the first page failing is a failure, not an empty list', async () => {
    const { fetch } = linkedin({ failAt: 0 });
    const r = await runJobs({ keywords: 'frontend', limit: 10 }, {}, fetch);
    expect(r.ok).toBe(false);
  });

  test('friendly filters reach the query; a bad one is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    await runJobs(
      { keywords: 'x', limit: 5, filter: { workplace: ['remote'], posted: 'week' } },
      {},
      fetch,
    );
    expect(decodeURIComponent(asked[0]?.url ?? '')).toContain(
      'selectedFilters:(timePostedRange:List(r604800),workplaceType:List(2))',
    );
    const bad = await runJobs(
      { keywords: 'x', limit: 5, filter: { workplace: ['moon'] } },
      {},
      fetch,
    );
    expect(bad.ok).toBe(false);
    expect(asked).toHaveLength(1);
  });

  test('nothing to search for is refused', async () => {
    const r = await runJobs({ limit: 5 }, {}, linkedin().fetch);
    expect(r.ok).toBe(false);
  });

  test('--details reads each job for its apply link, on the profile budget', async () => {
    const { fetch, asked } = linkedin();
    const r = items(await runJobs({ keywords: 'x', limit: 2, details: true }, {}, fetch));
    expect(asked.filter((a) => a.spendClass === 'profile')).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      apply: { type: 'external' },
      employmentType: 'Full-time',
    });
    expect(r.items[0]?.description).toBeUndefined();
  });

  test('--compact is one line per job, id first', async () => {
    const r = items(
      await runJobs({ keywords: 'x', limit: 2 }, { compact: true }, linkedin().fetch),
    );
    expect(r.items[0]).toBe(
      '4475432390 | Frontend Developer (Remote) | laiout | Poland | remote | ' +
        `${new Date(1791375031000).toISOString().slice(0, 10)} | easy apply | promoted`,
    );
  });

  test('--compact keeps its columns when a title has a bar in it', async () => {
    const { fetch } = linkedin();
    const barred: JobsFetch = async (url, cls) => {
      const r = await fetch(url, cls);
      if (!r.ok) return r;
      return {
        ok: true,
        json: JSON.parse(
          JSON.stringify(r.json).replaceAll('Frontend Developer (Remote)', 'Dev | Hungary'),
        ),
      };
    };
    const r = items(await runJobs({ keywords: 'x', limit: 1 }, { compact: true }, barred));
    expect(String(r.items[0]).split(' | ')[1]).toBe('Dev / Hungary');
  });

  test('--fields keeps only the named fields', async () => {
    const r = items(
      await runJobs({ keywords: 'x', limit: 1 }, { fields: 'id,url' }, linkedin().fetch),
    );
    expect(r.items[0]).toEqual({
      id: '4475432390',
      url: 'https://www.linkedin.com/jobs/view/4475432390/',
    });
  });
});

describe('lnrelay job', () => {
  test('reads one job, with its description and apply link', async () => {
    const { fetch, asked } = linkedin();
    const r = await runJob('https://www.linkedin.com/jobs/view/4477825502/', {}, fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(asked[0]?.spendClass).toBe('profile');
    expect(r.data).toMatchObject({ id: '4477825502', apply: { type: 'external' } });
    expect((r.data as { description: string }).description.length).toBeGreaterThan(500);
  });

  test('something that is not a job is refused', async () => {
    const r = await runJob('frontend', {}, linkedin().fetch);
    expect(r.ok).toBe(false);
  });
});

describe('lnrelay job-filters', () => {
  test('lists every filter with the values --filter takes', async () => {
    const r = await runJobFilters({ keywords: 'frontend' }, {}, linkedin().fetch);
    if (!r.ok) throw new Error(r.error.message);
    const d = r.data as { items: { key: string }[]; meta: { returnedCount: number } };
    expect(d.items.map((f) => f.key)).toContain('industry');
    expect(d.meta.returnedCount).toBe(18);
  });
});

describe('jobs flags', () => {
  test('every knob is read from the command line; lists split on commas or repeat', async () => {
    const { parseArgs } = await import('../src/args.ts');
    const { jobsRequest } = await import('../src/cli.ts');
    const req = jobsRequest(
      parseArgs([
        'jobs',
        'react developer',
        '--location',
        'Budapest',
        '--distance',
        '25',
        '--posted',
        'week',
        '--experience',
        'entry,mid-senior',
        '--type',
        'full-time',
        '--workplace',
        'remote',
        '--workplace',
        'hybrid',
        '--easy-apply',
        '--under-10',
        '--verified',
        '--in-network',
        '--fair-chance',
        '--company',
        '1035,1441',
        '--industry',
        '4',
        '--function',
        'it',
        '--title',
        '3172',
        '--place',
        '104291169',
        '--filter',
        'benefits=1,2',
        '--sort',
        'recent',
        '--limit',
        '60',
        '--start',
        '25',
        '--details',
        '--description',
      ]),
    );
    expect(req).toEqual({
      keywords: 'react developer',
      location: 'Budapest',
      limit: 60,
      start: 25,
      details: true,
      description: true,
      filter: {
        distance: 25,
        posted: 'week',
        experience: ['entry', 'mid-senior'],
        type: ['full-time'],
        workplace: ['remote', 'hybrid'],
        easyApply: true,
        under10: true,
        verified: true,
        inNetwork: true,
        fairChance: true,
        company: ['1035', '1441'],
        industry: ['4'],
        function: ['it'],
        title: ['3172'],
        place: ['104291169'],
        raw: ['benefits=1,2'],
        sort: 'recent',
      },
    });
  });

  test('defaults: 25 results from the top, no details, no filters', async () => {
    const { parseArgs } = await import('../src/args.ts');
    const { jobsRequest } = await import('../src/cli.ts');
    expect(jobsRequest(parseArgs(['jobs', 'rust']))).toEqual({
      keywords: 'rust',
      limit: 25,
      filter: {},
    });
  });
});
