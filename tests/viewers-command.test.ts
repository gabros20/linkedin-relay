import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runViewers, type ViewersFetch } from '../src/commands/viewers.ts';

const stream = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const LIST = stream('profile-viewers.rsc');
const TOTALS = stream('profile-viewers-analytics.rsc');

function linkedin(fails: string[] = [], answers = { list: LIST, totals: TOTALS }) {
  const asked: { url: string; spendClass: string; range: unknown }[] = [];
  const fetch: ViewersFetch = async (url, body, spendClass) => {
    asked.push({
      url,
      spendClass,
      range: (body as { states: { value: unknown }[] }).states[0]?.value,
    });
    const which = url.includes('WvmpAnalytics') ? 'totals' : 'list';
    if (fails.includes(which)) return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
    return { ok: true, raw: answers[which] };
  };
  return { fetch, asked };
}

const PREMIUM = {
  list: stream('profile-viewers-premium.rsc'),
  totals: stream('profile-viewers-analytics-premium.rsc'),
};

const data = (e: Awaited<ReturnType<typeof runViewers>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as Record<string, unknown> & { items: unknown[]; meta: Record<string, unknown> };
};

describe('lnrelay viewers', () => {
  test('the total, the viewers shown, and the private-mode count, in two page calls', async () => {
    const { fetch, asked } = linkedin();
    const d = data(await runViewers({}, fetch));
    expect(asked.map((a) => a.spendClass)).toEqual(['page', 'page']);
    expect(d.total).toBe(5);
    expect(d.period).toBe('Profilmegtekintők az elmúlt 90 napból');
    expect(d.privateViewers).toBe(4);
    expect(d.items).toHaveLength(3);
    // LinkedIn counts 5 and shows 3: what it holds back is not here.
    expect(d.meta).toMatchObject({ state: 'partial', returnedCount: 3 });
  });

  test('--compact: one line a viewer', async () => {
    const d = data(await runViewers({ compact: true }, linkedin().fetch));
    expect(d.items[0]).toBe(
      'Person 1 | Harmadik | Designer at Company One | 2 napja megtekintve | https://www.linkedin.com/in/person-1/',
    );
    expect(d.items[2]).toBe(
      'anonymous | Founder in the Szoftverfejlesztés industry from Budapest Metropolitan Area | 1 hónapja megtekintve',
    );
  });

  test('Premium, --days 365: every viewer, the highlights, and the companies', async () => {
    const { fetch, asked } = linkedin([], PREMIUM);
    const d = data(await runViewers({ days: 365 }, fetch));
    expect(asked.map((a) => a.range)).toEqual([
      ['WvmpSearchFilterTimeRange_LAST_365_DAYS'],
      ['WvmpSearchFilterTimeRange_LAST_365_DAYS'],
    ]);
    expect(d.days).toBe(365);
    expect(d.total).toBe(10);
    expect(d.items).toHaveLength(5);
    expect(d.privateViewers).toBe(4);
    expect(d.highlights).toHaveLength(3);
    expect(d.companies).toHaveLength(4);
    // 5 named and 4 private of 10: one view LinkedIn counts but does not list.
    expect(d.meta).toMatchObject({ state: 'partial', returnedCount: 5 });
  });

  test('the named and the private together make the total: complete', async () => {
    const totals = PREMIUM.totals.replace('["10"]', '["9"]');
    // 5 named and 4 private.
    const d = data(await runViewers({}, linkedin([], { ...PREMIUM, totals }).fetch));
    expect(d.meta.state).toBe('complete');
  });

  test('the total failing keeps the viewers, and says so', async () => {
    const d = data(await runViewers({}, linkedin(['totals']).fetch));
    expect(d.items).toHaveLength(3);
    expect(d.totalError).toBe('BUDGET_EXHAUSTED: spent');
    expect(d.meta.state).toBe('unknown');
  });

  test('the list failing is a failure', async () => {
    const e = await runViewers({}, linkedin(['list']).fetch);
    expect(e.ok).toBe(false);
  });
});
