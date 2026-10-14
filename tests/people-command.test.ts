import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PeopleFetch, runPeople, runPeopleFilters } from '../src/commands/people.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const PAGE = fixture('people-page.json');
const PAGE50 = fixture('people-page-50.json');
const SCHOOLS = fixture('people-schools.json');
const LOCATED = fixture('jobs-cards-located.json');

type Fetch = (url: string, spendClass: string) => ReturnType<PeopleFetch>;

/**
 * A fake people search. Behind it is one endless list of people, stitched
 * from shifted copies of the captured 50-person page so every position has
 * its own id. Each keyword reads it from its own `offset`. LinkedIn pages
 * `served` of them and claims `claimed`.
 */
function linkedin(
  opts: {
    served?: number;
    claimed?: number;
    offsets?: Record<string, number>;
    fails?: string[];
  } = {},
) {
  const served = opts.served ?? 1000;
  const asked: { url: string; spendClass: string; vars: string }[] = [];
  const results = (
    PAGE50.data.data.searchDashClustersByAll.elements as {
      items: { item: Record<string, unknown> }[];
    }[]
  )
    .flatMap((e) => e.items)
    .filter((i) => typeof i.item['*entityResult'] === 'string');
  const block = (n: number) =>
    JSON.parse(
      JSON.stringify({ items: results, included: PAGE50.included }).replace(
        /ACoAATESTPERSON(\d+)/g,
        (_, id) => `ACoAATESTPERSON${id}x${n}`,
      ),
    );
  const fetch: Fetch = async (url, spendClass) => {
    const u = new URL(url);
    const vars = decodeURIComponent(
      u.searchParams.get('variables') ?? u.searchParams.get('query') ?? '',
    );
    asked.push({ url, spendClass, vars });
    if (u.pathname.includes('voyagerJobsDashJobCards')) return { ok: true, json: LOCATED };
    if (/List\((SCHOOLS|COMPANIES)\)/.test(vars)) return { ok: true, json: SCHOOLS };
    if (vars.includes('includeFiltersInResponse:true')) return { ok: true, json: PAGE };
    const keywords = vars.match(/keywords:([^,)]*)/)?.[1];
    if (keywords !== undefined && opts.fails?.includes(keywords))
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'search budget spent' };
    const start = Number(vars.match(/start:(\d+)/)?.[1]);
    const offset = (keywords !== undefined ? opts.offsets?.[keywords] : undefined) ?? 0;
    const size = Math.max(0, Math.min(50, served - start));
    const items: unknown[] = [];
    const included: unknown[] = [];
    const used = new Set<number>();
    for (let p = start + offset; p < start + offset + size; p++) {
      const n = Math.floor(p / 50);
      const b = block(n);
      items.push(b.items[p % 50]);
      if (!used.has(n)) included.push(...b.included);
      used.add(n);
    }
    const d = PAGE50.data.data.searchDashClustersByAll;
    return {
      ok: true,
      json: {
        data: {
          data: {
            searchDashClustersByAll: {
              ...d,
              elements: [{ items }],
              paging: { start, count: 50, total: served },
              metadata: { ...d.metadata, totalResultCount: opts.claimed ?? served },
            },
          },
        },
        included,
      },
    };
  };
  return { fetch: fetch as PeopleFetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runPeople>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as {
    items: Record<string, unknown>[];
    meta: Record<string, unknown>;
    resolved?: Record<string, unknown>;
  };
};

