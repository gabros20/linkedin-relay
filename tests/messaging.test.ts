import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  conversationIdOf,
  conversationsUrl,
  FOLDERS,
  mailboxOf,
  messagesUrl,
  parseConversations,
  parseMessages,
} from '../src/engine/messaging.ts';

// Captured 2026-10-14 from the owner's own mailbox, then redacted whole: every
// name, headline, message, subject and preview is a placeholder ("Text N"),
// every id is a test id, the owner is ACoAATESTME. The archive folder (16
// conversations, all InMail), and the messages of two of them: one from a
// member, one from a company. Reading these sent nothing: no read receipt,
// no "seen", no delivery acknowledgement — those are separate POSTs.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));
const CONVERSATIONS = fixture('messaging-conversations.json');
const MESSAGES = fixture('messaging-messages.json');
const FROM_COMPANY = fixture('messaging-messages-org.json');
const ME = mailboxOf('urn:li:fs_miniProfile:ACoAATESTME');

const variables = (url: string) => new URL(url).search;

describe('requests', () => {
  test('the mailbox is the owner profile, from the urn whoami gives', () => {
    expect(ME).toBe('urn:li:fsd_profile:ACoAATESTME');
  });

  test('a folder of conversations, 20 at a time, from a cursor', () => {
    expect(FOLDERS).toMatchObject({
      primary: 'PRIMARY_INBOX',
      other: 'SECONDARY_INBOX',
      inbox: 'INBOX',
      archive: 'ARCHIVE',
      requests: 'MESSAGE_REQUEST_PENDING',
      spam: 'SPAM',
    });
    const url = conversationsUrl({ mailbox: ME, folder: 'archive', cursor: 'abc=' });
    expect(new URL(url).pathname).toBe('/voyager/api/voyagerMessagingGraphQL/graphql');
    expect(variables(url)).toContain('queryId=messengerConversations.');
    expect(decodeURIComponent(variables(url))).toContain(
      '(query:(predicateUnions:List((conversationCategoryPredicate:(category:ARCHIVE)))),count:20,mailboxUrn:urn:li:fsd_profile:ACoAATESTME,nextCursor:abc=)',
    );
  });

  // The browser leaves the `=` of a conversation id raw; percent-encoding it
  // is answered with a 400.
  test("a conversation's messages, its urn encoded as the browser does", () => {
    const url = messagesUrl(
      'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAATESTME,2-TESTCONV1==)',
    );
    expect(variables(url)).toContain(
      'variables=(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AACoAATESTME%2C2-TESTCONV1==%29)',
    );
  });
});

describe('conversation ids', () => {
  test('from a urn, a thread URL, or a bare thread id', () => {
    const urn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAATESTME,2-TESTCONV1==)';
    expect(conversationIdOf(urn, ME)).toBe(urn);
    expect(conversationIdOf('https://www.linkedin.com/messaging/thread/2-TESTCONV1==/', ME)).toBe(
      urn,
    );
    expect(conversationIdOf('2-TESTCONV1==', ME)).toBe(urn);
    expect(conversationIdOf('hello', ME)).toBeUndefined();
  });
});

