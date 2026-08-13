// ─── Deleting a post ──────────────────────────────────────────────────────────
//
// The only irreversible action in the tool. Everything else it does can be
// undone: an unwanted post can be deleted, a reaction removed, a cached row
// purged. A deleted post is gone, and no confirmation prompt can give it back.
//
// So this one does something the others do not: it READS THE POST FIRST and
// shows the human the actual text they are about to destroy. A urn is not
// something anyone can eyeball — `urn:li:activity:7489428563075637248` and
// `urn:li:activity:7489428563075637249` are the same string to a tired person
// at a terminal, and one of them is the wrong post.
//
// The lookup is `my-posts`, which is the right source for three reasons at
// once: it proves the post exists, it proves the OWNER wrote it (it came from
// their own posts), and it carries the text. A post that is not in there is not
// necessarily someone else's — it may just be older than the page we fetched —
// so that case is reported rather than refused, and the prompt says plainly
// that it is proceeding blind.

import { createEngine, createLiveClient } from '../engine/index.ts';
import { LAUNCH_HINT, loadSession } from '../engine/session.ts';
import { deletePost, isDeletableUrn } from '../engine/voyager-write.ts';
import { type Shaped, shapeAll } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { gateWrite, reserve, terminalDeps } from './gate.ts';

/** How many of the owner's recent posts to search for the one being deleted. */
const LOOKUP_LIMIT = 50;

const PREVIEW_CHARS = 200;

/** The numeric id shared by every namespace a single post appears under. */
function postId(urn: string): string | undefined {
  return /:(\d+)$/.exec(urn)?.[1];
}

/**
 * Find a post among the owner's own, matching across urn namespaces.
 *
 * The same post is `urn:li:activity:X` to the feed, `urn:li:ugcPost:X` to
 * reactions and `urn:li:share:X` to the create endpoint. Matching on the shared
 * numeric id means a urn from any read can be handed to delete.
 */
export function findOwnPost(posts: Shaped[], urn: string): Shaped | undefined {
  const id = postId(urn);
  if (id === undefined) return undefined;
  return posts.find((p) => typeof p.urn === 'string' && postId(p.urn) === id);
}

/** What the human is shown about the post before they approve destroying it. */
export function previewLines(post: Shaped | undefined): string[] {
  if (post === undefined) {
    return [
      'content  COULD NOT READ THIS POST.',
      '         It is not among your recent posts. That may only mean it is older',
      '         than the page fetched — but nothing here has verified what you are',
      '         about to delete, or that it is yours.',
    ];
  }
  const text = typeof post.text === 'string' ? post.text : '(no text — media-only post?)';
  const shown = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  return [`content  "${shown.replace(/\n/g, ' ')}"`];
}

/** Look the post up so the prompt can show it. A failed read is not fatal. */
async function lookup(urn: string, quiet: boolean): Promise<Shaped | undefined> {
  const session = loadSession();
  if (session.state !== 'ok') return undefined;
  const engine = createEngine(session.session, undefined, quiet);

  const me = await engine.whoami();
  if (!me.ok) return undefined;
  const profileUrn = typeof me.value?.entityUrn === 'string' ? me.value.entityUrn : undefined;
  if (profileUrn === undefined) return undefined;

  const posts = await engine.myPosts(profileUrn, LOOKUP_LIMIT);
  if (!posts.ok) return undefined;
  return findOwnPost(shapeAll(posts.value.parsed.items, posts.value.index), urn);
}

export async function runDelete(
  urn: string | undefined,
  now = Date.now(),
  deps?: ConfirmDeps,
  quiet = false,
): Promise<Envelope> {
  if (urn === undefined || urn === '') {
    return err(
      'delete',
      'INVALID_INPUT',
      'a post urn is required',
      'lnrelay delete <urn:li:share:… | urn:li:activity:…>',
    );
  }
  if (!isDeletableUrn(urn)) {
    return err(
      'delete',
      'INVALID_INPUT',
      `'${urn}' does not identify a post`,
      'Expected urn:li:share:<id>, urn:li:activity:<id> or urn:li:ugcPost:<id>. Refusing before ' +
        'encoding it, because a well-formed request naming the wrong kind of entity is a request ' +
        'to destroy the wrong kind of thing.',
    );
  }

  const session = loadSession();
  if (session.state === 'corrupt') {
    return err('delete', 'CACHE_CORRUPT', 'the stored session was unreadable', LAUNCH_HINT);
  }
  if (session.state === 'missing') {
    // Deleting goes over Voyager only. LinkedIn's official API has a delete,
    // but this tool has not built or verified it, and an unverified destructive
    // call is the last place to start guessing.
    return err(
      'delete',
      'AUTH_FAILED',
      'no LinkedIn session — deleting goes over the private API',
      `Run \`lnrelay login\`. ${LAUNCH_HINT}`,
    );
  }

  const refused = reserve('delete', now);
  if (refused !== null) return refused;

  // Read before destroying. This costs one read and is the entire point.
  const post = await lookup(urn, quiet);

  const plan: WritePlan<{ urn: string }> = {
    action: 'delete a post',
    payload: { urn },
    summary: [`post     ${urn}`, ...previewLines(post)],
    reversibility: 'NONE. A deleted post is gone, with its comments and reactions.',
    transport: 'voyager',
  };

  // The client accounts for the DELETE itself.
  const gated = await gateWrite('delete', plan, now, deps ?? terminalDeps(), {
    commitSpend: false,
  });
  if ('ok' in gated) return gated;

  const result = await deletePost(gated.confirmed as never, createLiveClient(session.session));
  return result.ok
    ? ok('delete', { deleted: urn, verified: post !== undefined })
    : err('delete', result.code, result.message, result.hint);
}
