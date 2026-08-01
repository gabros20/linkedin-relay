import { describe, expect, test } from 'bun:test';
import { shapeEntity } from '../src/format.ts';

// Shapes below are trimmed from live 2026-08-01 responses. LinkedIn wraps every
// piece of display text in a TextViewModel, so almost nothing is a bare string.

describe('search result (EntityResultViewModel)', () => {
  const row = {
    $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
    entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAB7,SEARCH_SRP,DEFAULT)',
    title: { text: 'Jenő Lustyik', $type: 'com.linkedin.voyager.dash.common.text.TextViewModel' },
    primarySubtitle: { text: 'Software Developer | Go, Python, Rust' },
    secondarySubtitle: { text: 'Budapest' },
    navigationUrl:
      'https://www.linkedin.com/in/lustyikjeno?miniProfileUrn=urn%3Ali%3Afs_miniProfile',
  };

  test('lifts the name out of its TextViewModel', () => {
    expect(shapeEntity(row).name).toBe('Jenő Lustyik');
  });

  test('maps the subtitles to headline and location', () => {
    expect(shapeEntity(row).headline).toBe('Software Developer | Go, Python, Rust');
    expect(shapeEntity(row).location).toBe('Budapest');
  });

  // The tracking query string is noise and changes per request — keeping it
  // would make otherwise-identical results look different run to run.
  test('strips tracking parameters from the profile url', () => {
    expect(shapeEntity(row).url).toBe('https://www.linkedin.com/in/lustyikjeno');
  });

  // entityUrn is a composite: (profileUrn, SEARCH_SRP, DEFAULT). The member
  // identity is its first member, not the whole string.
  test('extracts the member urn from the composite entity urn', () => {
    expect(shapeEntity(row).urn).toBe('urn:li:fsd_profile:ACoAAB7');
  });
});

describe('feed post (UpdateV2)', () => {
  const post = {
    $type: 'com.linkedin.voyager.feed.render.UpdateV2',
    commentary: { text: { text: 'THIS' } },
    actor: { name: { text: 'Dan Monaghan' }, subDescription: { text: '3d •   ' } },
    updateMetadata: { urn: 'urn:li:activity:7489428563075637248' },
  };

  test('lifts the post text out of its doubly-nested wrapper', () => {
    expect(shapeEntity(post).text).toBe('THIS');
  });

  test('reads the author name', () => {
    expect(shapeEntity(post).author).toBe('Dan Monaghan');
  });

  test('builds a permalink from the activity urn', () => {
    expect(shapeEntity(post).url).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:7489428563075637248/',
    );
  });

  test('trims the whitespace LinkedIn pads its subdescriptions with', () => {
    expect(shapeEntity(post).posted).toBe('3d •');
  });
});

describe('member profile (MiniProfile)', () => {
  const me = {
    $type: 'com.linkedin.voyager.identity.shared.MiniProfile',
    entityUrn: 'urn:li:fs_miniProfile:ACoAABkU2Wk',
    firstName: 'Tamas',
    lastName: 'Gabor',
    publicIdentifier: 'tamas-gr',
    occupation: 'Photographer, Frontend Developer',
  };

  test('joins the name parts', () => {
    expect(shapeEntity(me).name).toBe('Tamas Gabor');
  });

  test('falls back from headline to occupation across shapes', () => {
    expect(shapeEntity(me).headline).toBe('Photographer, Frontend Developer');
  });

  test('builds the profile url from the public identifier', () => {
    expect(shapeEntity(me).url).toBe('https://www.linkedin.com/in/tamas-gr/');
  });
});

describe('unknown shapes', () => {
  // The parser deliberately passes unrecognised types through as data. The
  // shaper must not then discard them — it returns what it can find and always
  // reports the type, so a new shape is visible rather than blank.
  test('an unfamiliar entity still yields its type rather than nothing', () => {
    const future = { $type: 'com.linkedin.voyager.feed.render.UpdateV7', mystery: 1 };
    expect(shapeEntity(future).type).toBe('com.linkedin.voyager.feed.render.UpdateV7');
  });

  test('never throws on a malformed node', () => {
    expect(() => shapeEntity({ $type: null, title: 'not an object' })).not.toThrow();
  });
});
