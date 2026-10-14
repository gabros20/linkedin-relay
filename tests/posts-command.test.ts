import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PostsFetch, runPostsSearch } from '../src/commands/posts-search.ts';

const STREAM = readFileSync(join(import.meta.dir, 'fixtures', 'search-posts.rsc'), 'utf-8');
const SCHOOLS = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'people-schools.json'), 'utf-8'),
);
const EMPTY =
  '0:{"pagerId":"com.linkedin.sdui.search.contentSearchResults","isPartialPage":false}\n';

/** Serves the captured page for each start, its post ids shifted, until `served` posts. */
function linkedin(opts: { served?: number } = {}) {
  const served = opts.served ?? 60;
  const asked: { payload?: Record<string, unknown>; url: string; spendClass: string }[] = [];
  const fetch: PostsFetch = async (url, body, spendClass) => {
    const payload = (
      body as
        | { paginationRequest?: { requestedArguments?: { payload?: Record<string, unknown> } } }
        | undefined
    )?.paginationRequest?.requestedArguments?.payload;
    asked.push({ url, spendClass, ...(payload !== undefined ? { payload } : {}) });
    if (body === undefined) return { ok: true, json: SCHOOLS, raw: '' };
    const start = Number(payload?.startIndex);
    if (start >= served) return { ok: true, raw: EMPTY };
    return {
      ok: true,
      raw: STREAM.replace(
        /(urn:li:(?:ugcPost|groupPost):)(\d+)/g,
        (_, p, id) => `${p}${BigInt(id) + BigInt(start)}`,
      ),
    };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runPostsSearch>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as {
    items: Record<string, unknown>[];
    meta: Record<string, unknown>;
    resolved?: unknown;
  };
};

describe('lnrelay search posts', () => {
  test('asks for 20 a call, pages to the limit, on the search budget', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runPostsSearch({ keywords: 'ai', limit: 30 }, {}, fetch));
    expect(r.items).toHaveLength(30);
    expect(asked.map((a) => [a.payload?.startIndex, a.payload?.count])).toEqual([
      [0, 20],
      [20, 20],
    ]);
    expect(asked.every((a) => a.spendClass === 'search')).toBe(true);
    expect(r.meta).toMatchObject({ state: 'partial', returnedCount: 30, next: 30 });
  });

  test('an empty page ends the search, which is then complete', async () => {
    const { fetch } = linkedin({ served: 40 });
    const r = data(await runPostsSearch({ keywords: 'ai', limit: 100 }, {}, fetch));
    expect(r.items).toHaveLength(40);
    expect(r.meta.state).toBe('complete');
  });

  test('friendly filters become the lists the pager takes', async () => {
    const { fetch, asked } = linkedin();
    await runPostsSearch(
      {
        keywords: 'ai',
        limit: 5,
        sort: 'recent',
        posted: 'week',
        type: ['videos', 'articles'],
        postedBy: ['1st'],
        from: ['ACoAATESTPERSON1'],
        authorTitle: 'founder',
        authorIndustry: ['4'],
        raw: ['mentionsMember=ACoAATESTPERSON2'],
      },
      {},
      fetch,
    );
    expect(asked[0]?.payload).toMatchObject({
      sortBy: ['date_posted'],
      datePosted: ['past-week'],
      contentType: ['videos', 'articles'],
      postedBy: ['first'],
      fromMember: ['ACoAATESTPERSON1'],
      authorJobTitle: ['founder'],
      authorIndustry: ['4'],
      mentionsMember: ['ACoAATESTPERSON2'],
    });
  });

  test('a company by name is looked up for the company filters', async () => {
    const { fetch, asked } = linkedin();
    const r = data(
      await runPostsSearch({ keywords: 'ai', limit: 5, authorCompany: ['BME', '1035'] }, {}, fetch),
    );
    expect(asked.at(-1)?.payload?.authorCompany).toEqual(['15978', '1035']);
    expect(r.resolved).toEqual({
      authorCompany: [
        { given: 'BME', id: '15978', name: 'Budapest University of Technology and Economics' },
      ],
    });
  });

  test('an unknown value is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    const r = await runPostsSearch({ keywords: 'ai', limit: 5, posted: 'decade' }, {}, fetch);
    expect(r.ok).toBe(false);
    expect(asked).toHaveLength(0);
  });

  test('--compact is one line per post', async () => {
    const r = data(
      await runPostsSearch({ keywords: 'ai', limit: 1 }, { compact: true }, linkedin().fetch),
    );
    expect(String(r.items[0])).toMatch(
      /^urn:li:ugcPost:\d+ \| Person 1 \| 5 órája \| 4 reactions · 1 comments · 1 reposts \| Text \d+ \| https:/,
    );
  });

  test('several keyword sets merge by post', async () => {
    const { fetch } = linkedin({ served: 20 });
    const r = data(await runPostsSearch({ keywords: ['ai', 'agents'], limit: 20 }, {}, fetch));
    expect(r.meta).toMatchObject({ returnedCount: 20, duplicates: 20 });
  });
});
