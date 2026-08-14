import { describe, expect, test } from 'bun:test';
import {
  actionUrl,
  DELETE_OP,
  extractActionPayload,
  menuBody,
  UPDATE_OP,
} from '../src/engine/sdui-menu.ts';

// Shaped like the real 439 KB menu response: an RSC stream, not JSON, with each
// action's payload nested several levels deep.
const STREAM =
  `1:I[123,[],""]\n` +
  `2:{"$type":"proto.sdui.actions.requests.ServerRequest","requestId":"${UPDATE_OP}",` +
  `"payload":{"commentUrn":{"commentId":"7493773969058062336","thread":"urn:li:activity:66"},` +
  `"commentBoxStateId":"urn:li:comment:(urn:li:activity:66,7493773969058062336)"}}\n` +
  `3:{"requestId":"${DELETE_OP}","payload":{"commentUrn":{"commentId":"749","thread":"urn:li:activity:66"},` +
  `"containerThreadUrn":{"threadUrnActivityThreadUrn":{"activityUrn":{"activityId":"66"}}}}}\n`;

describe('reading an action out of a menu stream', () => {
  test('finds the delete payload', () => {
    const p = extractActionPayload(STREAM, DELETE_OP) as { commentUrn: { commentId: string } };
    expect(p.commentUrn.commentId).toBe('749');
  });

  // Brace-matching, not a regex: these payloads nest and a greedy match would
  // swallow the rest of the stream.
  test('stops at the payload boundary rather than swallowing the stream', () => {
    const p = extractActionPayload(STREAM, DELETE_OP) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['commentUrn', 'containerThreadUrn']);
  });

  test('finds a different action independently', () => {
    const p = extractActionPayload(STREAM, UPDATE_OP) as { commentBoxStateId: string };
    expect(p.commentBoxStateId).toBe('urn:li:comment:(urn:li:activity:66,7493773969058062336)');
  });

  test('an absent action yields null rather than a wrong payload', () => {
    expect(extractActionPayload(STREAM, 'com.linkedin.sdui.comments.nope')).toBeNull();
  });

  test('a truncated stream yields null rather than a partial object', () => {
    expect(
      extractActionPayload(`{"requestId":"${DELETE_OP}","payload":{"a":`, DELETE_OP),
    ).toBeNull();
  });

  // Braces inside string values must not be counted as nesting.
  test('braces inside strings do not confuse the matcher', () => {
    const tricky = `"${DELETE_OP}" "payload":{"note":"a } brace","id":"7"}`;
    const p = extractActionPayload(tricky, DELETE_OP) as { id: string };
    expect(p.id).toBe('7');
  });
});

describe('the menu request', () => {
  test('targets the menu operation', () => {
    expect(actionUrl(DELETE_OP)).toContain(`sduiid=${DELETE_OP}`);
  });

  const REF = { activityId: '66', commentId: '749', threadType: 'activity' as const };

  test('carries the comment and its parent thread', () => {
    const b = menuBody(REF, 'TRACK==') as never as {
      requestedArguments: { payload: { commentUrn: { commentId: string; thread: string } } };
    };
    expect(b.requestedArguments.payload.commentUrn).toEqual({
      commentId: '749',
      thread: 'urn:li:activity:66',
    });
  });

  test('each request gets a fresh menu ref', () => {
    expect(JSON.stringify(menuBody(REF, 'T'))).not.toBe(JSON.stringify(menuBody(REF, 'T')));
  });
});
