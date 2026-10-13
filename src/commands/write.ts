// Write command runners. Every one of these stops and asks a human before it
// sends anything, and makes zero network calls on the path where it doesn't.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { buildHeaders } from '../engine/auth.ts';
import { createLiveClient } from '../engine/index.ts';
import { share as sendShare } from '../engine/oauth-write.ts';
import { type CommentTokens, comment as sduiComment } from '../engine/sdui-comment.ts';
import { extractCommentTokens } from '../engine/sdui-harvest.ts';
import {
  type CommentRef,
  parseCommentUrn,
  runCommentAction,
  UPDATE_OP,
} from '../engine/sdui-menu.ts';
import {
  type Reaction,
  reactionLabel,
  REACTIONS as SDUI_REACTIONS,
  react as sduiReact,
} from '../engine/sdui-write.ts';
import { loadSession } from '../engine/session.ts';
import { type MediaKind, mediaKindOf } from '../engine/voyager-media.ts';
import { replyToComment } from '../engine/voyager-reply.ts';
import {
  type ApprovedMedia,
  editPost,
  mediaDigest,
  type PollSpec,
  pollDuration,
  share as voyagerShare,
} from '../engine/voyager-write.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import type { ConfirmDeps, WritePlan } from './confirm.ts';
import { lookup, previewLines } from './delete.ts';
import {
  gateWrite,
  recordHarvestSpend,
  refuseUnapprovable,
  reserve,
  terminalDeps,
} from './gate.ts';
import { loadToken, OAUTH_SETUP } from './token.ts';
import { chooseTransport, type Transport } from './transport.ts';

interface WriteContext {
  transport: Transport;
  now: number;
  note?: string;
}

/** The urn a write is authored as, for the confirmation summary. */
function authorLine(transport: Transport): string {
  return transport.kind === 'oauth'
    ? `as       ${transport.token.memberUrn}`
    : `as       ${transport.session.ownerUrn ?? 'you (browser session)'}`;
}

function prepare(
  command: string,
  now: number,
  via?: 'oauth' | 'voyager',
  calls = 1,
): WriteContext | Envelope {
  const session = loadSession();
  const choice = chooseTransport(
    { token: loadToken(), session: session.state === 'ok' ? session.session : null, now },
    via,
  );
  if (!choice.ok) {
    return err(command, 'AUTH_FAILED', choice.message, `${choice.hint}\n\n${OAUTH_SETUP}`);
  }
  const refused = reserve(command, now, calls);
  if (refused !== null) return refused;
  const ctx: WriteContext = { transport: choice.transport, now };
  if (choice.note !== undefined) ctx.note = choice.note;
  return ctx;
}

async function gate<T>(
  command: string,
  plan: WritePlan<T>,
  ctx: WriteContext,
  deps: ConfirmDeps,
): Promise<{ confirmed: Parameters<typeof sendShare>[0] } | Envelope> {
  // Only the OAuth transport issues its own fetch; everything else goes
  // through the client, which does its own accounting.
  const gated = await gateWrite(command, plan, ctx.now, deps, {
    commitSpend: ctx.transport.kind === 'oauth',
  });
  if ('ok' in gated) return gated;
  return { confirmed: gated.confirmed as never };
}

/** Read and identify a media file, or say why it cannot be posted. */
/** What the CLI asked to attach: `--image` (repeatable) or one `--video`, plus `--alt`s. */
export interface MediaRequest {
  flag: 'image' | 'video' | 'document';
  paths: string[];
  /** Index-aligned with `paths`; "" means no alt text for that image. */
  alts?: string[];
  /** A document's title — LinkedIn will not post a document without one. */
  title?: string;
}

const FLAG_KIND: Record<MediaRequest['flag'], MediaKind> = {
  image: 'IMAGE',
  video: 'VIDEO',
  document: 'DOCUMENT',
};
const KIND_FLAG: Record<MediaKind, string> = {
  IMAGE: '--image',
  VIDEO: '--video',
  DOCUMENT: '--document',
};
const KIND_WORD: Record<MediaKind, string> = {
  IMAGE: 'image   ',
  VIDEO: 'video   ',
  DOCUMENT: 'document',
};

