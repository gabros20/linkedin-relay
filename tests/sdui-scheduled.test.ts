import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduledData } from '../src/commands/live.ts';
import {
  fetchScheduled,
  PAGER_ID,
  parseScheduledPage,
  scheduledPageBody,
} from '../src/engine/sdui-scheduled.ts';

// Captured live 2026-10-13 from the scheduled-posts pager, with three probes
// scheduled (two over normShares, one from the web composer) and then with none.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8');
const THREE = fixture('sdui-scheduled-posts.rsc');
const EMPTY = fixture('sdui-scheduled-posts-empty.rsc');

describe('reading a page of scheduled posts', () => {
  // This fixture has 3 scheduled posts; the parser emits 3.
  test('every row comes back with its urn, time and text, in schedule order', () => {
    const page = parseScheduledPage(THREE);
    if (!page.ok) throw new Error(page.message);
    expect(page.claimedCount).toBe(3);
    expect(page.posts).toHaveLength(3);
    expect(page.posts.map((p) => p.urn)).toEqual([
      'urn:li:share:7515840163764436992',
      'urn:li:share:7515840596603940865',
      'urn:li:share:7515838566548217857',
    ]);
    expect(page.posts[0]?.scheduledAt).toBe(1792520728000);
    expect(page.posts[2]?.text).toBe('Reading this: https://lnkd.in/d5Qp2C2p');
  });

  // The list shows the whole text even where the UI clamps it to two lines.
  test('a long text is not truncated', () => {
    const page = parseScheduledPage(THREE);
    if (!page.ok) throw new Error(page.message);
    expect(page.posts[0]?.text).toEndWith('END-MARKER');
  });

  test('an empty queue is an empty success, and says so with a count of 0', () => {
    const page = parseScheduledPage(EMPTY);
    if (!page.ok) throw new Error(page.message);
    expect(page.claimedCount).toBe(0);
    expect(page.posts).toEqual([]);
  });

  // Never an empty success on failure: without the count we cannot tell an
  // empty queue from a page we no longer understand.
  test('a stream without the post count is schema drift, not an empty queue', () => {
    const page = parseScheduledPage('<html>login</html>');
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error('unreachable');
    expect(page.code).toBe('SCHEMA_DRIFT');
  });

  test('a count with no rows we can read is schema drift', () => {
    const page = parseScheduledPage(THREE.replaceAll('"feedUpdateUrn"', '"somethingElse"'));
    expect(page.ok).toBe(false);
  });

  // Pairing texts to rows by position is only safe when the counts agree.
  test('when the texts do not line up with the rows, no row gets a guessed text', () => {
    const broken = THREE.replace('"viewName":"mini-update-container"', '"viewName":"other"');
    const page = parseScheduledPage(broken);
    if (!page.ok) throw new Error(page.message);
    expect(page.posts).toHaveLength(3);
    expect(page.posts.every((p) => p.text === null)).toBe(true);
  });
});

describe('the pager request', () => {
  test('asks for scheduled posts from an offset', () => {
    const body = scheduledPageBody(5, 10) as {
      pagerId: string;
      paginationRequest: { requestedArguments: { payload: unknown } };
    };
    expect(body.pagerId).toBe(PAGER_ID);
    expect(body.paginationRequest.requestedArguments.payload).toEqual({
      start: 5,
      count: 10,
      shareLifeCycleState: 'ShareLifeCycleState_SCHEDULED',
    });
  });
});

/** Replies with each stream in order; records the offsets asked for. */
function scripted(...streams: string[]) {
  const starts: number[] = [];
  return {
    starts,
    request: async (spec: { body?: unknown }) => {
      const b = spec.body as {
        paginationRequest: { requestedArguments: { payload: { start: number } } };
      };
      starts.push(b.paginationRequest.requestedArguments.payload.start);
      const raw = streams.shift();
      if (raw === undefined) throw new Error('unexpected request');
      return { ok: true as const, json: null, classification: { raw } as never };
    },
  };
}

describe('fetching the queue', () => {
  test('one page is enough when it holds every post LinkedIn counts', async () => {
    const c = scripted(THREE);
    const r = await fetchScheduled(c as never);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts).toHaveLength(3);
    expect(r.state).toBe('complete');
    expect(c.starts).toEqual([0]);
  });

  test('keeps paging from where the last page ended until the count is reached', async () => {
    const c = scripted(THREE.replace('"intValue":3', '"intValue":4'), EMPTY);
    const r = await fetchScheduled(c as never, 3);
    if (!r.ok) throw new Error(r.message);
    expect(c.starts).toEqual([0, 3]);
    // Four counted, three returned: not complete, and not claimed to be.
    expect(r.state).toBe('partial');
  });

  test('the same post on two pages is listed once', async () => {
    const c = scripted(THREE.replace('"intValue":3', '"intValue":6'), THREE);
    const r = await fetchScheduled(c as never, 3);
    if (!r.ok) throw new Error(r.message);
    expect(r.posts).toHaveLength(3);
  });

  test('a refused request is an error, not an empty queue', async () => {
    const c = {
      request: async () => ({ ok: false as const, code: 'BLOCKED', message: 'refused' }),
    };
    const r = await fetchScheduled(c as never);
    expect(r.ok).toBe(false);
  });
});

describe('the scheduled command output', () => {
  test('shows when each post goes out as an ISO time, and carries the counts', () => {
    const data = scheduledData({
      ok: true,
      posts: [{ urn: 'urn:li:share:1', scheduledAt: 1792521000000, text: 'hi' }],
      claimedCount: 1,
      state: 'complete',
    });
    expect(data.items[0]).toEqual({
      urn: 'urn:li:share:1',
      scheduledAt: '2026-10-20T18:30:00.000Z',
      text: 'hi',
    });
    expect(data.meta).toEqual({ state: 'complete', returnedCount: 1, claimedCount: 1 });
  });
});
