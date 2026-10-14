import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ItemsFetch, runMyItems } from '../src/commands/my-items.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const EMPTY = {
  data: {
    data: {
      searchDashClustersByAll: {
        elements: [],
        paging: { start: 0, count: 10, total: 0 },
        metadata: {},
      },
    },
  },
  included: [],
};

function linkedin() {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: ItemsFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    const v = decodeURIComponent(url);
    if (v.includes('SAVED_POSTS')) return { ok: true, json: fixture('items-saved-posts.json') };
    if (v.includes('LEARNING')) return { ok: true, json: fixture('items-learning.json') };
    if (v.includes('List(ARCHIVED)'))
      return { ok: true, json: fixture('items-jobs-archived.json') };
    return { ok: true, json: EMPTY };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runMyItems>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as { items: Record<string, unknown>[]; meta: Record<string, unknown> };
};

describe('lnrelay my-items', () => {
  test('saved posts, in one call when they fit, on the page budget', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runMyItems('posts', { limit: 25 }, {}, fetch));
    expect(r.items).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.spendClass).toBe('page');
    expect(r.meta).toMatchObject({ state: 'complete', returnedCount: 1 });
  });

  test('learning', async () => {
    const r = data(await runMyItems('learning', { limit: 25 }, {}, linkedin().fetch));
    expect(r.items[0]).toMatchObject({
      name: 'After Effects 2020 New Features',
      progress: '6m left',
    });
  });

  test('jobs with no stage: every stage of the tracker, one call each, each job saying its stage', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runMyItems('jobs', { limit: 50 }, {}, fetch));
    expect(asked).toHaveLength(5);
    expect(r.items).toHaveLength(6);
    expect(r.items.every((j) => j.stage === 'archived')).toBe(true);
    expect(r.meta).toMatchObject({
      byStage: { saved: 0, 'in-progress': 0, applied: 0, interview: 0, archived: 6 },
    });
  });

  test('jobs in one stage: one call', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runMyItems('jobs', { limit: 50, stage: 'archived' }, {}, fetch));
    expect(asked).toHaveLength(1);
    expect(r.items).toHaveLength(6);
  });

  test('--compact is one line per item', async () => {
    const r = data(
      await runMyItems(
        'jobs',
        { limit: 50, stage: 'archived' },
        { compact: true },
        linkedin().fetch,
      ),
    );
    expect(r.items).toContain(
      '4459168502 | AI Developer - Agentic AI | ALDI International IT Services (Hungary) | Budapest, Hungary | hybrid | archived | No longer accepting applications | https://www.linkedin.com/jobs/view/4459168502/',
    );
  });

  test('an unknown list or stage is refused with the ones that exist', async () => {
    const a = await runMyItems('bookmarks', { limit: 5 }, {}, linkedin().fetch);
    if (a.ok) throw new Error('expected refusal');
    expect(a.error.hint).toContain('learning');
    const b = await runMyItems(
      'jobs',
      { limit: 5, stage: 'rejected' as never },
      {},
      linkedin().fetch,
    );
    if (b.ok) throw new Error('expected refusal');
    expect(b.error.hint).toContain('in-progress');
  });
});
