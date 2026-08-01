import { describe, expect, test } from 'bun:test';
import { indexIncluded, parseCollection, parseSingle, resolveRefs } from '../src/engine/parse.ts';

// Shapes below mirror live 2026-08-01 captures (docs/ENGINE-RESEARCH.md §4, §5c)
// with the content replaced. The structure is real; the people are not.

const FEED = {
  data: {
    '*elements': ['urn:li:activity:100', 'urn:li:activity:200', 'urn:li:activity:300'],
  },
  included: [
    // Deliberately out of order — `included[]` is an unordered side-table.
    { entityUrn: 'urn:li:activity:300', $type: 'com.linkedin.voyager.feed.render.UpdateV2', commentary: 'third' },
    { entityUrn: 'urn:li:activity:100', $type: 'com.linkedin.voyager.feed.render.UpdateV2', commentary: 'first' },
    { entityUrn: 'urn:li:activity:200', $type: 'com.linkedin.voyager.feed.render.UpdateV2', commentary: 'second' },
    // Supporting decorations — real types from the live feed capture.
    { entityUrn: 'urn:li:socialDetail:100', $type: 'com.linkedin.voyager.feed.SocialDetail' },
    { entityUrn: 'urn:li:profile:9', $type: 'com.linkedin.voyager.identity.shared.MiniProfile' },
  ],
};

describe('indexIncluded', () => {
  test('indexes every node by its entityUrn in one pass', () => {
    const index = indexIncluded(FEED.included);
    expect(index.size).toBe(5);
    expect(index.get('urn:li:activity:200')?.commentary).toBe('second');
  });

  // The live /me response carries the same member under both namespaces.
  // Collapsing them is what makes cross-referencing work at all.
  test('canonicalises legacy namespaces so both forms resolve to one entry', () => {
    const index = indexIncluded([
      { entityUrn: 'urn:li:fs_miniProfile:ABC', $type: 'x', name: 'once' },
    ]);
    expect(index.get('urn:li:fsd_profile:ABC')?.name).toBe('once');
    expect(index.get('urn:li:fs_miniProfile:ABC')?.name).toBe('once');
  });

  test('a node without an entityUrn is skipped rather than crashing', () => {
    expect(indexIncluded([{ $type: 'x' }, { entityUrn: 'urn:li:a:1', $type: 'y' }]).size).toBe(1);
  });

  test('tolerates a missing or non-array included', () => {
    expect(indexIncluded(undefined).size).toBe(0);
  });
});

describe('resolveRefs', () => {
  test('returns entities in the order data specifies, not included order', () => {
    const { resolved } = resolveRefs(FEED.data['*elements'], indexIncluded(FEED.included));
    expect(resolved.map((r) => r.commentary)).toEqual(['first', 'second', 'third']);
  });

  // The three-state rule. A reference that cannot be resolved is a FAILED
  // decoration, not an absent field — it must never silently vanish.
  test('records an unresolvable reference instead of dropping it silently', () => {
    const { resolved, unresolved } = resolveRefs(
      ['urn:li:activity:100', 'urn:li:activity:999'],
      indexIncluded(FEED.included),
    );
    expect(resolved).toHaveLength(1);
    expect(unresolved).toEqual(['urn:li:activity:999']);
  });
});

describe('parseCollection', () => {
  test('returns the content entities in order', () => {
    const { items } = parseCollection(FEED, { operation: 'feed' });
    expect(items.map((i) => i.commentary)).toEqual(['first', 'second', 'third']);
  });

  test('reports state complete when every reference resolved', () => {
    expect(parseCollection(FEED, { operation: 'feed' }).meta.state).toBe('complete');
  });

  test('an unresolved reference makes the result partial, never complete', () => {
    const broken = { ...FEED, data: { '*elements': [...FEED.data['*elements'], 'urn:li:activity:404'] } };
    const { meta } = parseCollection(broken, { operation: 'feed' });
    expect(meta.state).toBe('partial');
    expect(meta.unresolved).toHaveLength(1);
  });

  // The counting invariant. Every candidate is accounted for as parsed,
  // deliberately excluded, or unknown — so silent loss is arithmetically
  // impossible rather than merely unlikely.
  test('every raw candidate is accounted for', () => {
    const { meta } = parseCollection(FEED, { operation: 'feed' });
    expect(meta.rawCandidateCount).toBe(meta.parsedCount + meta.excludedCount + meta.unknownCount);
  });
});

