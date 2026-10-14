import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PeopleFetch } from '../src/commands/people.ts';
import { runFind, runFindFilters } from '../src/commands/search-kinds.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const LOCATED = fixture('jobs-cards-located.json');
const BY_TYPE: Record<string, string> = {
  COMPANIES: 'search-companies.json',
  GROUPS: 'search-groups.json',
  EVENTS: 'search-events.json',
  LEARNING: 'search-courses.json',
  PRODUCTS: 'search-products.json',
  SERVICES: 'search-services.json',
  SCHOOLS: 'search-schools.json',
};

/** Serves each kind's captured page; a place is looked up through the job search. */
function linkedin() {
  const asked: { url: string; spendClass: string; vars: string }[] = [];
  const fetch: PeopleFetch = async (url, spendClass) => {
    const u = new URL(url);
    const vars = decodeURIComponent(
      u.searchParams.get('variables') ?? u.searchParams.get('query') ?? '',
    );
    asked.push({ url, spendClass, vars });
    if (u.pathname.includes('voyagerJobsDashJobCards')) return { ok: true, json: LOCATED };
    const type = vars.match(/key:resultType,value:List\((\w+)\)/)?.[1] ?? '';
    const json = fixture(BY_TYPE[type] as string);
    // One page holds everything this fixture has: say so, so paging stops.
    const c = json.data.data.searchDashClustersByAll;
    c.paging = { ...c.paging, start: 0, total: c.paging.total > 50 ? 50 : c.paging.total };
    return { ok: true, json };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runFind>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as {
    items: Record<string, unknown>[];
    meta: Record<string, unknown>;
    resolved?: unknown;
  };
};

describe('lnrelay search <kind>', () => {
  test('each kind asks for its own result type and returns flat rows', async () => {
    for (const kind of [
      'companies',
      'groups',
      'events',
      'courses',
      'products',
      'services',
      'schools',
    ] as const) {
      const { fetch, asked } = linkedin();
      const r = data(await runFind(kind, { keywords: 'ai', limit: 50 }, {}, fetch));
      expect(r.items.length).toBeGreaterThan(40);
      expect(asked[0]?.spendClass).toBe('search');
      expect(r.items[0]).toHaveProperty('id');
      expect(r.items[0]).toHaveProperty('name');
    }
  });

  test('--location is looked up and sent under the name the kind uses', async () => {
    const { fetch, asked } = linkedin();
    const r = data(
      await runFind('companies', { keywords: 'ai', limit: 5, location: 'Hungary' }, {}, fetch),
    );
    expect(asked.at(-1)?.vars).toMatch(/\(key:companyHqGeo,value:List\(\d+\)\)/);
    expect(r.resolved).toMatchObject({ location: { given: 'Hungary', name: 'Hungary' } });
  });

  test('industry and network map per kind; a kind without them refuses', async () => {
    const { fetch, asked } = linkedin();
    await runFind(
      'companies',
      { keywords: 'ai', limit: 5, industry: ['4'], network: ['1st'] },
      {},
      fetch,
    );
    expect(asked.at(-1)?.vars).toContain('(key:industryCompanyVertical,value:List(4))');
    expect(asked.at(-1)?.vars).toContain('(key:network,value:List(F))');
    const bad = await runFind('groups', { keywords: 'ai', limit: 5, industry: ['4'] }, {}, fetch);
    if (bad.ok) throw new Error('expected refusal');
    expect(bad.error.hint).toContain('companies');
  });

  test('a raw filter passes through, for anything without a flag', async () => {
    const { fetch, asked } = linkedin();
    await runFind(
      'courses',
      { keywords: 'ai', limit: 5, raw: ['difficultyLevel=Beginner,Advanced'] },
      {},
      fetch,
    );
    expect(asked.at(-1)?.vars).toContain('(key:difficultyLevel,value:List(Beginner,Advanced))');
  });

  test('several keyword sets merge by id', async () => {
    const { fetch } = linkedin();
    const r = data(
      await runFind('groups', { keywords: ['ai', 'machine learning'], limit: 50 }, {}, fetch),
    );
    // The fake serves the same page for both: every group is found twice.
    expect(r.meta).toMatchObject({ returnedCount: 50, duplicates: 50 });
    expect(r.items[0]?.matched).toEqual(['ai', 'machine learning']);
  });

  test('--compact is one line, id first', async () => {
    const r = data(
      await runFind('events', { keywords: 'ai', limit: 1 }, { compact: true }, linkedin().fetch),
    );
    expect(String(r.items[0])).toStartWith(
      '7504163229280026624 | Artificial Intelligence and Emerging Technologies in GMP | ' +
        'Wed, Sep 30, 5:00 PM GST | Online • By Paul R. Palmer Limited | ',
    );
  });

  test('nothing to search for is refused', async () => {
    expect((await runFind('companies', { limit: 5 }, {}, linkedin().fetch)).ok).toBe(false);
  });
});

describe('lnrelay search-filters <kind>', () => {
  test("lists the kind's own filters, with ids", async () => {
    const r = await runFindFilters('companies', { keywords: 'ai' }, {}, linkedin().fetch);
    if (!r.ok) throw new Error(r.error.message);
    const keys = (r.data as { items: { key: string }[] }).items.map((f) => f.key);
    expect(keys).toEqual([
      'companyHqGeo',
      'industryCompanyVertical',
      'companySize',
      'hasJobs',
      'network',
    ]);
  });
});

describe('search flags', () => {
  test('the kind, every keyword set and the filters are read from the command line', async () => {
    const { parseArgs } = await import('../src/args.ts');
    const { findRequest } = await import('../src/cli.ts');
    const req = findRequest(
      parseArgs([
        'search',
        'companies',
        'ai',
        'machine learning',
        '--location',
        'Hungary',
        '--industry',
        '4,6',
        '--network',
        '1st',
        '--filter',
        'companySize=B,C',
        '--limit',
        '100',
        '--start',
        '50',
      ]),
    );
    expect(req).toEqual({
      keywords: ['ai', 'machine learning'],
      location: 'Hungary',
      industry: ['4', '6'],
      network: ['1st'],
      raw: ['companySize=B,C'],
      limit: 100,
      start: 50,
    });
  });

  test('an unknown kind is refused with the ones that exist', async () => {
    const { dispatch } = await import('../src/cli.ts');
    const e = await dispatch(['search', 'spaceships', 'x'], 0);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.hint).toContain('companies');
    expect(e.error.hint).toContain('posts');
  });
});
