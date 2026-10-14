// ─── Reading the owner's messages ─────────────────────────────────────────────
//
// Captured 2026-10-14 from the messaging page. Reading is two GraphQL queries
// on `voyagerMessagingGraphQL`:
//
//   messengerConversations   a folder of conversations, 20 at a time, by cursor
//   messengerMessages        a conversation's latest messages
//
// Opening a conversation in the browser does more than read: the page also
// POSTs `markAllMessagesAsSeen`, `sendDeliveryAcknowledgement` and, for an
// unread conversation, marks it read — which the sender sees. Those are
// separate calls, and this module makes none of them. Nothing here sends,
// marks, or acknowledges anything; reading through it leaves no trace a
// correspondent can see.
//
// The conversation urn is `urn:li:msg_conversation:(<mailbox>,2-<id>==)`; the
// browser leaves its `=` padding raw, and percent-encoding it is answered
// with a 400. The Rest.li codec leaves `=` alone, which is what is wanted.

import { CONTRACTS } from './contracts.ts';
import { encodeVariables } from './restli.ts';
import type { Failure } from './sdui-form.ts';

/** The folders, by the name LinkedIn's mailbox counts use. */
export const FOLDERS = {
  primary: 'PRIMARY_INBOX',
  other: 'SECONDARY_INBOX',
  inbox: 'INBOX',
  archive: 'ARCHIVE',
  requests: 'MESSAGE_REQUEST_PENDING',
  spam: 'SPAM',
} as const;

export type Folder = keyof typeof FOLDERS;

const FOLDER_OF: Record<string, Folder> = Object.fromEntries(
  Object.entries(FOLDERS).map(([k, v]) => [v, k as Folder]),
);

function contract(name: 'messengerConversations' | 'messengerMessages') {
  const c = CONTRACTS[name];
  if (c?.queryId === undefined) throw new Error(`messaging contract '${name}' is missing`);
  return c;
}

/** The mailbox is the owner's profile: `whoami`'s urn, in its `fsd_profile` form. */
export function mailboxOf(meUrn: string): string {
  const id = meUrn.match(/(?:fs_miniProfile|fsd_profile|fs_profile):([A-Za-z0-9_-]+)/)?.[1];
  return `urn:li:fsd_profile:${id ?? meUrn}`;
}

export function conversationsUrl(q: {
  mailbox: string;
  folder: Folder;
  cursor?: string;
  count?: number;
}): string {
  const c = contract('messengerConversations');
  const variables = encodeVariables({
    query: {
      predicateUnions: [{ conversationCategoryPredicate: { category: FOLDERS[q.folder] } }],
    },
    count: q.count ?? 20,
    mailboxUrn: q.mailbox,
    nextCursor: q.cursor,
  });
  return `${c.path}?queryId=${c.queryId}&variables=${variables}`;
}

export function messagesUrl(conversationUrn: string): string {
  const c = contract('messengerMessages');
  return `${c.path}?queryId=${c.queryId}&variables=${encodeVariables({ conversationUrn })}`;
}