/** One line per file for the preview, each followed by its alt text or title. */
function mediaLines(media: ApprovedMedia[]): string[] {
  return media.flatMap(({ filename, kind, size, sha256, alt, title }) => [
    `${KIND_WORD[kind]} ${filename} (${Math.ceil(size / 1024)} KB, sha256 ${sha256.slice(0, 12)})`,
    ...(alt === undefined ? [] : [`  alt    "${alt}"`]),
    ...(title === undefined ? [] : [`  title  "${title}"`]),
  ]);
}

/** LinkedIn's own composer limit for a multi-image post. */
const MAX_IMAGES = 20;

/** The request as a whole, before any file is read. Null when it is coherent. */
function mediaRequestError(media: MediaRequest): Envelope | null {
  const alts = media.alts ?? [];
  const single = media.flag !== 'image';
  if (single && media.paths.length > 1) {
    return err(
      'share',
      'INVALID_INPUT',
      `a post carries one ${media.flag}`,
      `pass a single --${media.flag}`,
    );
  }
  if (media.flag !== 'image' && alts.length > 0) {
    return err('share', 'INVALID_INPUT', `--alt applies to images, not a ${media.flag}`);
  }
  if (media.flag === 'document' && (media.title ?? '').trim() === '') {
    return err(
      'share',
      'INVALID_INPUT',
      'a document needs a title',
      'pass --title "<what readers see above the document>"',
    );
  }
  if (media.flag !== 'document' && media.title !== undefined) {
    return err('share', 'INVALID_INPUT', '--title applies to a --document');
  }
  if (media.paths.length > MAX_IMAGES) {
    return err('share', 'INVALID_INPUT', `a post carries at most ${MAX_IMAGES} images`);
  }
  if (alts.length > 0 && alts.length !== media.paths.length) {
    return err(
      'share',
      'INVALID_INPUT',
      `${alts.length} --alt for ${media.paths.length} images; they pair up by position`,
      'give one --alt per --image, in the same order; pass --alt "" for an image without one',
    );
  }
  return null;
}

/** Validate the request as a whole, then load every file, or say why not. */
function loadAllMedia(
  media: MediaRequest,
): { approved: ApprovedMedia[]; bytes: Uint8Array[] } | Envelope {
  const refused = mediaRequestError(media);
  if (refused !== null) return refused;

  const alts = media.alts ?? [];
  const approved: ApprovedMedia[] = [];
  const bytes: Uint8Array[] = [];
  for (const [i, path] of media.paths.entries()) {
    const one = loadMedia(media.flag, path);
    if ('ok' in one) return one;
    const alt = alts[i];
    let a = alt === undefined || alt === '' ? one.approved : { ...one.approved, alt };
    if (media.flag === 'document') a = { ...a, title: (media.title ?? '').trim() };
    approved.push(a);
    bytes.push(one.bytes);
  }
  return { approved, bytes };
}

function loadMedia(
  flag: MediaRequest['flag'],
  path: string,
): { approved: ApprovedMedia; bytes: Uint8Array } | Envelope {
  const kind = mediaKindOf(path);
  if (kind === null) {
    return err(
      'share',
      'INVALID_INPUT',
      `unsupported file type: ${basename(path)}`,
      'images: png, jpg, jpeg, gif, webp. videos: mp4, mov. documents: pdf.',
    );
  }
  if (kind.kind !== FLAG_KIND[flag]) {
    return err(
      'share',
      'INVALID_INPUT',
      `${basename(path)} is not ${flag === 'image' ? 'an image' : `a ${flag}`}`,
      `pass it with ${KIND_FLAG[kind.kind]}`,
    );
  }
  let bytes: Uint8Array;
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return err('share', 'INVALID_INPUT', `cannot read ${path}`);
  }
  return {
    bytes,
    approved: {
      filename: basename(path),
      kind: kind.kind,
      contentType: kind.contentType,
      size: bytes.byteLength,
      sha256: mediaDigest(bytes),
    },
  };
}

/**
 * A schedule time, as epoch ms, or null. Accepts ISO 8601 with an offset or Z,
 * taken exactly, or "YYYY-MM-DD HH:MM" in the machine's local time. Anything
 * else is refused rather than guessed: a misread time publishes at the wrong
 * moment, which cannot be taken back.
 */
