import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseViewers,
  parseViewTotals,
  VIEW_TOTALS_URL,
  VIEWERS_REFERER,
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

  test('a date range is the value of the range state; none leaves it to LinkedIn', () => {
    const range = (b: ReturnType<typeof viewersBody>) => [
      b.states[0]?.value,
      b.requestedArguments.states[0]?.value,
    ];
    expect(range(viewersBody())).toEqual([[], []]);
    expect(range(viewersBody(365))).toEqual([
      ['WvmpSearchFilterTimeRange_LAST_365_DAYS'],
      ['WvmpSearchFilterTimeRange_LAST_365_DAYS'],
    ]);
    expect(viewTotalsBody(7).states[0]?.value).toEqual(['WvmpSearchFilterTimeRange_LAST_7_DAYS']);
  });

  test('the referer every viewer call carries: without one LinkedIn answers 500', () => {
    expect(VIEWERS_REFERER).toBe('https://www.linkedin.com/analytics/profile-views/');
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

  // Premium, 2026-11-22, the past 365 days: four named viewers, one anonymous,
  // and four in private mode. Texts here carry two more style props.
  test('the Premium list: every viewer it names', () => {
    const r = parseViewers(stream('profile-viewers-premium.rsc'));
    if (!r.ok) throw new Error(r.message);
    expect(r.viewers).toHaveLength(5);
    expect(r.viewers[0]).toEqual({
      name: 'Person 1',
      id: 'ACoAATESTPERSON1',
      url: 'https://www.linkedin.com/in/person-1/',
      degree: 'Első',
      headline: 'Developer at Company One',
      viewed: 'Megtekintve 1 hete',
    });
    expect(r.viewers.map((v) => ('name' in v ? v.name : 'anonymous'))).toEqual([
      'Person 1',
      'Person 2',
      'Person 3',
      'Person 4',
      'anonymous',
    ]);
    expect(r.viewers.map((v) => ('id' in v ? v.id : undefined))).toEqual([
      'ACoAATESTPERSON1',
      'ACoAATESTPERSON2',
      'ACoAATESTPERSON3',
      'ACoAATESTPERSON4',
      undefined,
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

  test('Premium: the total, the highlights and the companies viewers work at', () => {
    expect(parseViewTotals(stream('profile-viewers-analytics-premium.rsc'))).toEqual({
      ok: true,
      total: 10,
      highlights: [
        { label: 'Legjobb helyszín', value: 'Budapest Metropolitan Area' },
        { label: 'Legjobb ágazat', value: 'Szoftverfejlesztés' },
        { label: 'Legjobb vállalat', value: 'Company One' },
      ],
      companies: [
        { name: 'Company One', share: 25 },
        { name: 'Company Two', share: 25 },
        { name: 'Company Three', share: 25 },
        { name: 'Company Four', share: 25 },
      ],
    });
  });

  test('no number is drift', () => {
    expect(parseViewTotals('0:null')).toMatchObject({ ok: false, code: 'SCHEMA_DRIFT' });
  });
});
