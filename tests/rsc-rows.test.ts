import { describe, expect, test } from 'bun:test';
import { Rows } from '../src/engine/posts.ts';

describe('Rows', () => {
  test('rows end at a newline', () => {
    const rows = new Rows('1:"a"\n2:["$","div",null,{}]\n');
    expect(rows.byId.get('1')).toBe('"a"');
    expect(rows.byId.get('2')).toBe('["$","div",null,{}]');
  });

  // A text row is `<id>:T<hex byte length>,<text>`, and the next row follows
  // straight after, with no newline. Long recommendation texts come this way.
  test('a text row is its byte length long, multi-byte characters and newlines included', () => {
    const text = 'Jó vezető.\nHe’s great.';
    const bytes = new TextEncoder().encode(text).length.toString(16);
    const rows = new Rows(`18:T${bytes},${text}10:["$","div",null,{"children":["$18"]}]\n11:"x"`);
    expect(rows.byId.get('18')).toBe(text);
    expect(rows.isText('18')).toBe(true);
    expect(rows.byId.get('10')).toBe('["$","div",null,{"children":["$18"]}]');
    expect(rows.byId.get('11')).toBe('"x"');
    expect(rows.isText('10')).toBe(false);
  });
});
