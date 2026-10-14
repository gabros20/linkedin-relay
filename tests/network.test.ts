import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUB,
  hubUrl,
  parseHub,
  parseSentInvitations,
  sentInvitationsUrl,
} from '../src/engine/network.ts';

// Captured 2026-10-14 from the owner's My Network: the curation hub's
// connections (5), people followed (2), followers (5), pages followed (2) and
// events (none), and the 2 connection invitations they have sent. Every
// person is redacted; pages are organisations and kept.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

const variables = (url: string) =>
  decodeURIComponent(new URL(url).searchParams.get('variables') ?? '');

describe('requests', () => {
  test('a hub list is the curation search: no keywords, its own result type, 50 a page', () => {
    expect(HUB).toEqual({
      connections: 'CONNECTIONS',
      following: 'PEOPLE_FOLLOW',
      followers: 'FOLLOWERS',
      pages: 'PAGES',
      events: 'EVENTS',
      groups: 'GROUPS',
    });
    const v = variables(hubUrl('following', 50));
    expect(v).toContain('start:50,count:50,origin:CurationHub');
    expect(v).toContain('flagshipSearchIntent:MYNETWORK_CURATION_HUB');
    expect(v).toContain('(key:resultType,value:List(PEOPLE_FOLLOW))');
    // An empty `keywords` is answered with a 400; none is sent.
    expect(v).not.toContain('keywords');
  });

  test('sent invitations are the relationships resource, by page', () => {
    const url = sentInvitationsUrl(10);
    expect(url).toContain('/voyager/api/relationships/sentInvitationViewsV2?');
    expect(url).toContain('invitationType=CONNECTION');
    expect(url).toContain('start=10');
  });
});

describe('hub lists', () => {
  // Each fixture holds the owner's whole list; the parser emits every row.
  for (const [name, count] of [
    ['connections', 5],
    ['following', 2],
    ['followers', 5],
  ] as const) {
    test(`${name}: ${count} people, each a flat row`, () => {
      const r = parseHub(name, fixture(`network-${name}.json`));
      if (!r.ok) throw new Error(r.message);
      expect(r.items).toHaveLength(count);
      expect(r.total).toBe(count);
      expect(r.items[0]).toMatchObject({
        id: expect.stringMatching(/^ACoAATESTPERSON\d+$/),
        name: expect.stringMatching(/^Person \d+$/),
        headline: expect.stringMatching(/^Headline \d+$/),
      });
    });
  }

  test('pages: the organisations followed', () => {
    const r = parseHub('pages', fixture('network-pages.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      id: '1898179',
      name: 'Designatives',
      url: 'https://www.linkedin.com/company/designatives/',
    });
  });

  test('an empty list is empty, not drift: LinkedIn says there are none', () => {
    const r = parseHub('events', fixture('network-events.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('sent invitations', () => {
  // 2 invitations sent; the parser emits 2.
  test('who each went to, when, and any note — never the shared secret', () => {
    const r = parseSentInvitations(fixture('network-invitations-sent.json'));
    if (!r.ok) throw new Error(r.message);
    expect(r.invitations).toEqual([
      {
        to: 'Person 1',
        id: 'ACoAATESTPERSON1',
        headline: 'Headline 1',
        url: 'https://www.linkedin.com/in/person-1/',
        sent: new Date(1790691704677).toISOString(),
      },
      // The redaction numbered the owner's own mini profile 2: invitees are 1 and 3.
      {
        to: 'Person 3',
        id: 'ACoAATESTPERSON2',
        headline: 'Headline 3',
        url: 'https://www.linkedin.com/in/person-3/',
        sent: new Date(1790691696769).toISOString(),
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('sharedSecret');
  });

  test('invitations listed but not sent is drift', () => {
    const j = fixture('network-invitations-sent.json');
    expect(parseSentInvitations({ ...j, included: [] }).ok).toBe(false);
  });
});
