// ─── `lnrelay inbox`, `messages`, `draft`, `drafts` ───────────────────────────
//
// Reading the owner's messages, and drafting replies on this machine. See
// engine/messaging.ts. There is NO send: a draft is a local note with the
// conversation's link, for the owner to open, review and send themselves.
// Nothing read is stored; it is fetched live, on the page budget. The
// mailbox id (the owner's own profile id) is kept in me.json after the first
// lookup so every read does not cost a `whoami`.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { createEngine, createLiveClient } from '../engine/index.ts';
import {
  type Conversation,
  conversationIdOf,
  conversationsUrl,
  FOLDERS,
  type Folder,
  mailboxOf,
  messagesUrl,
  parseConversations,
  parseMessages,
} from '../engine/messaging.ts';
import type { Failure } from '../engine/sdui-form.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. Messaging never POSTs. */
export type MessagingFetch = (url: string, spendClass: 'page') => Promise<Fetched>;

/** Messages a page holds; fewer means nothing older is held back. */
const MESSAGES_PAGE = 20;
/** Folders deeper than this are refused rather than paged forever. */
const MAX_CONVERSATIONS = 500;

function live(command: string, quiet: boolean) {
  const session = loadSession();
  if (session.state !== 'ok')
    return err(command, 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  const fetch: MessagingFetch = async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: command });
    return r.ok ? { ok: true, json: r.json } : r;
  };
  return { fetch, session: session.session };
}

/** The owner's mailbox: me.json, or one `whoami` the first time. */
async function mailbox(command: string, quiet: boolean): Promise<string | Envelope> {
  const known = loadJson<{ profileUrn?: string }>(cachePath('me.json'));
  if (known.state === 'ok' && typeof known.value.profileUrn === 'string')
    return known.value.profileUrn;
  const session = loadSession();
  if (session.state !== 'ok')
    return err(command, 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const me = await createEngine(session.session, undefined, quiet).whoami();
  const urn = me.ok ? (me.value as { entityUrn?: unknown } | undefined)?.entityUrn : undefined;
  if (typeof urn !== 'string')
    return err(command, 'AUTH_FAILED', 'could not tell whose mailbox this is');
  const profileUrn = mailboxOf(urn);
  saveJson(cachePath('me.json'), { profileUrn });
  return profileUrn;
}

async function setup(command: string, opts: OutputOpts, fetch?: MessagingFetch) {
  const box = await mailbox(command, opts.quiet === true);
  if (typeof box !== 'string') return box;
  if (fetch !== undefined) return { box, get: fetch };
  const l = live(command, opts.quiet === true);
  if ('ok' in l) return l;
  return { box, get: l.fetch };
}

// ─── inbox ────────────────────────────────────────────────────────────────────

export interface InboxRequest {
  folder?: Folder;
  limit: number;
  /** Only conversations with unread messages. */
  unread?: boolean;
}

function compactConversation(c: Conversation): string {
  const last =
    c.last === undefined
      ? undefined
      : `${c.last.from}: ${(c.last.text ?? '').replace(/\s+/g, ' ')}`;
  return line([
    c.id,
    c.with.map((p) => p.name).join(', ') || c.title,
    c.unread > 0 ? `${c.unread} unread` : undefined,
    c.lastActivity?.slice(0, 10),
    c.inmail ? 'InMail' : undefined,
    last !== undefined && last.length > 140 ? `${last.slice(0, 137)}…` : last,
  ]);
}

export async function runInbox(
  req: InboxRequest,
  opts: OutputOpts = {},
  fetch?: MessagingFetch,
): Promise<Envelope> {
  const folder = req.folder ?? 'inbox';
  if (!(folder in FOLDERS)) {
    return err(
      'inbox',
      'INVALID_INPUT',
      `no folder '${folder}'`,
      `one of: ${Object.keys(FOLDERS).join(', ')}`,
    );
  }
  const ready = await setup('inbox', opts, fetch);
  if ('ok' in ready) return ready;
  const want = Math.max(1, Math.min(req.limit, MAX_CONVERSATIONS));

  const all: Conversation[] = [];
  let cursor: string | undefined;
  let stoppedBy: string | undefined;
  let exhausted = false;
  while (all.length < want) {
    const res = await ready.get(
      conversationsUrl({ mailbox: ready.box, folder, ...(cursor ? { cursor } : {}) }),
      'page',
    );
    const page = res.ok ? parseConversations(res.json, ready.box) : res;
    if (!page.ok) {
      if (all.length === 0) return err('inbox', page.code, page.message, page.hint);
      stoppedBy = page.code;
      break;
    }
    const room = want - all.length;
    all.push(...page.conversations.slice(0, room));
    if (page.conversations.length > room) break;
    if (page.cursor === undefined || page.conversations.length === 0) {
      exhausted = true;
      break;
    }
    cursor = page.cursor;
  }
  const shown = req.unread === true ? all.filter((c) => c.unread > 0) : all;
  return ok('inbox', {
    folder,
    items: shape(shown, opts, compactConversation),
    meta: {
      state: exhausted && stoppedBy === undefined ? 'complete' : 'partial',
      operation: 'inbox',
      returnedCount: shown.length,
      unread: all.filter((c) => c.unread > 0).length,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    },
  });
}

// ─── messages ─────────────────────────────────────────────────────────────────

export async function runMessages(
  input: string | undefined,
  opts: OutputOpts = {},
  fetch?: MessagingFetch,
): Promise<Envelope> {
  const ready = await setup('messages', opts, fetch);
  if ('ok' in ready) return ready;
  const id = input === undefined ? undefined : conversationIdOf(input, ready.box);
  if (id === undefined) {
    return err(
      'messages',
      'INVALID_INPUT',
      'a conversation id or /messaging/thread/ URL is required',
      'ids come from `lnrelay inbox`',
    );
  }
  const res = await ready.get(messagesUrl(id), 'page');
  const parsed = res.ok ? parseMessages(res.json, ready.box) : res;
  if (!parsed.ok) return err('messages', parsed.code, parsed.message, parsed.hint);
  return ok('messages', {
    conversation: id,
    url: threadUrl(id),
    items: shape(parsed.messages, opts, (m) =>
      line([
        m.at.slice(0, 16).replace('T', ' '),
        m.from,
        m.subject,
        (m.text ?? '').replace(/\s+/g, ' '),
      ]),
    ),
    meta: {
      // A full page may have older messages behind it; this reads the latest page only.
      state: parsed.messages.length < MESSAGES_PAGE ? 'complete' : 'partial',
      operation: 'messages',
      returnedCount: parsed.messages.length,
    },
  });
}

const threadUrl = (conversationUrn: string) => {
  const thread = conversationUrn.match(/,(2-[^)]+)\)$/)?.[1];
  return thread === undefined ? undefined : `https://www.linkedin.com/messaging/thread/${thread}/`;
};