// The load-bearing rule, carried over from x-relay where an accept-list
// silently dropped every reply in every thread while returning ok:true.
describe('exclusion filtering', () => {
  const withNoise = {
    data: { '*elements': ['urn:li:activity:1', 'urn:li:activity:2', 'urn:li:activity:3'] },
    included: [
      { entityUrn: 'urn:li:activity:1', $type: 'com.linkedin.voyager.feed.render.UpdateV2', commentary: 'real' },
      { entityUrn: 'urn:li:activity:2', $type: 'com.linkedin.voyager.feed.PromotedUpdate', commentary: 'ad' },
      { entityUrn: 'urn:li:activity:3', $type: 'com.linkedin.voyager.feed.FeedDiscoveryModule' },
    ],
  };

  test('drops known noise', () => {
    const { items } = parseCollection(withNoise, { operation: 'feed' });
    expect(items.map((i) => i.commentary)).toEqual(['real']);
  });

  test('counts what it deliberately excluded', () => {
    expect(parseCollection(withNoise, { operation: 'feed' }).meta.excludedCount).toBe(2);
  });

  // The whole point of exclusion-over-accept-list: a type we have never seen
  // arrives as DATA, not as silence.
  test('an unrecognised type passes through as content rather than being dropped', () => {
    const future = {
      data: { '*elements': ['urn:li:activity:1'] },
      included: [
        { entityUrn: 'urn:li:activity:1', $type: 'com.linkedin.voyager.feed.render.UpdateV7', commentary: 'new shape' },
      ],
    };
    const { items, meta } = parseCollection(future, { operation: 'feed' });
    expect(items).toHaveLength(1);
    expect(meta.unknownCount).toBe(1);
  });

  test('surfaces unknown types in the envelope so drift is visible immediately', () => {
    const future = {
      data: { '*elements': ['urn:li:activity:1'] },
      included: [{ entityUrn: 'urn:li:activity:1', $type: 'com.linkedin.voyager.feed.UpdateV7' }],
    };
    const { meta } = parseCollection(future, { operation: 'feed' });
    expect(meta.unknownTypes).toEqual([{ type: 'com.linkedin.voyager.feed.UpdateV7', count: 1 }]);
  });

  test('still drops noise even when its type is only known by fragment', () => {
    const sponsored = {
      data: { '*elements': ['urn:li:activity:1'] },
      included: [{ entityUrn: 'urn:li:activity:1', $type: 'com.linkedin.voyager.feed.SponsoredThing' }],
    };
    expect(parseCollection(sponsored, { operation: 'feed' }).items).toHaveLength(0);
  });
});

describe('claimed vs returned', () => {
  // claimed > 0 with returned 0 is a failed fetch wearing the costume of an
  // empty result — the exact bug class this project keeps finding.
  test('claimed but nothing returned raises a warning', () => {
    const empty = { data: { '*elements': [] }, included: [] };
    const { meta } = parseCollection(empty, { operation: 'post', claimedCount: 12 });
    expect(meta.warnings.join(' ')).toMatch(/failed fetch/i);
  });

  test('claimed zero and returned zero is a genuine empty, with no warning', () => {
    const empty = { data: { '*elements': [] }, included: [] };
    expect(parseCollection(empty, { operation: 'post', claimedCount: 0 }).meta.warnings).toEqual([]);
  });
});

// Search does NOT use a top-level "*elements" array. It nests clusters, each
// with items, each holding a SINGLE "*entityResult" string reference. Shape
// captured live 2026-08-01 (docs/ENGINE-RESEARCH.md §5a) — a second response
// family that a one-shape parser silently returns nothing for.
describe('cluster/inline reference shape (search)', () => {
  const SEARCH = {
    data: {
      data: {
        searchDashClustersByAll: {
          metadata: { totalResultCount: 1_457_213 },
          elements: [
            {
              items: [
                { item: { '*entityResult': 'urn:li:fsd_entityResultViewModel:1' }, position: 0 },
                { item: { '*entityResult': 'urn:li:fsd_entityResultViewModel:2' }, position: 1 },
              ],
            },
            { items: [{ item: { '*entityResult': 'urn:li:fsd_entityResultViewModel:3' } }] },
          ],
        },
      },
    },
    included: [
      { entityUrn: 'urn:li:fsd_entityResultViewModel:2', $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel', name: 'second' },
      { entityUrn: 'urn:li:fsd_entityResultViewModel:1', $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel', name: 'first' },
      { entityUrn: 'urn:li:fsd_entityResultViewModel:3', $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel', name: 'third' },
      { entityUrn: 'urn:li:fsd_profile:A', $type: 'com.linkedin.voyager.dash.identity.profile.Profile' },
      { entityUrn: 'urn:li:x:1', $type: 'com.linkedin.voyager.dash.search.FeedbackCard' },
      { entityUrn: 'urn:li:x:2', $type: 'com.linkedin.voyager.dash.search.LazyLoadedActions' },
    ],
  };

  test('finds single-string refs nested across clusters', () => {
    expect(parseCollection(SEARCH, { operation: 'search' }).items).toHaveLength(3);
  });

  test('preserves document order across cluster boundaries', () => {
    const { items } = parseCollection(SEARCH, { operation: 'search' });
    expect(items.map((i) => i.name)).toEqual(['first', 'second', 'third']);
  });

  test('search chrome is excluded, not returned as results', () => {
    const { items } = parseCollection(SEARCH, { operation: 'search' });
    expect(items.some((i) => String(i.$type).includes('FeedbackCard'))).toBe(false);
  });
});

describe('single-entity responses', () => {
  // /me is not a collection — it has no reference list at all, just one
  // decorated node in included[].
  test('parseSingle returns the lone included entity', () => {
    const me = {
      data: { $type: 'com.linkedin.voyager.common.Me' },
      included: [
        { entityUrn: 'urn:li:fs_miniProfile:ABC', $type: 'com.linkedin.voyager.identity.shared.MiniProfile', firstName: 'Ada' },
      ],
    };
    expect(parseSingle(me)?.firstName).toBe('Ada');
  });

  test('returns undefined rather than throwing when there is nothing', () => {
    expect(parseSingle({ data: {}, included: [] })).toBeUndefined();
  });
});

describe('fault isolation', () => {
  test('one malformed node never kills the page', () => {
    const mixed = {
      data: { '*elements': ['urn:li:activity:1', 'urn:li:activity:2'] },
      included: [
        { entityUrn: 'urn:li:activity:1', $type: 'com.linkedin.voyager.feed.render.UpdateV2', commentary: 'fine' },
        { entityUrn: 'urn:li:activity:2', $type: null, commentary: 'weird' },
      ],
    };
    expect(() => parseCollection(mixed, { operation: 'feed' })).not.toThrow();
    expect(parseCollection(mixed, { operation: 'feed' }).items.length).toBeGreaterThan(0);
  });
});
