import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notificationsUrl, parseNotifications } from '../src/engine/notifications.ts';

const json = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

describe('the request', () => {
  test('the notification cards, everything, from a start', () => {
    const url = notificationsUrl(25, 50);
    expect(url).toContain('voyagerIdentityDashNotificationCards');
    expect(url).toContain('q=filterVanityName');
    expect(url).toContain('count=25');
    expect(url).toContain('start=50');
  });
});

describe('parseNotifications', () => {
  // The fixture lists 9 cards and holds all 9.
  test('every card, in order: kind, text, when, read, where it goes', () => {
    const r = parseNotifications(json('notifications.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toHaveLength(9);
    expect(r.items[0]).toEqual({
      kind: 'FOLLOW_PAGE_HERO',
      text: 'Learn more about Company One and discover other pages you might be interested in following.',
      at: new Date(1793226541020).toISOString(),
      read: false,
      url: 'https://www.linkedin.com/suggested-for-you/follow-page/?vanityName=company-one&origin=IN_APP',
      from: 'https://www.linkedin.com/company/company-one',
    });
    expect(r.items[1]).toMatchObject({
      kind: 'LEARNING_RECS_FOR_JOB_SEEKERS_BY_STAGE_INAPP',
      read: false,
    });
    expect(r.items.filter((n) => !n.read)).toHaveLength(2);
    expect(r).toMatchObject({ unseen: 2, next: 10 });
  });

  test('the end: an empty section and no next start', () => {
    const r = parseNotifications(json('notifications-end.json'));
    expect(r).toEqual({ ok: true, items: [], unseen: 2 });
  });

  test('cards listed but none sent is drift, not an empty success', () => {
    const fixture = json('notifications.json');
    fixture.included = [];
    expect(parseNotifications(fixture)).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
    expect(parseNotifications({})).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