// ─── drafts ───────────────────────────────────────────────────────────────────

export interface Draft {
  id: string;
  conversation: string;
  url?: string;
  /** Who the conversation is with, as it read when the draft was made. */
  to: string[];
  text: string;
  createdAt: string;
}

const DRAFTS = () => cachePath('drafts.json');

function loadDrafts(): Draft[] | Failure {
  const loaded = loadJson<Draft[]>(DRAFTS());
  if (loaded.state === 'missing') return [];
  if (loaded.state === 'corrupt')
    return {
      ok: false,
      code: 'CACHE_CORRUPT',
      message: `drafts were unreadable; moved to ${loaded.quarantinedTo}`,
    };
  return Array.isArray(loaded.value) ? loaded.value : [];
}

export async function runDraft(
  conversation: string | undefined,
  text: string | undefined,
  fetch?: MessagingFetch,
  opts: OutputOpts = {},
): Promise<Envelope> {
  const body = text?.trim() ?? '';
  if (body === '')
    return err(
      'draft',
      'INVALID_INPUT',
      'a draft needs text',
      'lnrelay draft <conversation> "<text>" | --file <path>',
    );
  const box = await mailbox('draft', opts.quiet === true);
  if (typeof box !== 'string') return box;
  const id = conversation === undefined ? undefined : conversationIdOf(conversation, box);
  if (id === undefined)
    return err(
      'draft',
      'INVALID_INPUT',
      'a conversation id or /messaging/thread/ URL is required',
      'ids come from `lnrelay inbox`',
    );
  const ready = await setup('draft', opts, fetch);
  if ('ok' in ready) return ready;

  // One read: the conversation exists, and who it is with.
  const res = await ready.get(messagesUrl(id), 'page');
  const parsed = res.ok ? parseMessages(res.json, ready.box) : res;
  if (!parsed.ok) return err('draft', parsed.code, parsed.message, parsed.hint);
  const to = [...new Set(parsed.messages.filter((m) => !m.fromMe).map((m) => m.from))];

  const drafts = loadDrafts();
  if (!Array.isArray(drafts)) return err('draft', drafts.code, drafts.message);
  const url = threadUrl(id);
  const draft: Draft = {
    id: randomUUID().slice(0, 8),
    conversation: id,
    ...(url !== undefined ? { url } : {}),
    to,
    text: body,
    createdAt: new Date().toISOString(),
  };
  saveJson(DRAFTS(), [...drafts, draft]);
  return ok('draft', {
    saved: true,
    sent: false,
    draft,
    notice:
      'Saved on this machine only. Nothing was sent: open the link, review, and send it yourself.',
  });
}

export function draftText(text: string | undefined, file: string | undefined): string | undefined {
  return file !== undefined ? readFileSync(file, 'utf-8') : text;
}

export function runDrafts(opts: OutputOpts = {}): Envelope {
  const drafts = loadDrafts();
  if (!Array.isArray(drafts)) return err('drafts', drafts.code, drafts.message);
  return ok('drafts', {
    items: shape(drafts, opts, (d) =>
      line([d.id, d.to.join(', '), d.createdAt.slice(0, 10), d.text.replace(/\s+/g, ' '), d.url]),
    ),
    meta: { state: 'complete', operation: 'drafts', returnedCount: drafts.length },
  });
}

export function runDraftRemove(id: string | undefined): Envelope {
  const drafts = loadDrafts();
  if (!Array.isArray(drafts)) return err('draft', drafts.code, drafts.message);
  if (id === undefined || !drafts.some((d) => d.id === id)) {
    return err(
      'draft',
      'NOT_FOUND',
      `no draft '${id ?? ''}'`,
      `drafts: ${drafts.map((d) => d.id).join(', ') || 'none'}`,
    );
  }
  saveJson(
    DRAFTS(),
    drafts.filter((d) => d.id !== id),
  );
  return ok('draft', { removed: id });
}
