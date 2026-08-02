import { describe, expect, test } from 'bun:test';
import { compactRows, project } from '../src/format.ts';

const rows = [
  { name: 'Bence Fűzfa', headline: 'Software Developer', location: 'Budapest', urn: 'urn:li:p:1' },
  {
    name: 'Zsófia Kőváry',
    headline: 'Frontend Developer',
    location: 'Budapest',
    urn: 'urn:li:p:2',
  },
];

describe('--fields', () => {
  test('keeps only the requested keys', () => {
    expect(project(rows, 'name,location')).toEqual([
      { name: 'Bence Fűzfa', location: 'Budapest' },
      { name: 'Zsófia Kőváry', location: 'Budapest' },
    ]);
  });

  test('preserves the order the user asked for', () => {
    expect(Object.keys(project(rows, 'location,name')[0] ?? {})).toEqual(['location', 'name']);
  });

  test('tolerates whitespace around names', () => {
    expect(project(rows, ' name , location ')[0]).toEqual({
      name: 'Bence Fűzfa',
      location: 'Budapest',
    });
  });

  // Silently returning nothing for a typo'd field is the failure mode this
  // project keeps designing against — an empty result that looks like data.
  test('a field no row has is omitted rather than emitted as undefined', () => {
    expect(project(rows, 'name,nonexistent')[0]).toEqual({ name: 'Bence Fűzfa' });
  });

  test('an empty spec returns the rows untouched', () => {
    expect(project(rows, '')).toEqual(rows);
  });
});

describe('--compact', () => {
  test('renders one flat line per row', () => {
    expect(compactRows(rows)).toHaveLength(2);
  });

  test('leads with the most identifying field', () => {
    expect(compactRows(rows)[0]).toContain('Bence Fűzfa');
  });

  test('includes the headline so a row is rankable without a second call', () => {
    expect(compactRows(rows)[0]).toContain('Software Developer');
  });

  test('drops absent fields rather than printing empty separators', () => {
    const sparse = [{ name: 'Solo' }];
    expect(compactRows(sparse)[0]).toBe('Solo');
  });

  test('falls back to the urn when a row has no human-readable field', () => {
    expect(compactRows([{ urn: 'urn:li:activity:1' }])[0]).toContain('urn:li:activity:1');
  });

  test('a post row leads with author and text rather than a missing name', () => {
    const post = [{ author: 'Liz Ryan', text: 'a long post body', likes: 72 }];
    const line = compactRows(post)[0] ?? '';
    expect(line).toContain('Liz Ryan');
    expect(line).toContain('a long post body');
  });

  test('never emits a newline inside a row — one row, one line', () => {
    const multiline = [{ author: 'X', text: 'first line\nsecond line' }];
    expect(compactRows(multiline)[0]).not.toContain('\n');
  });
});