export function parseScheduleTime(input: string): number | null {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  if (iso.test(input)) {
    const t = Date.parse(input);
    return Number.isNaN(t) ? null : t;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(input);
  if (local === null) return null;
  const [y, mo, d, h, mi] = local.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  // Date rolls 2026-13-40 over into a real date; refuse instead of moving it.
  const same =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi;
  return same ? date.getTime() : null;
}

/** Uploads plus pacing take minutes; a closer time could pass before the post lands. */
const MIN_LEAD_MS = 10 * 60_000;

/** The loaded files, undefined when none were asked for, or the refusal. */
function mediaFrom(
  media: MediaRequest | undefined,
  via: 'oauth' | 'voyager' | undefined,
): { approved: ApprovedMedia[]; bytes: Uint8Array[] } | undefined | Envelope {
  if (media === undefined || media.paths.length === 0) return undefined;
  const loaded = loadAllMedia(media);
  if ('ok' in loaded) return loaded;
  // Media upload exists only over Voyager. An explicit --via oauth is refused
  // rather than rerouted: switching transport silently is what the design bans.
  if (via === 'oauth') {
    return err(
      'share',
      'NOT_IMPLEMENTED',
      'posting media is only implemented over the private API',
      'drop --via oauth, or pass --via voyager',
    );
  }
  return loaded;
}

export interface SharePayloadIn {
  text: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  media?: ApprovedMedia[];
  scheduledAt?: number;
  poll?: PollSpec;
}

/** The approved payload and what the owner is shown about it. */
function sharePlan(p: {
  author: string;
  transport: 'oauth' | 'voyager';
  text: string;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  media: ApprovedMedia[] | undefined;
  scheduledAt: number | undefined;
  poll: PollSpec | undefined;
  now: number;
}): WritePlan<SharePayloadIn> {
  const payload: SharePayloadIn = { text: p.text, visibility: p.visibility };
  if (p.media !== undefined) payload.media = p.media;
  if (p.scheduledAt !== undefined) payload.scheduledAt = p.scheduledAt;
  if (p.poll !== undefined) payload.poll = p.poll;

  const scheduled = p.scheduledAt !== undefined;
  return {
    action: scheduled ? 'schedule a post' : 'post to your feed',
    payload,
    summary: [
      p.author,
      `content  "${p.text}"`,
      `audience ${p.visibility}`,
      ...(p.scheduledAt === undefined ? [] : [whenLine(p.scheduledAt, p.now)]),
      ...(p.poll === undefined ? [] : pollLines(p.poll)),
      ...(p.media === undefined ? [] : mediaLines(p.media)),
    ],
    reversibility: scheduled
      ? 'cancel any time before it publishes with `lnrelay delete <urn>`; after that it is ' +
        'public under your name like any post'
      : 'deletable with `lnrelay delete <urn>`, but it is public under your name the moment it ' +
        'lands and anyone who saw it cannot un-see it',
    transport: p.transport,
  };
}

/** What the CLI asked for, before validation: `--poll`, `--option`s, `--duration`. */
export interface PollRequest {
  question: string;
  options: string[];
  duration?: string;
}

function pollLines(poll: PollSpec): string[] {
  return [
    `poll     "${poll.question}"`,
    ...poll.options.map((o, i) => `  ${i + 1}.     ${o}`),
    `  runs   ${poll.duration}`,
  ];
}

/** A valid poll, undefined when none was asked for, or the refusal. */
function pollFrom(
  poll: PollRequest | undefined,
  ctx: { hasMedia: boolean; scheduled: boolean; via: 'oauth' | 'voyager' | undefined },
): PollSpec | undefined | Envelope {
  if (poll === undefined) return undefined;
  const refuse = (message: string, hint?: string) => err('share', 'INVALID_INPUT', message, hint);
  if (poll.question.trim() === '') return refuse('a poll needs a question');
  const options = poll.options.map((o) => o.trim());
  if (options.length < 2 || options.length > 4 || options.some((o) => o === '')) {
    return refuse('a poll needs 2 to 4 non-empty options', 'repeat --option "<text>" for each');
  }
  const duration = pollDuration(poll.duration ?? '1w');
  if (duration === null) {
    return refuse(`unknown --duration '${poll.duration}'`, 'one of: 1d, 3d, 1w, 2w');
  }
  if (ctx.hasMedia) return refuse('a post carries a poll or files, not both');
  // A scheduled probe showed the poll as "1w left" a week before it would
  // publish: its clock seems to start at creation. Until that is settled, a
  // scheduled poll could open already closed.
  if (ctx.scheduled) {
    return refuse(
      'a poll cannot be scheduled yet — its clock may start when it is created, not published',
      'post the poll now, or schedule a text post that asks the question',
    );
  }
  if (ctx.via === 'oauth') {
    return err(
      'share',
      'NOT_IMPLEMENTED',
      'polls are only implemented over the private API',
      'drop --via oauth, or pass --via voyager',
    );
  }
  return { question: poll.question.trim(), options, duration };
}

/** `--at` as epoch ms, undefined when absent, or the refusal. */
function scheduleFrom(
  at: string | undefined,
  now: number,
  via: 'oauth' | 'voyager' | undefined,
): number | undefined | Envelope {
  if (at === undefined) return undefined;
  const t = parseScheduleTime(at);
  if (t === null) {
    return err(
      'share',
      'INVALID_INPUT',
      `cannot read --at '${at}'`,
      'use "YYYY-MM-DD HH:MM" (local time) or ISO 8601 with an offset, e.g. 2026-10-20T14:00+02:00',
    );
  }
  if (t < now + MIN_LEAD_MS) {
    return err(
      'share',
      'INVALID_INPUT',
      '--at must be at least 10 minutes from now',
      'to post right away, leave --at out',
    );
  }
  if (via === 'oauth') {
    return err(
      'share',
      'NOT_IMPLEMENTED',
      'scheduling is only implemented over the private API',
      'drop --via oauth, or pass --via voyager',
    );
  }
  return t;
}

/** "Tue, Oct 20, 2026, 14:00 (Europe/Budapest) — in 7 days" */
function whenLine(at: number, now: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const hours = Math.round((at - now) / 3_600_000);
  const away = hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
  return `when     ${local} (${zone}) — ${away}`;
}

export async function runShare(
  text: string | undefined,
  visibility: string,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  via?: 'oauth' | 'voyager',
  media?: MediaRequest,
  at?: string,
  poll?: PollRequest,
): Promise<Envelope> {
  if (text === undefined || text.trim() === '') {
    return err('share', 'INVALID_INPUT', 'text is required', 'lnrelay share "<text>"');
  }
  const vis = visibility === 'connections' ? 'CONNECTIONS' : 'PUBLIC';

  const scheduled = scheduleFrom(at, now, via);
  if (typeof scheduled === 'object') return scheduled;
  const scheduledAt = scheduled;

  const loaded = mediaFrom(media, via);
  if (loaded !== undefined && 'ok' in loaded) return loaded;
  const pollSpec = pollFrom(poll, {
    hasMedia: loaded !== undefined,
    scheduled: scheduledAt !== undefined,
    via,
  });
  if (pollSpec !== undefined && 'ok' in pollSpec) return pollSpec;

  // Register + upload per file, then the post: all must fit, or uploads are orphans.
  // Media and scheduling exist only over Voyager, so either one pins it.
  const voyagerOnly = loaded !== undefined || scheduledAt !== undefined || pollSpec !== undefined;
  const ctx = prepare(
    'share',
    now,
    voyagerOnly ? 'voyager' : via,
    2 * (loaded?.approved.length ?? 0) + (pollSpec === undefined ? 0 : 1) + 1,
  );
  if ('ok' in ctx) return ctx;

  const plan = sharePlan({
    author: authorLine(ctx.transport),
    transport: ctx.transport.kind,
    text,
    visibility: vis,
    media: loaded?.approved,
    scheduledAt,
    poll: pollSpec,
    now,
  });

  const gated = await gate('share', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result =
    ctx.transport.kind === 'oauth'
      ? await sendShare(gated.confirmed, ctx.transport.token, {
          fetch: globalThis.fetch,
          now: () => now,
        })
      : await voyagerShare(gated.confirmed, createLiveClient(ctx.transport.session), loaded?.bytes);

  if (!result.ok) return err('share', result.code, result.message, result.hint);
  return ok('share', {
    id: result.id ?? null,
    transport: ctx.transport.kind,
    scheduledFor: scheduledAt === undefined ? undefined : new Date(scheduledAt).toISOString(),
    url: 'url' in result ? result.url : undefined,
    note: 'note' in result ? result.note : ctx.note,
  });
}

/**
 * Replace the text of one of the owner's own posts. The preview shows the text
 * being replaced when the post is among recent ones, so the owner approves a
 * change, not just a new string.
 */
async function runEditPost(
  urn: string,
  text: string,
  now: number,
  deps: ConfirmDeps,
): Promise<Envelope> {
  const unapprovable = refuseUnapprovable('edit', 'editing', deps);
  if (unapprovable !== null) return unapprovable;

  const ctx = prepare('edit', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err(
      'edit',
      'NOT_IMPLEMENTED',
      'editing a post is only implemented over the private API',
    );
  }

  const before = await lookup(urn, true);
  const plan: WritePlan<{ urn: string; text: string }> = {
    action: 'edit your post',
    payload: { urn, text },
    summary: [
      authorLine(ctx.transport),
      `post     ${urn}`,
      ...previewLines(before).map((l) => l.replace(/^content /, 'was     ')),
      `new text "${text}"`,
    ],
    reversibility:
      'editable again, but the previous text is NOT kept here, LinkedIn marks the post as ' +
      'edited, and an @mention in the old text is not carried over',
    transport: 'voyager',
  };

  const gated = await gate('edit', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await editPost(gated.confirmed as never, createLiveClient(ctx.transport.session));
  return result.ok
    ? ok('edit', { edited: urn })
    : err('edit', result.code, result.message, result.hint);
}

/** The numeric id inside an activity urn, or null. */
function activityIdOf(urn: string): string | null {
  return /^urn:li:(?:activity|ugcPost|share):(\d+)$/.exec(urn)?.[1] ?? null;
}

/**
 * Fetch the rendered post page and harvest the comment tokens.
 *
 * This is a ~2.8 MB HTML GET, far heavier than any Voyager read here, and it
 * is unavoidable: the trackingId changes on every render, so it cannot be
 * cached even though the binding key can.
 */
async function harvest(
  activityId: string,
  session: Parameters<typeof createLiveClient>[0],
  now: number,
): Promise<{ ok: true; tokens: CommentTokens } | Envelope> {
  // Account for it. This is the heaviest single request the tool makes, and
  // going through raw fetch bypassed the ledger, the cooldown and the pacing —
  // the exact unaccounted traffic the Permit type exists to prevent.
  const spent = reserve('comment', now);
  if (spent !== null) return spent;
  recordHarvestSpend(now);

  const headers = buildHeaders(session);
  let html: string;
  try {
    const res = await fetch(`https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`, {
      headers: {
        cookie: headers.cookie ?? '',
        'user-agent': headers['user-agent'] ?? '',
        accept: 'text/html',
      },
      redirect: 'manual',
    });
    if (res.status !== 200) {
      return err('comment', 'FETCH_FAILED', `the post page returned ${res.status}`);
    }
    html = await res.text();
  } catch (e) {
    return err('comment', 'FETCH_FAILED', `could not load the post page: ${(e as Error).message}`);
  }

  const found = extractCommentTokens(html, activityId);
  if (!found.ok) return err('comment', 'SCHEMA_DRIFT', found.message, found.hint);
  return { ok: true, tokens: { bindingKey: found.bindingKey, trackingId: found.trackingId } };
}

export async function runComment(
  postUrn: string | undefined,
  text: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
): Promise<Envelope> {
  if (postUrn === undefined || text === undefined || text.trim() === '') {
    return err(
      'comment',
      'INVALID_INPUT',
      'a post urn and text are required',
      'lnrelay comment <urn> "<text>"',
    );
  }
  // A comment urn is REFUSED here rather than treated as an edit. Someone
  // holding one most likely wants to reply to it, and silently overwriting it
  // instead would be the worst possible reading of the command. Editing has its
  // own verb; overloading is right when the operation is the same on different
  // types (`delete`), wrong when the operations differ.
  if (parseCommentUrn(postUrn) !== null) {
    return err(
      'comment',
      'INVALID_INPUT',
      'that is a comment urn, not a post urn',
      `To change its text: lnrelay edit ${postUrn} "<text>". To answer it: ` +
        `lnrelay reply ${postUrn} "<text>". Pass the POST urn to add a top-level comment.`,
    );
  }
  const activityId = activityIdOf(postUrn);
  if (activityId === null) {
    return err(
      'comment',
      'INVALID_INPUT',
      `'${postUrn}' does not identify a post`,
      'Pass urn:li:activity:<id>.',
    );
  }

  // The TTY check comes BEFORE the harvest, not just before the send. Harvesting
  // is a network call, and this tool's guarantee is "no TTY, no write AND no
  // network call on that path" — an agent shelling out non-interactively must
  // not cause LinkedIn traffic it cannot then use.
  const unapprovable = refuseUnapprovable('comment', 'commenting', deps);
  if (unapprovable !== null) return unapprovable;

  const ctx = prepare('comment', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('comment', 'NOT_IMPLEMENTED', 'commenting is only implemented over the private API');
  }

  // Harvest after that, but before asking: a human should not approve a comment
  // we then turn out to be unable to send, and the tokens are part of what is
  // being approved.
  const harvested = await harvest(activityId, ctx.transport.session, now);
  if ('ok' in harvested && harvested.ok !== true) return harvested as Envelope;
  if (!('tokens' in harvested)) return harvested as Envelope;

  const plan: WritePlan<{ activityId: string; text: string; tokens: CommentTokens }> = {
    action: 'comment on a post',
    payload: { activityId, text, tokens: harvested.tokens },
    // The harvested trackingId changes on every render, so --plan and --confirm
    // would never agree on a token derived from it. The intent is what's approved.
    tokenBasis: { activityId, text },
    summary: [authorLine(ctx.transport), `on       ${postUrn}`, `content  "${text}"`],
    reversibility:
      'deletable with `lnrelay delete <comment-urn>`; the author is notified immediately',
    transport: 'voyager',
  };

  const gated = await gate('comment', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await sduiComment(
    gated.confirmed as never,
    createLiveClient(ctx.transport.session),
  );
  return result.ok
    ? ok('comment', { on: postUrn })
    : err('comment', result.code, result.message, result.hint);
}

/** Change the text of a comment you wrote. Its own verb, deliberately. */
export async function runEdit(
  commentUrn: string | undefined,
  text: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
): Promise<Envelope> {
  if (commentUrn === undefined || text === undefined || text.trim() === '') {
    return err(
      'edit',
      'INVALID_INPUT',
      'a comment urn and the new text are required',
      'lnrelay edit <comment-urn> "<text>"',
    );
  }
  const ref: CommentRef | null = parseCommentUrn(commentUrn);
  if (ref === null) {
    // Like delete, edit routes by the KIND of urn: a comment and a post are
    // edited over different surfaces, and each is unambiguous.
    if (/^urn:li:(share|ugcPost):\d+$/.test(commentUrn)) {
      return runEditPost(commentUrn, text, now, deps);
    }
    return err(
      'edit',
      'INVALID_INPUT',
      `'${commentUrn}' is neither a comment urn nor a post's share/ugcPost urn`,
      /^urn:li:activity:/.test(commentUrn)
        ? 'A post is edited by the urn it was created as, not its activity urn. `lnrelay share` ' +
            'prints it, and `lnrelay my-posts` lists it as shareUrn.'
        : 'Pass a comment urn (from `lnrelay post <activity-urn>`) or a post urn ' +
            '(urn:li:share:… / urn:li:ugcPost:…).',
    );
  }

  const unapprovable = refuseUnapprovable('edit', 'editing', deps);
  if (unapprovable !== null) return unapprovable;

  const ctx = prepare('edit', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('edit', 'NOT_IMPLEMENTED', 'editing is only implemented over the private API');
  }

  const harvested = await harvest(ref.activityId, ctx.transport.session, now);
  if (!('tokens' in harvested)) return harvested as Envelope;

  const plan: WritePlan<{ urn: string; text: string }> = {
    action: 'edit your comment',
    payload: { urn: commentUrn, text },
    summary: [authorLine(ctx.transport), `comment  ${commentUrn}`, `new text "${text}"`],
    reversibility:
      'editable again, but the previous text is NOT recoverable here and LinkedIn marks the ' +
      'comment as edited',
    transport: 'voyager',
  };

  const gated = await gate('edit', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await runCommentAction(
    ref,
    UPDATE_OP,
    harvested.tokens.trackingId,
    createLiveClient(ctx.transport.session),
    text,
  );
  return result.ok
    ? ok('edit', { edited: commentUrn })
    : err('edit', result.code, result.message, result.hint);
}

const REACTIONS: readonly string[] = SDUI_REACTIONS;

export async function runReact(
  postUrn: string | undefined,
  type: string,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
  remove = false,
): Promise<Envelope> {
  const reaction = type.toUpperCase();
  if (postUrn === undefined) {
    return err(
      'react',
      'INVALID_INPUT',
      'a post or comment urn is required',
      'lnrelay react <urn> [--type LIKE] [--remove]',
    );
  }
  if (!REACTIONS.includes(reaction)) {
    return err(
      'react',
      'INVALID_INPUT',
      `unknown reaction '${type}'`,
      `one of: ${REACTIONS.join(', ')}`,
    );
  }
  const ctx = prepare('react', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('react', 'NOT_IMPLEMENTED', 'reacting is only implemented over the private API');
  }

  const plan: WritePlan<{ urn: string; type: Reaction; remove: boolean }> = {
    action: remove ? 'remove a reaction' : 'react to a post',
    payload: { urn: postUrn, type: reaction as Reaction, remove },
    summary: [
      authorLine(ctx.transport),
      `on       ${postUrn}`,
      `reaction ${reaction} — shows as "${reactionLabel(reaction as Reaction)}"${remove ? ' (REMOVING)' : ''}`,
    ],
    reversibility: remove
      ? 'you can react again; the author may have been notified the first time'
      : `removable with \`lnrelay react ${postUrn} --remove --type ${reaction}\` — the type is ` +
        'required, LinkedIn deletes a specific reaction; the author is notified immediately',
    transport: 'voyager',
  };

  const gated = await gate('react', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await sduiReact(gated.confirmed as never, createLiveClient(ctx.transport.session));
  return result.ok
    ? ok('react', { id: result.id, removed: remove })
    : err('react', result.code, result.message, result.hint);
}

/**
 * Reply to a comment. Its own verb for the same reason `edit` is: replying and
 * commenting are different operations, and the urn alone cannot say which was
 * meant. Getting it wrong publishes a top-level comment on someone's thread.
 */
export async function runReply(
  commentUrn: string | undefined,
  text: string | undefined,
  now = Date.now(),
  deps: ConfirmDeps = terminalDeps(),
): Promise<Envelope> {
  if (commentUrn === undefined || text === undefined || text.trim() === '') {
    return err(
      'reply',
      'INVALID_INPUT',
      'a comment urn and the reply text are required',
      'lnrelay reply <comment-urn> "<text>"',
    );
  }
  const parent: CommentRef | null = parseCommentUrn(commentUrn);
  if (parent === null) {
    return err(
      'reply',
      'INVALID_INPUT',
      `'${commentUrn}' is not a comment urn`,
      'To comment on a POST, use `lnrelay comment <activity-urn>`. Comment urns come from ' +
        '`lnrelay post <activity-urn>`.',
    );
  }

  const unapprovable = refuseUnapprovable('reply', 'replying', deps);
  if (unapprovable !== null) return unapprovable;

  const ctx = prepare('reply', now, 'voyager');
  if ('ok' in ctx) return ctx;
  if (ctx.transport.kind !== 'voyager') {
    return err('reply', 'NOT_IMPLEMENTED', 'replying is only implemented over the private API');
  }

  // No harvest here: unlike a top-level comment, a reply needs no binding key
  // and no trackingId. Its parent reference is the threadUrn, and that is
  // derived from the urn the user passed.
  const plan: WritePlan<{ ref: CommentRef; text: string }> = {
    action: 'reply to a comment',
    payload: { ref: parent, text },
    summary: [authorLine(ctx.transport), `replying to ${commentUrn}`, `content     "${text}"`],
    reversibility:
      'deletable with `lnrelay delete <the reply urn>`; the comment author is notified immediately',
    transport: 'voyager',
  };

  const gated = await gate('reply', plan, ctx, deps);
  if ('ok' in gated) return gated;

  const result = await replyToComment(
    gated.confirmed as never,
    createLiveClient(ctx.transport.session),
  );
  return result.ok
    ? ok('reply', { repliedTo: commentUrn })
    : err('reply', result.code, result.message, result.hint);
}
