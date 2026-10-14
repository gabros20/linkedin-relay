import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, saveJson } from '../src/cache/store.ts';
import {
  type MessagingFetch,
  runDraft,
  runDraftRemove,
  runDrafts,
  runInbox,
  runMessages,
} from '../src/commands/messaging.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const CONVERSATIONS = fixture('messaging-conversations.json');
const MESSAGES = fixture('messaging-messages.json');
const CONV = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAATESTME,2-TESTCONV1==)';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-msg-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
  saveJson(cachePath('me.json'), { profileUrn: 'urn:li:fsd_profile:ACoAATESTME' });
});
afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

/** Serves the captured folder (then an empty page) and the captured messages. GETs only. */
function linkedin() {
  const asked: { url: string; spendClass: string }[] = [];
  const fetch: MessagingFetch = async (url, spendClass) => {
    asked.push({ url, spendClass });
    if (url.includes('messengerMessages')) return { ok: true, json: MESSAGES };
    if (url.includes('nextCursor')) {
      const empty = structuredClone(CONVERSATIONS);
      const d = empty.data.data;
      const k = Object.keys(d).find((x) => x.startsWith('messenger')) as string;
      // As LinkedIn sends the page after the last: `elements: []`, no `*elements`.
      delete d[k]['*elements'];
      d[k].elements = [];
      d[k].metadata = { nextCursor: null };
      return { ok: true, json: empty };
    }
    return { ok: true, json: CONVERSATIONS };
  };
  return { fetch, asked };
}

const data = (e: Awaited<ReturnType<typeof runInbox>>) => {
  if (!e.ok) throw new Error(e.error.message);
  return e.data as { items: Record<string, unknown>[]; meta: Record<string, unknown> };
};

describe('lnrelay inbox', () => {
  test('a folder, paged by cursor to the limit, on the page budget', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runInbox({ folder: 'archive', limit: 50 }, {}, fetch));
    expect(r.items).toHaveLength(16);
    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a.spendClass === 'page')).toBe(true);
    expect(decodeURIComponent(asked[0]?.url ?? '')).toContain('category:ARCHIVE');
    expect(r.meta).toMatchObject({ state: 'complete', returnedCount: 16, unread: 7 });
  });

  test('--unread keeps the conversations with unread messages', async () => {
    const r = data(
      await runInbox({ folder: 'archive', limit: 50, unread: true }, {}, linkedin().fetch),
    );
    expect(r.items).toHaveLength(7);
    expect(r.items.every((c) => (c.unread as number) > 0)).toBe(true);
  });

  test('the limit stops the paging and says the list is partial', async () => {
    const { fetch, asked } = linkedin();
    const r = data(await runInbox({ folder: 'archive', limit: 5 }, {}, fetch));
    expect(r.items).toHaveLength(5);
    expect(asked).toHaveLength(1);
    expect(r.meta.state).toBe('partial');
  });

  test('an unknown folder is refused with the ones that exist', async () => {
    const r = await runInbox({ folder: 'trash' as never, limit: 5 }, {}, linkedin().fetch);
    if (r.ok) throw new Error('expected refusal');
    expect(r.error.hint).toContain('archive');
  });

  test('--compact is one line per conversation', async () => {
    const r = data(
      await runInbox({ folder: 'archive', limit: 1 }, { compact: true }, linkedin().fetch),
    );
    expect(String(r.items[0])).toBe(
      'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAATESTME,2-TESTCONV1==) | Text 119 | ' +
        `${new Date(1788365776872).toISOString().slice(0, 10)} | InMail | Text 119: Text 60`,
    );
  });
});

describe('lnrelay messages', () => {
  test('a conversation by thread URL, oldest first', async () => {
    const { fetch, asked } = linkedin();
    const r = await runMessages(
      'https://www.linkedin.com/messaging/thread/2-TESTCONV1==/',
      {},
      fetch,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toContain('2-TESTCONV1==');
    const d = r.data as { conversation: string; items: unknown[]; meta: Record<string, unknown> };
    expect(d.conversation).toBe(CONV);
    expect(d.items).toHaveLength(1);
    // Fewer than a page: nothing older is held back.
    expect(d.meta.state).toBe('complete');
  });

  test('something that is not a conversation is refused', async () => {
    expect((await runMessages('hello', {}, linkedin().fetch)).ok).toBe(false);
  });
});

describe('drafts', () => {
  test('a draft is kept locally, owner-only, and nothing is sent', async () => {
    const { fetch, asked } = linkedin();
    const r = await runDraft(CONV, 'Thanks, I will get back to you.', fetch);
    if (!r.ok) throw new Error(r.error.message);
    // One read, to check the conversation exists and name who it is to.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toContain('messengerMessages');
    expect(r.data).toMatchObject({
      saved: true,
      sent: false,
      draft: {
        conversation: CONV,
        url: 'https://www.linkedin.com/messaging/thread/2-TESTCONV1==/',
        text: 'Thanks, I will get back to you.',
      },
    });
    expect(statSync(cachePath('drafts.json')).mode & 0o777).toBe(0o600);
  });

  test('drafts are listed, and removed by id', async () => {
    const { fetch } = linkedin();
    const made = await runDraft(CONV, 'first', fetch);
    if (!made.ok) throw new Error(made.error.message);
    const id = (made.data as { draft: { id: string } }).draft.id;
    const listed = runDrafts();
    if (!listed.ok) throw new Error(listed.error.message);
    expect((listed.data as { items: { id: string }[] }).items.map((d) => d.id)).toEqual([id]);
    const removed = runDraftRemove(id);
    expect(removed.ok).toBe(true);
    const after = runDrafts();
    if (!after.ok) throw new Error(after.error.message);
    expect((after.data as { items: unknown[] }).items).toEqual([]);
  });

  test('an empty draft, or a draft to nowhere, is refused before any call', async () => {
    const { fetch, asked } = linkedin();
    expect((await runDraft(CONV, '   ', fetch)).ok).toBe(false);
    expect((await runDraft('nowhere', 'hi', fetch)).ok).toBe(false);
    expect(asked).toHaveLength(0);
  });

  test('removing a draft that does not exist says so', () => {
    expect(runDraftRemove('nope').ok).toBe(false);
  });
});
