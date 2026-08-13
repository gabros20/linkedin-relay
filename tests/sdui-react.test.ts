import { describe, expect, test } from 'bun:test';
import {
  REACTIONS,
  reactionLabel,
  reactionPayload,
  reactionUrl,
  sduiBody,
  targetFor,
} from '../src/engine/sdui-write.ts';

// Every shape here was captured from live traffic on 2026-08-13 — the user
// cycled all six reaction types on a post and on a comment while an observer
// recorded. Nothing in this file is inferred from a repo or a doc.

describe('the endpoint', () => {
  test('is the SDUI action route, not Voyager', () => {
    expect(reactionUrl('create')).toContain('/flagship-web/rsc-action/actions/server-request');
  });

  test('names the operation in the sduiid parameter', () => {
    expect(reactionUrl('create')).toContain('sduiid=com.linkedin.sdui.reactions.create');
    expect(reactionUrl('delete')).toContain('sduiid=com.linkedin.sdui.reactions.delete');
  });
});

describe('reaction types', () => {
  // The prefix is not decoration. `LIKE` alone is what the one OSS sample
  // sent, and it is not what the live client sends.
  test('are prefixed, matching what the live client sends', () => {
    expect(reactionPayload(targetFor('urn:li:activity:71'), 'LIKE').reactionType).toBe(
      'ReactionType_LIKE',
    );
  });

  test('cover all six the UI offers', () => {
    expect([...REACTIONS].sort()).toEqual([
      'APPRECIATION',
      'EMPATHY',
      'ENTERTAINMENT',
      'INTEREST',
      'LIKE',
      'PRAISE',
    ]);
  });
});

describe('the target', () => {
  // A post and a comment take structurally different threadUrn objects, and
  // a different reactionSource. Sending one shape for the other is the silent
  // failure this whole capture existed to avoid.
  test('a post carries a bare numeric activity id, not a urn string', () => {
    const t = targetFor('urn:li:activity:7000000000000000001');
    expect(t.threadUrn).toEqual({
      threadUrnActivityThreadUrn: { activityUrn: { activityId: '7000000000000000001' } },
    });
    expect(t.reactionSource).toBe('Update');
  });

  test('a comment carries its id AND its parent thread', () => {
    const t = targetFor('urn:li:comment:(urn:li:activity:999,4242)');
    expect(t.threadUrn).toEqual({
      threadUrnCommentThreadUrn: {
        commentUrn: { commentId: '4242', thread: 'urn:li:activity:999' },
      },
    });
    expect(t.reactionSource).toBe('Comment');
  });

  test('an unusable urn is refused rather than sent as an empty target', () => {
    expect(() => targetFor('urn:li:person:ACoAAB')).toThrow();
    expect(() => targetFor('nonsense')).toThrow();
  });
});

describe('the request body', () => {
  const body = sduiBody('create', targetFor('urn:li:activity:71'), 'PRAISE');

  test('repeats the operation id where the live client repeats it', () => {
    expect(body.requestId).toBe('com.linkedin.sdui.reactions.create');
    expect(body.serverRequest.requestId).toBe('com.linkedin.sdui.reactions.create');
  });

  test('carries the payload in both places the live client carries it', () => {
    expect(body.serverRequest.requestedArguments.payload).toEqual(
      body.requestedArguments.payload as never,
    );
  });

  test('declares the screen the action originates from', () => {
    expect(body.requestedArguments.screenId).toBe(
      'com.linkedin.sdui.flagshipnav.feed.UpdateDetail',
    );
  });

  // Reactions need no page-derived token — this is exactly what makes them
  // replayable when `comment` is not.
  test('contains no tracking id or binding key that only a rendered page has', () => {
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('trackingId');
    expect(raw).not.toContain('MemoryNamespace');
  });

  test('sends an empty states array, as the live client does', () => {
    expect(body.states).toEqual([]);
  });

  test('a delete carries the reaction type being removed', () => {
    const d = sduiBody('delete', targetFor('urn:li:activity:71'), 'INTEREST');
    expect(d.requestedArguments.payload.reactionType).toBe('ReactionType_INTEREST');
  });
});

// LinkedIn's enum names are not its UI labels: PRAISE renders as "Celebrate",
// INTEREST as "Insightful". Verified live — `--type PRAISE` produced a
// Celebrate. Someone picking a reaction should not have to discover that by
// posting the wrong one to a real person's post.
describe('reaction labels', () => {
  test('maps each enum to the label the UI actually shows', () => {
    expect(reactionLabel('PRAISE')).toBe('Celebrate');
    expect(reactionLabel('INTEREST')).toBe('Insightful');
    expect(reactionLabel('LIKE')).toBe('Like');
  });

  test('every reaction has a label — no silent gaps', () => {
    for (const r of REACTIONS) {
      expect(reactionLabel(r).length).toBeGreaterThan(0);
    }
  });
});
