import { describe, expect, test } from 'bun:test';
import { boxStateId, textStates } from '../src/engine/sdui-menu.ts';

const REF = {
  activityId: '7492281375731998720',
  commentId: '7492591966757715969',
  threadType: 'ugcPost' as const,
};

// A reply is a createComment whose state keys are bound to the PARENT COMMENT
// rather than to the post's opaque key. There is no parent field anywhere in
// the payload — discovered by rendering the reply box's submit button and
// reading the action it declared. The binding IS the parent reference, which is
// exactly why guessing a field name would have failed.
describe('the reply box state id', () => {
  test('is the parent comment urn, in its own namespace', () => {
    expect(boxStateId(REF)).toBe(
      'urn:li:comment:(urn:li:ugcPost:7492281375731998720,7492591966757715969)',
    );
  });

  test('keeps an activity-threaded parent as activity', () => {
    expect(boxStateId({ ...REF, threadType: 'activity' })).toBe(
      'urn:li:comment:(urn:li:activity:7492281375731998720,7492591966757715969)',
    );
  });

  // Sending the POST's binding when a reply was meant posts a TOP-LEVEL
  // comment on someone's thread. Nothing errors; it is just wrong, publicly.
  test('is never the post key — that is what makes it a reply and not a comment', () => {
    expect(boxStateId(REF)).not.toMatch(/FeedType_/);
    expect(boxStateId(REF)).toContain('urn:li:comment:');
  });
});

describe('text states built from whatever the server named the bindings', () => {
  // A reply payload calls them commentFieldBinding / richCommentFieldBinding;
  // an edit payload calls them commentary / richTextCommentary. Same job.
  test('reads the reply naming', () => {
    const s = textStates(
      {
        commentFieldBinding: { key: 'commentBoxText-X' },
        richCommentFieldBinding: { key: 'richCommentBoxText-X' },
      },
      'hello',
    );
    expect(s).toHaveLength(2);
    expect((s[0] as { key: string; value: string }).value).toBe('hello');
  });

  test('reads the edit naming', () => {
    const s = textStates(
      {
        commentary: { key: 'commentBoxText-Y' },
        richTextCommentary: { key: 'richCommentBoxText-Y' },
      },
      'hi',
    );
    expect((s[0] as { key: string }).key).toBe('commentBoxText-Y');
  });

  test('the rich slot carries a TextModel, not a bare string', () => {
    const s = textStates(
      { commentFieldBinding: { key: 'a' }, richCommentFieldBinding: { key: 'b' } },
      'x',
    );
    expect((s[1] as { value: unknown }).value).toEqual({
      text: 'x',
      attribute: [],
      $type: 'TextModel',
      source: 'local',
    });
  });

  // An unbuildable state array must be empty so callers refuse, never a
  // half-populated one that posts blank text.
  test('yields nothing when the server named neither', () => {
    expect(textStates({ somethingElse: { key: 'z' } }, 'x')).toEqual([]);
  });
});
