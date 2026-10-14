import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EventsFetch, runEvent, runEvents } from '../src/commands/events.ts';

const read = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const HUB = read('events-hub.rsc');
const IN_PERSON = JSON.parse(read('event-in-person.json'));
const ONLINE = JSON.parse(read('event-online.json'));

function linkedin() {
  const asked: { url: string; post: boolean; spendClass: string }[] = [];
  const fetch: EventsFetch = async (url, body, spendClass) => {
    asked.push({ url, post: body !== undefined, spendClass });
    if (body !== undefined) return { ok: true, raw: HUB };
    const json = decodeURIComponent(url).includes('7460711926000517123') ? IN_PERSON : ONLINE;
    return { ok: true, raw: '', json };
  };
  return { fetch, asked };
}

describe('lnrelay events', () => {
  test('the hub in one call, on the page budget, cut to the limit', async () => {
    const { fetch, asked } = linkedin();
    const r = await runEvents({ limit: 5 }, {}, fetch);
    if (!r.ok) throw new Error(r.error.message);
    const d = r.data as { items: unknown[]; meta: Record<string, unknown> };
    expect(asked).toEqual([
      {
        url: expect.stringContaining('eventsHomeCardGroupsSection'),
        post: true,
        spendClass: 'page',
      },
    ]);
    expect(d.items).toHaveLength(5);
    expect(d.meta).toMatchObject({ returnedCount: 5, shownCount: 40 });
  });

  test('--premium keeps the LinkedIn Live events only', async () => {
    const r = await runEvents({ limit: 50, premium: true }, {}, linkedin().fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect((r.data as { items: { premium: boolean }[] }).items.every((e) => e.premium)).toBe(true);
  });

  test('--compact is one line per event', async () => {
    const r = await runEvents({ limit: 2 }, { compact: true }, linkedin().fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect((r.data as { items: string[] }).items[1]).toBe(
      '7465781119175598080 | The Future in Focus: STA 93rd Annual Market Structure Conference | ' +
        'Wed, Oct 14, 3:00 PM - Fri, Oct 16, 3:00 PM | Security Traders Association | 9 attendees | ' +
        'https://www.linkedin.com/events/7465781119175598080/',
    );
  });
});

describe('lnrelay event', () => {
  test('one event by URL, in full', async () => {
    const { fetch, asked } = linkedin();
    const r = await runEvent(
      ['https://www.linkedin.com/events/chemicalriskexpo7460711926000517123/'],
      {},
      fetch,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(asked).toHaveLength(1);
    expect(r.data).toMatchObject({ name: 'Chemical Risk Expo', place: 'Houston, Texas, US' });
  });

  test('several events: one call each, listed in the order asked', async () => {
    const { fetch, asked } = linkedin();
    const r = await runEvent(['7460711926000517123', '7504163229280026624'], {}, fetch);
    if (!r.ok) throw new Error(r.error.message);
    expect(asked).toHaveLength(2);
    expect((r.data as { items: { id: string }[] }).items.map((e) => e.id)).toEqual([
      '7460711926000517123',
      '7504163229280026624',
    ]);
  });

  test('something that is not an event is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    expect((await runEvent(['expo'], {}, fetch)).ok).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