describe('a folder of conversations', () => {
  // This page lists 16 conversations; the parser emits 16, newest first.
  test('every conversation, with the other side, the last message and the unread count', () => {
    const r = parseConversations(CONVERSATIONS, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.conversations).toHaveLength(16);
    expect(r.cursor).toEqual(expect.any(String));
    expect(r.conversations[0]).toEqual({
      id: 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAATESTME,2-TESTCONV1==)',
      url: 'https://www.linkedin.com/messaging/thread/2-TESTCONV1==/',
      with: [
        {
          name: 'Text 119',
          kind: 'organization',
          url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/company\//),
        },
      ],
      unread: 0,
      lastActivity: new Date(1788365776872).toISOString(),
      // An InMail ad: LinkedIn marks it sponsored.
      last: {
        from: 'Text 119',
        fromMe: false,
        at: new Date(1788365776872).toISOString(),
        text: 'Text 60',
        sponsored: true,
      },
      folders: ['archive'],
      inmail: true,
    });
  });

  test('the owner is never listed among the people a conversation is with', () => {
    const r = parseConversations(CONVERSATIONS, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.conversations.flatMap((c) => c.with).some((p) => p.url?.includes('ACoAATESTME'))).toBe(
      false,
    );
    expect(r.conversations.every((c) => c.with.length > 0)).toBe(true);
  });

  test('unread counts are kept: 7 conversations here have unread messages', () => {
    const r = parseConversations(CONVERSATIONS, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.conversations.filter((c) => c.unread > 0)).toHaveLength(7);
  });

  test('a member on the other side carries headline, degree and profile url', () => {
    const r = parseConversations(CONVERSATIONS, ME);
    if (!r.ok) throw new Error(r.message);
    const person = r.conversations.flatMap((c) => c.with).find((p) => p.kind === 'person');
    expect(person).toMatchObject({
      // First and last name; a one-letter surname initial was left as is.
      name: expect.stringMatching(/^Text \d+ \S+$/),
      url: expect.stringMatching(/^https:\/\/www\.linkedin\.com\/in\/person-\d+\/$/),
      degree: expect.any(String),
    });
  });

  // The page after the last, as LinkedIn sends it: `elements: []`, no `*elements`.
  test('the empty page after the last is an empty list, not drift', () => {
    const empty = {
      data: {
        data: {
          messengerConversationsByCategoryQuery: { metadata: { nextCursor: null }, elements: [] },
        },
      },
      included: [],
    };
    const r = parseConversations(empty, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.conversations).toEqual([]);
    expect(r.cursor).toBeUndefined();
  });

  test('a page that lists conversations it does not send is drift', () => {
    expect(parseConversations({ ...CONVERSATIONS, included: [] }, ME).ok).toBe(false);
  });

  test('a response without a conversation list is drift', () => {
    expect(parseConversations({ data: { data: {} } }, ME).ok).toBe(false);
  });
});

describe('the messages of a conversation', () => {
  test('a message from a member: who, when, the text, and that it is not the owner', () => {
    const r = parseMessages(MESSAGES, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      from: expect.stringMatching(/^Text \d+ Text \d+$/),
      fromMe: false,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      text: expect.stringMatching(/^Text \d+$/),
    });
  });

  test('a message from a company is named by the company', () => {
    const r = parseMessages(FROM_COMPANY, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.messages[0]?.from).toMatch(/^Text \d+$/);
    expect(r.messages[0]?.fromMe).toBe(false);
  });

  test("the owner's own messages say so", () => {
    // The same message, as if the owner had sent it.
    const mine = JSON.parse(
      JSON.stringify(MESSAGES).replace(
        /("\*sender":"urn:li:msg_messagingParticipant:)urn:li:fsd_profile:ACoAATESTPERSON\d+/g,
        '$1urn:li:fsd_profile:ACoAATESTME',
      ),
    );
    const r = parseMessages(mine, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.messages[0]?.fromMe).toBe(true);
    expect(r.messages[0]?.from).toBe('you');
  });

  test('messages come oldest first, the way a conversation reads', () => {
    const two = structuredClone(MESSAGES);
    const msg = two.included.find((i: { $type: string }) => i.$type.endsWith('.Message'));
    const older = {
      ...msg,
      entityUrn: `${msg.entityUrn}-older`,
      deliveredAt: msg.deliveredAt - 60_000,
    };
    two.included.push(older);
    const top =
      two.data.data[Object.keys(two.data.data).find((k) => k.startsWith('messenger')) as string];
    top['*elements'] = [msg.entityUrn, older.entityUrn];
    const r = parseMessages(two, ME);
    if (!r.ok) throw new Error(r.message);
    expect(r.messages.map((m) => m.at)).toEqual(
      [older.deliveredAt, msg.deliveredAt].map((t) => new Date(t).toISOString()),
    );
  });

  test('a response without messages is drift', () => {
    expect(parseMessages({ data: { data: {} } }, ME).ok).toBe(false);
  });
});
