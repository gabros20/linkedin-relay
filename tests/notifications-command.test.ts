import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type NotificationsFetch, runNotifications } from '../src/commands/notifications.ts';

const json = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const PAGE = json('notifications.json');
const END = json('notifications-end.json');

function linkedin(fails = false) {
  const asked: string[] = [];
  const fetch: NotificationsFetch = async (url) => {
    asked.push(url);
    if (fails && url.includes('start=10'))
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'spent' };
    return { ok: true, json: url.includes('start=0') ? PAGE : END };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runNotifications>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as { items: unknown[]; unseen?: number; meta: Record<string, unknown> };
};

describe('lnrelay notifications', () => {
  test('pages by next start until the end; the end is complete', async () => {
    const { fetch, asked } = linkedin();
    const d = data(await runNotifications({ limit: 50 }, {}, fetch));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('start=10');
    expect(d.items).toHaveLength(9);
    expect(d.unseen).toBe(2);
    expect(d.meta).toMatchObject({ state: 'complete', returnedCount: 9 });
  });

  test('a limit reached with more to come is partial, and stops asking', async () => {
    const { fetch, asked } = linkedin();
    const d = data(await runNotifications({ limit: 5 }, {}, fetch));
    expect(asked).toHaveLength(1);
    expect(d.items).toHaveLength(5);
    expect(d.meta.state).toBe('partial');
  });

  test('--unread keeps the unread ones', async () => {
    const d = data(await runNotifications({ limit: 50, unread: true }, {}, linkedin().fetch));
    expect(d.items).toHaveLength(2);
  });

  test('a later page failing keeps what came, and says why', async () => {
    const d = data(await runNotifications({ limit: 50 }, {}, linkedin(true).fetch));
    expect(d.items).toHaveLength(9);
    expect(d.meta).toMatchObject({ state: 'partial', stoppedBy: 'BUDGET_EXHAUSTED' });
  });

  test('--compact: one line each', async () => {
    const d = data(await runNotifications({ limit: 1 }, { compact: true }, linkedin().fetch));
    expect(d.items[0]).toBe(
      `unread | ${new Date(1793226541020).toISOString()} | FOLLOW_PAGE_HERO | Learn more about Company One and discover other pages you might be interested in following. | https://www.linkedin.com/suggested-for-you/follow-page/?vanityName=company-one&origin=IN_APP`,
    );
  });
});
