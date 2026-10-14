import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENTS_HUB,
  eventIdOf,
  eventsHubBody,
  eventUrl,
  parseEvent,
  parseEventsHub,
} from '../src/engine/events.ts';

// Captured 2026-10-14: the events page's card section, trimmed to the rows its
// cards are read from (the viewer's LinkedIn is in Hungarian, so its labels
// are), and two events in full: one online (LinkedIn Live, past), one in
// person (Houston, upcoming). Profile ids are test ids.
const read = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const HUB = read('events-hub.rsc');
const ONLINE = JSON.parse(read('event-online.json'));
const IN_PERSON = JSON.parse(read('event-in-person.json'));

describe('requests', () => {
  test('the hub is one SDUI component, asked for by name', () => {
    expect(eventsHubBody()).toMatchObject({ componentId: EVENTS_HUB });
  });

  test('an event is read by its id, without its comment thread', () => {
    const url = decodeURIComponent(eventUrl('7460711926000517123'));
    expect(url).toContain('queryId=voyagerEventsDashProfessionalEvents.');
    expect(url).toContain('eventIdentifier:7460711926000517123');
    expect(url).toContain('includeComments:false');
  });

  test('event ids come from an id, an /events/ URL or a urn', () => {
    expect(eventIdOf('7460711926000517123')).toBe('7460711926000517123');
    expect(eventIdOf('https://www.linkedin.com/events/chemicalriskexpo7460711926000517123/')).toBe(
      '7460711926000517123',
    );
    expect(eventIdOf('urn:li:fsd_professionalEvent:7460711926000517123')).toBe(
      '7460711926000517123',
    );
    expect(eventIdOf('expo')).toBeUndefined();
  });
});

describe('the events hub', () => {
  // 40 cards on the page: 37 recommended, 3 Premium; the parser emits 40.
  test('every card becomes one event, in the order shown', () => {
    const r = parseEventsHub(HUB);
    if (!r.ok) throw new Error(r.message);
    expect(r.events).toHaveLength(40);
    expect(r.events.filter((e) => e.premium)).toHaveLength(3);
  });

  test('a card: name, when, organiser, attendees, link — read by shape, not by its words', () => {
    const r = parseEventsHub(HUB);
    if (!r.ok) throw new Error(r.message);
    expect(r.events[1]).toEqual({
      id: '7465781119175598080',
      name: 'The Future in Focus: STA 93rd Annual Market Structure Conference',
      when: 'Wed, Oct 14, 3:00 PM - Fri, Oct 16, 3:00 PM',
      organizer: 'Security Traders Association',
      attendees: 9,
      premium: false,
      url: 'https://www.linkedin.com/events/7465781119175598080/',
    });
  });

  test('a LinkedIn Live card has no organiser line, and a thousands separator in its count', () => {
    const r = parseEventsHub(HUB);
    if (!r.ok) throw new Error(r.message);
    expect(r.events.at(-1)).toEqual({
      id: '7508586015624712192',
      name: 'The Unwritten Rules of Getting Hired',
      when: 'Tue, Oct 6, 8:30 PM – 9:15 PM',
      attendees: 22408,
      premium: true,
      url: 'https://www.linkedin.com/events/7508586015624712192/',
    });
  });

  test('a page without event cards is drift, not an empty list', () => {
    expect(parseEventsHub('0:{"hello":1}').ok).toBe(false);
  });
});

describe('one event', () => {
  test('in person: where, the site, both ends of the time, the organiser', () => {
    const r = parseEvent(IN_PERSON);
    if (!r.ok) throw new Error(r.message);
    expect(r.event).toMatchObject({
      id: '7460711926000517123',
      name: 'Chemical Risk Expo',
      online: false,
      place: 'Houston, Texas, US',
      site: 'https://chemicalriskexpo.com/',
      start: '2026-10-14T15:00:00.000Z',
      end: '2026-10-15T21:00:00.000Z',
      timeZone: 'AMERICA_CHICAGO',
      state: 'FUTURE',
      attendees: 12,
      organizer: { name: 'Chemical Risk Expo', kind: 'company' },
      url: 'https://www.linkedin.com/events/7460711926000517123/',
    });
    expect(r.event.description?.length).toBeGreaterThan(100);
  });

  test('online: LinkedIn Live, no place', () => {
    const r = parseEvent(ONLINE);
    if (!r.ok) throw new Error(r.message);
    expect(r.event).toMatchObject({ online: true, state: 'PAST', attendees: 11 });
    expect(r.event.place).toBeUndefined();
  });

  test("LinkedIn's default viewer status (no response) is not reported as a response", () => {
    const r = parseEvent(ONLINE);
    if (!r.ok) throw new Error(r.message);
    expect(r.event.you).toBeUndefined();
  });

  test('a response without an event is drift', () => {
    expect(parseEvent({ data: {}, included: [] }).ok).toBe(false);
  });
});
