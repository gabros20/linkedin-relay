import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRecommendations,
  RECOMMENDATIONS_URL,
  recommendationsBody,
} from '../src/engine/recommendations.ts';

const STREAM = readFileSync(
  join(import.meta.dir, 'fixtures', 'profile-recommendations.rsc'),
  'utf-8',
);

describe('the request', () => {
  test("the details page's pager, received or given, from a start", () => {
    expect(RECOMMENDATIONS_URL).toContain('pagers.profile.details.recommendations');
    const body = recommendationsBody('given', 'person-0', 'ACoAATESTPERSON1', 15);
    expect(body.paginationRequest.requestedArguments.payload).toEqual({
      type: 'Given',
      vanityName: 'person-0',
      profileId: 'ACoAATESTPERSON1',
      start: 15,
      detailScreenTabIndex: '1',
      count: 15,
    });
  });
});

describe('parseRecommendations', () => {
  // The fixture (redacted) holds 8 received recommendations; the parser emits 8.
  test('each one: who, their headline and degree, when and how, and the text', () => {
    const r = parseRecommendations(STREAM);
    if (!r.ok) throw new Error(r.message);
    expect(r.items).toHaveLength(8);
    expect(r.items[0]).toMatchObject({
      name: 'Person 1',
      url: 'https://www.linkedin.com/in/person-1/',
      headline: 'Headline 1',
      degree: '3rd+',
      context: 'May 29, 2020, Person was senior to Subject',
    });
    expect(r.items.map((x) => x.name)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Person ${i + 1}`),
    );
    // Every one has its own text, and none carries the next one's.
    for (const x of r.items) expect(x.text).toMatch(/^Recommendation line\./);
    expect(r.items[0]?.text.split('Recommendation line.').length).toBeGreaterThan(5);
  });

  test('none is an empty list; not the pager is drift', () => {
    expect(parseRecommendations('0:["$","div",null,{"isPartialPage":true}]')).toEqual({
      ok: true,
      items: [],
    });
    expect(parseRecommendations('0:null')).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
