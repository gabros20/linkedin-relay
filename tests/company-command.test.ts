import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CompanyFetch, runCompany } from '../src/commands/company.ts';

const read = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const BY_NAME = JSON.parse(read('company-by-name.json'));
const BY_ID = JSON.parse(read('company-by-id.json'));
const POSTS = read('search-posts.rsc');

function linkedin(fails: string[] = []) {
  const asked: { url: string; spendClass: string; body?: unknown }[] = [];
  const fetch: CompanyFetch = async (url, body, spendClass) => {
    asked.push({ url, spendClass, ...(body !== undefined ? { body } : {}) });
    if (body !== undefined) {
      if (fails.includes('posts')) return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
      return { ok: true, raw: POSTS };
    }
    if (url.includes('universalName=nobody'))
      return {
        ok: true,
        raw: '',
        json: { data: { ...BY_NAME.data, '*elements': [] }, included: [] },
      };
    return { ok: true, raw: '', json: url.includes('q=universalName') ? BY_NAME : BY_ID };
  };
  return { fetch, asked };
}

describe('lnrelay company', () => {
  test('one company by URL: one page call, the company itself', async () => {
    const { fetch, asked } = linkedin();
    const r = await runCompany(['https://www.linkedin.com/company/microsoft/'], {}, {}, fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(asked).toEqual([
      { url: expect.stringContaining('universalName=microsoft'), spendClass: 'page' },
    ]);
    expect(r.data).toMatchObject({
      id: '1035',
      name: 'Microsoft',
      industry: 'Software Development',
    });
  });

  test('--posts adds its newest posts, a posts search from the company, on the search budget', async () => {
    const { fetch, asked } = linkedin();
    const r = await runCompany(['1035'], { posts: 5 }, {}, fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(asked.map((a) => a.spendClass)).toEqual(['page', 'search']);
    const search = asked[1]?.body as { clientArguments: { payload: Record<string, unknown> } };
    const payload = search.clientArguments.payload;
    expect(payload).toMatchObject({ fromOrganization: ['1035'], sortBy: ['date_posted'] });
    const d = r.data as { posts: unknown[] };
    expect(d.posts.length).toBeGreaterThan(0);
    expect(d.posts.length).toBeLessThanOrEqual(5);
  });

  test('posts that could not be read say so; the company is still returned', async () => {
    const r = await runCompany(['1035'], { posts: 5 }, {}, linkedin(['posts']).fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data).toMatchObject({ name: 'Microsoft', postsError: 'BUDGET_EXHAUSTED: spent' });
  });

  test('several companies: one call each, one line each with --compact; the same one twice is one', async () => {
    const { fetch, asked } = linkedin();
    const r = await runCompany(['microsoft', '1035'], {}, { compact: true }, fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(asked).toHaveLength(2);
    const d = r.data as { items: string[]; meta: Record<string, unknown> };
    expect(d.items).toEqual([
      '1035 | Microsoft | Software Development | 10,001+ | 231136 on LinkedIn | 29296702 followers | ' +
        '1 Microsoft Way, Redmond, Washington 98052, US | https://news.microsoft.com/ | ' +
        'https://www.linkedin.com/company/microsoft/',
    ]);
    expect(d.meta).toMatchObject({ state: 'complete', returnedCount: 1 });
  });

  test('a company that does not exist is not found; among several it is listed as unread', async () => {
    const one = await runCompany(['nobody'], {}, {}, linkedin().fetch);
    expect(one.ok).toBe(false);
    const many = await runCompany(['nobody', 'microsoft'], {}, {}, linkedin().fetch);
    if (!many.ok) throw new Error(many.error.message);
    expect(many.data).toMatchObject({
      meta: {
        state: 'partial',
        returnedCount: 1,
        unread: [{ company: 'nobody', code: 'NOT_FOUND' }],
      },
    });
  });

  test('something that is not a company is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    expect((await runCompany(['https://www.linkedin.com/in/someone/'], {}, {}, fetch)).ok).toBe(
      false,
    );
    expect((await runCompany([], {}, {}, fetch)).ok).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