/** A conversation urn from itself, a /messaging/thread/ URL, or a bare thread id. */
export function conversationIdOf(input: string, mailbox: string): string | undefined {
  const s = input.trim();
  if (/^urn:li:msg_conversation:\(urn:li:fsd_profile:[^,]+,2-[^)]+\)$/.test(s)) return s;
  const thread =
    s.match(/messaging\/thread\/(2-[^/?#]+)/)?.[1] ?? s.match(/^(2-[A-Za-z0-9+/=_-]+)$/)?.[1];
  return thread === undefined ? undefined : `urn:li:msg_conversation:(${mailbox},${thread})`;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

type Node = Record<string, unknown>;

export interface Participant {
  name: string;
  kind: 'person' | 'organization' | 'other';
  headline?: string;
  /** 1st, 2nd, 3rd+, out of network. */
  degree?: string;
  url?: string;
}

export interface MessageLine {
  from: string;
  fromMe: boolean;
  at: string;
  text?: string;
  subject?: string;
  /** A sponsored message (an InMail ad). */
  sponsored?: boolean;
}

export interface Conversation {
  id: string;
  url?: string;
  /** Everyone in it but the owner. */
  with: Participant[];
  /** A group conversation's name. */
  title?: string;
  unread: number;
  lastActivity?: string;
  last?: MessageLine;
  folders: Folder[];
  inmail: boolean;
}

export interface Message extends MessageLine {
  id: string;
}

const DEGREE: Record<string, string> = {
  DISTANCE_1: '1st',
  DISTANCE_2: '2nd',
  DISTANCE_3: '3rd+',
  OUT_OF_NETWORK: 'out of network',
};

const txt = (v: unknown): string | undefined => {
  const t = typeof v === 'string' ? v : (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};

const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : undefined);

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function participantOf(p: Node | undefined): Participant | undefined {
  const t = (p?.participantType ?? {}) as Record<string, Node | null>;
  if (t.member) {
    const m = t.member;
    const name = [txt(m.firstName), txt(m.lastName)].filter(Boolean).join(' ');
    const url =
      typeof m.profileUrl === 'string' ? `${m.profileUrl.replace(/\/$/, '')}/` : undefined;
    return defined({
      name: name !== '' ? name : 'LinkedIn Member',
      kind: 'person' as const,
      headline: txt(m.headline),
      degree: DEGREE[String(m.distance)],
      url,
    });
  }
  if (t.organization) {
    const o = t.organization;
    return defined({
      name: txt(o.name) ?? 'an organization',
      kind: 'organization' as const,
      url: typeof o.pageUrl === 'string' ? o.pageUrl : undefined,
    });
  }
  if (t.custom) return { name: txt(t.custom.name) ?? 'LinkedIn', kind: 'other' };
  return undefined;
}

const isMe = (urn: unknown, mailbox: string) => typeof urn === 'string' && urn.includes(mailbox);

function messageOf(m: Node, byUrn: Map<unknown, Node>, mailbox: string): MessageLine {
  const sender = m['*sender'] ?? m['*actor'];
  const fromMe = isMe(sender, mailbox);
  const who = fromMe ? undefined : participantOf(byUrn.get(sender));
  const render = Array.isArray(m.renderContent) ? (m.renderContent as Node[]) : [];
  return defined({
    from: fromMe ? 'you' : (who?.name ?? 'unknown'),
    fromMe,
    at: iso(m.deliveredAt) as string,
    text: txt(m.body),
    subject: txt(m.subject),
    sponsored: render.some((r) => r.conversationAdsMessageContent) ? true : undefined,
  });
}

const drift = (message: string): Failure => ({
  ok: false,
  code: 'SCHEMA_DRIFT',
  message,
  hint: 'the messaging response changed shape; re-capture it',
});

/** The `messenger…` collection in a response, whatever the query named it. */
function collectionOf(json: unknown): Node | undefined {
  const d = (json as { data?: { data?: Node } } | null)?.data?.data;
  const key = d === undefined ? undefined : Object.keys(d).find((k) => k.startsWith('messenger'));
  const c = key === undefined ? undefined : d?.[key];
  return c !== null && typeof c === 'object' ? (c as Node) : undefined;
}

/** A collection's references; an empty one comes as `elements: []` instead. */
function refsOf(top: Node | undefined): string[] | undefined {
  const refs = top?.['*elements'];
  if (Array.isArray(refs)) return refs as string[];
  return Array.isArray(top?.elements) && top.elements.length === 0 ? [] : undefined;
}

export function parseConversations(
  json: unknown,
  mailbox: string,
): { ok: true; conversations: Conversation[]; cursor?: string } | Failure {
  const top = collectionOf(json);
  const refs = refsOf(top);
  if (refs === undefined) return drift('the conversation list was missing');
  const included = (json as { included?: Node[] }).included ?? [];
  const byUrn = new Map<unknown, Node>(included.map((n) => [n.entityUrn, n]));
  const conversations: Conversation[] = [];
  for (const ref of refs) {
    const c = byUrn.get(ref);
    if (c === undefined) continue;
    const parts = ((c['*conversationParticipants'] as string[] | undefined) ?? [])
      .filter((u) => !isMe(u, mailbox))
      .map((u) => participantOf(byUrn.get(u)))
      .filter((p): p is Participant => p !== undefined);
    const lastRef = ((c.messages as Node | undefined)?.['*elements'] as string[] | undefined)?.[0];
    const last = lastRef === undefined ? undefined : byUrn.get(lastRef);
    const categories = Array.isArray(c.categories) ? (c.categories as string[]) : [];
    conversations.push(
      defined({
        id: String(c.entityUrn),
        url: typeof c.conversationUrl === 'string' ? c.conversationUrl : undefined,
        with: parts,
        title: c.groupChat === true ? txt(c.title) : undefined,
        unread: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
        lastActivity: iso(c.lastActivityAt),
        last: last === undefined ? undefined : messageOf(last, byUrn, mailbox),
        // PRIMARY_INBOX sits inside INBOX; report the folder a person would name.
        folders: categories
          .map((k) => FOLDER_OF[k])
          .filter(
            (f): f is Folder =>
              f !== undefined && !(f === 'primary' && categories.includes('INBOX')),
          ),
        inmail: categories.includes('INMAIL'),
      }),
    );
  }
  if (refs.length > 0 && conversations.length === 0)
    return drift(`${refs.length} conversations were listed but none were sent`);
  const cursor = (top?.metadata as Node | undefined)?.nextCursor;
  return {
    ok: true,
    conversations,
    ...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
  };
}

export function parseMessages(
  json: unknown,
  mailbox: string,
): { ok: true; messages: Message[] } | Failure {
  const top = collectionOf(json);
  const refs = refsOf(top);
  if (refs === undefined) return drift('the message list was missing');
  const included = (json as { included?: Node[] }).included ?? [];
  const byUrn = new Map<unknown, Node>(included.map((n) => [n.entityUrn, n]));
  const messages: Message[] = [];
  for (const ref of refs) {
    const m = byUrn.get(ref);
    if (m === undefined || typeof m.deliveredAt !== 'number') continue;
    messages.push({ id: String(m.entityUrn), ...messageOf(m, byUrn, mailbox) });
  }
  if (refs.length > 0 && messages.length === 0)
    return drift(`${refs.length} messages were listed but none were sent`);
  // Oldest first, the way a conversation reads.
  messages.sort((a, b) => a.at.localeCompare(b.at));
  return { ok: true, messages };
}
