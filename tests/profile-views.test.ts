import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseViewers,
  parseViewTotals,
  VIEW_TOTALS_URL,
  VIEWERS_URL,
  viewersBody,
  viewTotalsBody,
} from '../src/engine/profile-views.ts';

const stream = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');

describe('the requests', () => {
  test("the viewers page's two server requests, newest first over its default range", () => {
    expect(VIEWERS_URL).toContain('sduiid=WvmpEntityList');
    expect(VIEW_TOTALS_URL).toContain('sduiid=WvmpAnalytics');
    expect(viewersBody().serverRequest.requestedArguments.payload.sortType).toBe(
      'ProfileViewSortType_TIME_DESCENDING',
    );
    expect(viewTotalsBody().requestId).toBe('WvmpAnalytics');
  });
});

describe('parseViewers', () => {
  // The fixture (a free account, in Hungarian) shows two named viewers, one
  // anonymous viewer and a count of private-mode viewers.
  test('named viewers, an anonymous one, and how many looked in private mode', () => {
    const r = parseViewers(stream('profile-viewers.rsc'));
    if (!r.ok) throw new Error(r.message);
    expect(r.viewers).toEqual([
      {
        name: 'Person 1',
        id: 'ACoAATESTPERSON1',
        url: 'https://www.linkedin.com/in/person-1/',
        degree: 'Harmadik',
        headline: 'Designer at Company One',
        viewed: '2 napja megtekintve',
      },
      {
        name: 'Person 2',
        id: 'ACoAATESTPERSON2',
        url: 'https://www.linkedin.com/in/person-2/',
        degree: 'Első',
        headline: 'Assistant at Company Two',
        viewed: '2 napja megtekintve',
      },
      {
        anonymous: true,
        description: 'Founder in the Szoftverfejlesztés industry from Budapest Metropolitan Area',
        viewed: '1 hónapja megtekintve',
        searchUrl:
          'https://www.linkedin.com/search/results/people/?keywords=Founder&origin=WHO_VIEWED_ME&industry=4&geoUrn=90010325',
      },
    ]);
    expect(r.privateViewers).toBe(4);
  });

  test('a list with no one in it is empty, not drift', () => {
    expect(
      parseViewers('1:["$","div",null,{"viewTrackingSpecs":{"viewName":"viewer-list"}}]'),
    ).toEqual({
      ok: true,
      viewers: [],
    });
  });

  test('not the viewers list is drift', () => {
    expect(parseViewers('0:null')).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });

  test('rows shown but none read is drift, not an empty success', () => {
    const row =
      '"viewTrackingSpecs":{"viewName":"viewer-list-item","semanticPosition":{"verticalPosition":0}}';
    expect(parseViewers(`1:{"viewName":"viewer-list"} ${row}`)).toMatchObject({
      ok: false,
      code: 'SCHEMA_DRIFT',
    });
  });
});

describe('parseViewTotals', () => {
  test('the total and the period, as LinkedIn words it', () => {
    expect(parseViewTotals(stream('profile-viewers-analytics.rsc'))).toEqual({
      ok: true,
      total: 5,
      period: 'Profilmegtekintők az elmúlt 90 napból',
    });
  });

  test('no number is drift', () => {
    expect(parseViewTotals('0:null')).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
