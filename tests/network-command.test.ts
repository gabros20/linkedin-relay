import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type NetworkFetch, runNetwork } from '../src/commands/network.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const BY_TYPE: Record<string, string> = {
  CONNECTIONS: 'network-connections.json',
  PEOPLE_FOLLOW: 'network-following.json',
  FOLLOWERS: 'network-followers.json',
  PAGES: 'network-pages.json',
  EVENTS: 'network-events.json',
  GROUPS: 'network-events.json',
};

function linkedin() {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: NetworkFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    if (url.includes('sentInvitationViewsV2')) {
      if (url.includes('start=0'))
        return { ok: true, json: fixture('network-invitations-sent.json') };
      return {
        ok: true,
        json: { data: { elements: [], paging: { start: 10, count: 10 } }, included: [] },
      };
    }
    const type = decodeURIComponent(url).match(/key:resultType,value:List\((\w+)\)/)?.[1] ?? '';
    return { ok: true, json: fixture(BY_TYPE[type] as string) };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runNetwork>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as {
    items: Record<string, unknown>[];
    meta: Record<string, unknown>;
    counts?: Record<string, number>;
  };
};

describe('lnrelay network', () => {
  test('with no list: the counts of every list, one call each, on the page budget', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runNetwork(undefined, { limit: 25 }, {}, fetch));
    expect(r.counts).toEqual({
      connections: 5,
      following: 2,
      followers: 5,
      pages: 2,
      events: 0,
      groups: 0,
      invitationsSent: 2,
    });
    expect(asked).toHaveLength(7);
    expect(asked.every((a) => a.spendClass === 'page')).toBe(true);
  });

  test('a people list: every person, complete when LinkedIn has no more', async () => {
    const r = data(await runNetwork('connections', { limit: 25 }, {}, linkedin().fetch));
    expect(r.items).toHaveLength(5);
    expect(r.items[0]).toMatchObject({
      id: expect.stringMatching(/^ACoAATESTPERSON/),
      name: expect.any(String),
    });
    expect(r.meta).toMatchObject({ state: 'complete', returnedCount: 5, claimedCount: 5 });
  });

  test('pages followed', async () => {
    const r = data(await runNetwork('pages', { limit: 25 }, {}, linkedin().fetch));
    expect(r.items.map((p) => p.name)).toContain('Designatives');
  });

  test('sent invitations: a short page is the last, so one call', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runNetwork('invitations', { limit: 25 }, {}, fetch));
    expect(r.items).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(r.meta.state).toBe('complete');
  });

  test('--compact is one line per row', async () => {
    const r = data(
      await runNetwork('following', { limit: 25 }, { compact: true }, linkedin().fetch),
    );
    expect(String(r.items[0])).toMatch(/^ACoAATESTPERSON\d+ \| Person \d+ \| Headline \d+/);
  });

  test('an unknown list is refused with the ones that exist', async () => {
    const r = await runNetwork('newsletters', { limit: 25 }, {}, linkedin().fetch);
    if (r.ok) throw new Error('expected refusal');
    expect(r.error.hint).toContain('followers');
  });
});