describe('lnrelay people', () => {
  test('asks for 50 a call, pages to the limit, on the search budget', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runPeople({ keywords: 'engineer', limit: 120 }, {}, fetch));
    expect(r.items).toHaveLength(120);
    expect(asked.map((a) => a.vars.match(/start:(\d+),count:(\d+)/)?.slice(1))).toEqual([
      ['0', '50'],
      ['50', '50'],
      ['100', '50'],
    ]);
    expect(asked.every((a) => a.spendClass === 'search')).toBe(true);
    expect(r.meta).toMatchObject({ state: 'partial', returnedCount: 120, next: 120 });
  });

  test('reaching the 1000 LinkedIn serves, while it claims more, is partial and says so', async () => {
    const { fetch } = linkedin({ served: 100, claimed: 43013 });
    const r = data(await runPeople({ keywords: 'engineer', limit: 500 }, {}, fetch));
    expect(r.items).toHaveLength(100);
    expect(r.meta).toMatchObject({ state: 'partial', claimedCount: 43013, servedLimit: 100 });
    expect(r.meta.next).toBeUndefined();
  });

  test('a search that ends before the limit is complete', async () => {
    const { fetch } = linkedin({ served: 70 });
    const r = data(await runPeople({ keywords: 'engineer', limit: 500 }, {}, fetch));
    expect(r.items).toHaveLength(70);
    expect(r.meta.state).toBe('complete');
  });

  test('company and school names are looked up, and the choice is reported', async () => {
    const { fetch, asked } = linkedin();
    const r = data(
      await runPeople(
        {
          keywords: 'engineer',
          limit: 5,
          filter: { company: ['Budapest University', '1035'], school: ['BME'] },
        },
        {},
        fetch,
      ),
    );
    const lookups = asked.filter((a) => /List\((COMPANIES|SCHOOLS)\)/.test(a.vars));
    expect(lookups.map((a) => a.vars.match(/List\((COMPANIES|SCHOOLS)\)/)?.[1])).toEqual([
      'COMPANIES',
      'SCHOOLS',
    ]);
    const search = asked.at(-1)?.vars ?? '';
    expect(search).toContain('(key:currentCompany,value:List(15978,1035))');
    expect(search).toContain('(key:schoolFilter,value:List(15978))');
    expect(r.resolved).toEqual({
      company: [
        {
          given: 'Budapest University',
          id: '15978',
          name: 'Budapest University of Technology and Economics',
        },
      ],
      school: [
        { given: 'BME', id: '15978', name: 'Budapest University of Technology and Economics' },
      ],
    });
  });

  test('a place is looked up and its geo id used', async () => {
    const { fetch, asked } = linkedin();
    const r = data(
      await runPeople({ keywords: 'engineer', limit: 5, location: 'Hungary' }, {}, fetch),
    );
    expect(asked.at(-1)?.vars).toMatch(/\(key:geoUrn,value:List\(\d+\)\)/);
    expect(r.resolved?.location).toMatchObject({ given: 'Hungary', name: 'Hungary' });
  });

  test('several keyword sets are merged by person, saying which found whom', async () => {
    const { fetch } = linkedin({ served: 60, offsets: { frontend: 0, react: 30 } });
    const r = data(await runPeople({ keywords: ['frontend', 'react'], limit: 100 }, {}, fetch));
    expect(r.items).toHaveLength(90);
    expect(r.meta).toMatchObject({ duplicates: 30, returnedCount: 90 });
    expect(r.items[0]?.matched).toEqual(['frontend', 'react']);
  });

  test('filters alone are a search; nothing at all is refused', async () => {
    const { fetch } = linkedin();
    const ok = await runPeople(
      { limit: 5, filter: { connectionOf: 'ACoAATESTPERSON1' } },
      {},
      fetch,
    );
    expect(ok.ok).toBe(true);
    const none = await runPeople({ limit: 5 }, {}, fetch);
    expect(none.ok).toBe(false);
  });

  test('a name that matches nothing is refused before the search', async () => {
    const { fetch, asked } = linkedin();
    const empty: PeopleFetch = async (url, cls) => {
      if (/List\(COMPANIES\)/.test(decodeURIComponent(url)))
        return {
          ok: true,
          json: { data: { data: { searchDashClustersByAll: { elements: [] } } }, included: [] },
        };
      return fetch(url, cls);
    };
    const r = await runPeople(
      { keywords: 'x', limit: 5, filter: { company: ['Nowhere Ltd'] } },
      {},
      empty,
    );
    expect(r.ok).toBe(false);
    expect(asked.some((a) => a.vars.includes('List(PEOPLE)'))).toBe(false);
  });

  test('--compact is one line per person, id first', async () => {
    const r = data(
      await runPeople({ keywords: 'x', limit: 3 }, { compact: true }, linkedin().fetch),
    );
    expect(String(r.items[1])).toMatch(
      /^ACoAATESTPERSON\w+ \| Person \d+ \| Headline \d+ \| .+ \| 3rd\+/,
    );
  });
});

describe('lnrelay people-filters', () => {
  test('every people filter for the query, with ids and counts', async () => {
    const r = await runPeopleFilters({ keywords: 'frontend developer' }, {}, linkedin().fetch);
    if (!r.ok) throw new Error(r.error.message);
    const d = r.data as { items: { key: string }[]; meta: { returnedCount: number } };
    expect(d.meta.returnedCount).toBe(17);
    expect(d.items.map((f) => f.key)).toContain('currentCompany');
  });

  test('takes one keyword set only', async () => {
    const r = await runPeopleFilters({ keywords: ['a', 'b'] }, {}, linkedin().fetch);
    expect(r.ok).toBe(false);
  });
});

describe('people flags', () => {
  test('every knob is read from the command line', async () => {
    const { parseArgs } = await import('../src/args.ts');
    const { peopleRequest } = await import('../src/cli.ts');
    const req = peopleRequest(
      parseArgs([
        'people',
        'frontend',
        'react developer',
        '--network',
        '1st,2nd',
        '--company',
        'Ernst & Young, LLP',
        '--company',
        '1035,1441',
        '--past-company',
        '4972',
        '--school',
        'ELTE',
        '--location',
        'Budapest',
        '--geo',
        '104291169',
        '--industry',
        '4,96',
        '--language',
        'en',
        '--service',
        '602',
        '--connection-of',
        'ACoAATESTPERSON1',
        '--follower-of',
        'ACoAATESTPERSON2',
        '--first-name',
        'Ada',
        '--last-name',
        'Lovelace',
        '--title',
        'engineering manager',
        '--company-text',
        'Microsoft',
        '--school-text',
        'BME',
        '--open-to-volunteer',
        '--filter',
        'activelyHiringForJobTitles=-100',
        '--limit',
        '200',
        '--start',
        '50',
      ]),
    );
    expect(req).toEqual({
      keywords: ['frontend', 'react developer'],
      location: 'Budapest',
      limit: 200,
      start: 50,
      filter: {
        network: ['1st', '2nd'],
        // Names keep their commas; only all-numeric lists split.
        company: ['Ernst & Young, LLP', '1035', '1441'],
        pastCompany: ['4972'],
        school: ['ELTE'],
        geo: ['104291169'],
        industry: ['4', '96'],
        language: ['en'],
        service: ['602'],
        connectionOf: 'ACoAATESTPERSON1',
        followerOf: 'ACoAATESTPERSON2',
        firstName: 'Ada',
        lastName: 'Lovelace',
        title: 'engineering manager',
        companyText: 'Microsoft',
        schoolText: 'BME',
        openToVolunteer: true,
        raw: ['activelyHiringForJobTitles=-100'],
      },
    });
  });
});
