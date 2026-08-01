import { describe, expect, test } from 'bun:test';
import { canonicalUrn, encodeVariables, innerUrn, parseTupleUrn } from '../src/engine/restli.ts';

// ─── encodeVariables ──────────────────────────────────────────────────────────
// Rest.li 2.0's variables grammar is NOT JSON. `(k:v)` is an object literal,
// `List(a,b)` is an array, `a | b` is an OR-group inside one filter value.
// Everyone in the surveyed corpus string-templates this; getting it wrong is
// silent — LinkedIn returns a 400 or, worse, a differently-filtered result.

describe('encodeVariables', () => {
  test('encodes a flat object as (key:value) pairs', () => {
    expect(encodeVariables({ start: 0, count: 10 })).toBe('(start:0,count:10)');
  });

  test('encodes nested objects with arbitrary depth', () => {
    expect(encodeVariables({ query: { keywords: 'foo', origin: 'GLOBAL_SEARCH_HEADER' } })).toBe(
      '(query:(keywords:foo,origin:GLOBAL_SEARCH_HEADER))',
    );
  });

  test('encodes arrays as List(...)', () => {
    expect(encodeVariables({ resultType: ['PEOPLE'] })).toBe('(resultType:List(PEOPLE))');
  });

  test('encodes an empty array as List()', () => {
    expect(encodeVariables({ filters: [] })).toBe('(filters:List())');
  });

  test('encodes a list of objects', () => {
    expect(
      encodeVariables({
        queryParameters: [
          { key: 'resultType', value: ['PEOPLE'] },
          { key: 'network', value: ['F', 'S'] },
        ],
      }),
    ).toBe(
      '(queryParameters:List((key:resultType,value:List(PEOPLE)),(key:network,value:List(F,S))))',
    );
  });

  test('encodes booleans as bare true/false, not quoted', () => {
    expect(encodeVariables({ includeFiltersInResponse: false })).toBe(
      '(includeFiltersInResponse:false)',
    );
  });

  test('omits undefined values entirely rather than emitting "undefined"', () => {
    expect(encodeVariables({ start: 0, cursor: undefined, count: 5 })).toBe('(start:0,count:5)');
  });

  test('reproduces the verified real-world search shape from R3 §2', () => {
    const encoded = encodeVariables({
      start: 0,
      origin: 'GLOBAL_SEARCH_HEADER',
      query: {
        keywords: 'foo',
        flagshipSearchIntent: 'SEARCH_SRP',
        queryParameters: [
          { key: 'resultType', value: ['PEOPLE'] },
          { key: 'network', value: ['F', 'S'] },
        ],
        includeFiltersInResponse: false,
      },
    });
    expect(encoded).toBe(
      '(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:foo,flagshipSearchIntent:SEARCH_SRP,' +
        'queryParameters:List((key:resultType,value:List(PEOPLE)),(key:network,value:List(F,S)))' +
        ',includeFiltersInResponse:false))',
    );
  });

  // Reserved characters would otherwise terminate a tuple early and silently
  // change the query's meaning.
  test('percent-encodes reserved grammar characters inside string values', () => {
    expect(encodeVariables({ keywords: 'a,b' })).toBe('(keywords:a%2Cb)');
    expect(encodeVariables({ keywords: 'a(b)' })).toBe('(keywords:a%28b%29)');
    expect(encodeVariables({ keywords: 'a:b' })).toBe('(keywords:a%3Ab)');
  });

  test('preserves a URN colon-form when the value is a urn (not over-encoded)', () => {
    expect(encodeVariables({ profileUrn: 'urn:li:fsd_profile:ABC123' })).toBe(
      '(profileUrn:urn%3Ali%3Afsd_profile%3AABC123)',
    );
  });
});

// ─── parseTupleUrn ────────────────────────────────────────────────────────────
// R3 §4: the reference implementation extracts the inner URN with
// `split("(")[1].split(",")[0]`, which breaks the moment a nested paren appears
// — and nested parens do occur (fsd_profilePositionGroup:(a,b)).

describe('parseTupleUrn', () => {
  test('returns null for a plain non-composite urn', () => {
    expect(parseTupleUrn('urn:li:activity:12345')).toBeNull();
  });

  test('splits a flat composite urn into its members', () => {
    expect(
      parseTupleUrn('urn:li:fs_updateV2:(urn:li:activity:999,GROUP_FEED,EMPTY,DEFAULT,false)'),
    ).toEqual({
      namespace: 'fs_updateV2',
      members: ['urn:li:activity:999', 'GROUP_FEED', 'EMPTY', 'DEFAULT', 'false'],
    });
  });

  test('does NOT split on commas nested inside an inner tuple', () => {
    const parsed = parseTupleUrn(
      'urn:li:fsd_profilePositionGroup:(urn:li:fsd_profile:ABC,urn:li:fsd_company:(1,2))',
    );
    expect(parsed?.members).toEqual(['urn:li:fsd_profile:ABC', 'urn:li:fsd_company:(1,2)']);
  });

  test('returns null on an unbalanced tuple rather than guessing', () => {
    expect(parseTupleUrn('urn:li:fs_updateV2:(urn:li:activity:999,GROUP_FEED')).toBeNull();
  });
});

describe('innerUrn', () => {
  test('extracts the first member of a composite urn', () => {
    expect(innerUrn('urn:li:fs_updateV2:(urn:li:activity:999,GROUP_FEED,EMPTY)')).toBe(
      'urn:li:activity:999',
    );
  });

  test('returns the urn unchanged when it is not composite', () => {
    expect(innerUrn('urn:li:activity:999')).toBe('urn:li:activity:999');
  });
});

// ─── canonicalUrn ─────────────────────────────────────────────────────────────
// R3 §4: fs_miniProfile / fs_profile / fsd_profile coexist mid-migration and
// refer to the same member. This is the same legacy/hoisted split that cost
// x-relay real data. Collapsing them is what makes dedupe structural.

describe('canonicalUrn', () => {
  test('collapses the three profile namespaces to one identity', () => {
    expect(canonicalUrn('urn:li:fs_miniProfile:ABC')).toBe('urn:li:fsd_profile:ABC');
    expect(canonicalUrn('urn:li:fs_profile:ABC')).toBe('urn:li:fsd_profile:ABC');
    expect(canonicalUrn('urn:li:fsd_profile:ABC')).toBe('urn:li:fsd_profile:ABC');
  });

  test('unwraps a composite urn to its inner identity before canonicalising', () => {
    expect(canonicalUrn('urn:li:fs_updateV2:(urn:li:activity:999,GROUP_FEED)')).toBe(
      'urn:li:activity:999',
    );
  });

  test('leaves an unrelated namespace untouched — we do not invent mappings', () => {
    expect(canonicalUrn('urn:li:organization:42')).toBe('urn:li:organization:42');
  });

  test('is idempotent', () => {
    const once = canonicalUrn('urn:li:fs_miniProfile:ABC');
    expect(canonicalUrn(once)).toBe(once);
  });
});
