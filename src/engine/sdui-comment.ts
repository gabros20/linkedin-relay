// ─── Commenting, over SDUI ────────────────────────────────────────────────────
//
// The payload LinkedIn's own client sends, rebuilt from a live capture
// (docs/research/W5). Unlike a reaction, a comment is not self-contained: it
// carries a binding key and a trackingId harvested from the rendered post page
// — see sdui-harvest.ts, which also PROVES the key belongs to the intended post
// before any of this runs.
//
// The five state keys are one key body under five prefixes. `commentBoxText` is
// the plain string, `richCommentBoxText` the same text as a TextModel, and the
// remaining three are empty strings for the link preview and image slots. All
// five are echoed in `requestedStateKeys`. Sending four of five, or omitting an
// empty one, has never been observed and is not something to improvise.

import type { ConfirmedWrite } from '../commands/confirm.ts';
import type { Client } from './client.ts';
import { keyMatchesPost } from './sdui-harvest.ts';

const SDUI_ACTION = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';

export const COMMENT_URL = `${SDUI_ACTION}?sduiid=com.linkedin.sdui.comments.createComment`;

const SCREEN_ID = 'com.linkedin.sdui.flagshipnav.feed.UpdateDetail';

/** The five slots the comment box keeps state in, in the captured order. */
const STATE_PREFIXES = [
  'commentBoxText',
  'richCommentBoxText',
  'commentBoxLinkPreviewIngestedContentId',
  'commentBoxExternalImageUrl',
  'commentBoxExternalImageId',
] as const;

/**
 * Numeric feedType per rendered context.
 *
 * Only FEED_DETAIL has been observed, carrying 3. A permalink fetched over
 * plain HTTP can hand back a `FeedType_FEED` key instead, whose number is
 * UNKNOWN — and an invented integer here would be a malformed write against a
 * real post, so that case refuses rather than guesses.
 */
const FEED_TYPES: Record<string, number> = { FEED_DETAIL: 3 };

/** Everything after the `commentBoxText-` prefix — shared by all five keys. */
export function keyBody(bindingKey: string): string {
  return bindingKey.replace(/^commentBoxText-/, '');
}

export function feedTypeFor(bindingKey: string): number | null {
  const suffix = /FeedType_([A-Z_]+)$/.exec(bindingKey)?.[1];
  return suffix === undefined ? null : (FEED_TYPES[suffix] ?? null);
}

function stateKey(prefix: string, body: string): string {
  return `${prefix}-${body}`;
}

export interface CommentTokens {
  bindingKey: string;
  trackingId: string;
}

/** The `states` array: the text in two encodings, and three empty slots. */
function states(text: string, body: string): unknown[] {
  return STATE_PREFIXES.map((prefix) => {
    const key = stateKey(prefix, body);
    const base = {
      key,
      namespace: 'MemoryNamespace',
      protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: key } },
    };
    if (prefix === 'commentBoxText') {
      return { ...base, value: text, originalProtoCase: 'stringValue' };
    }
    if (prefix === 'richCommentBoxText') {
      return {
        ...base,
        value: { text, attribute: [], $type: 'TextModel', source: 'local' },
        originalProtoCase: 'textModelForWrite',
      };
    }
    return { ...base, value: '', originalProtoCase: 'stringValue' };
  });
}

export function commentBody(
  activityId: string,
  text: string,
  tokens: CommentTokens,
  feedType: number,
): Record<string, unknown> {
  const body = keyBody(tokens.bindingKey);
  const activityUrn = { activityUrn: { activityId } };
  const binding = (prefix: string) => ({
    key: stateKey(prefix, body),
    namespace: 'MemoryNamespace',
  });

  const payload = {
    // The live client's handle for its optimistically-rendered comment. Server
    // relevance unknown, but it is cheap to send and being faithful to a
    // captured shape beats trimming fields whose purpose we are guessing at.
    optimisticKey: `auto-component-${crypto.randomUUID()}`,
    collection: {
      updateKey: {
        feedType,
        items: [
          { feedUpdateUrn: { updateUrnActivityUrn: activityUrn }, trackingId: tokens.trackingId },
        ],
        aggregationType: 0,
        isVideoCarousel: false,
      },
      threadUrn: { threadUrnActivityThreadUrn: activityUrn },
    },
    commentFieldBinding: binding('commentBoxText'),
    richCommentFieldBinding: binding('richCommentBoxText'),
    linkPreviewIngestedContentId: binding('commentBoxLinkPreviewIngestedContentId'),
    externalImageUrl: binding('commentBoxExternalImageUrl'),
    externalImageId: binding('commentBoxExternalImageId'),
  };

  const requestedStateKeys = STATE_PREFIXES.map((p) => ({
    key: { value: { $case: 'id', id: stateKey(p, body) } },
  }));

  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys,
    payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };

  return {
    requestId: 'com.linkedin.sdui.comments.createComment',
    serverRequest: {
      requestId: 'com.linkedin.sdui.comments.createComment',
      requestedArguments: args,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states: states(text, body),
    requestedArguments: {
      ...args,
      states: states(text, body),
      screenId: SCREEN_ID,
      knownTemplateIds: [],
    },
  };
}

export type CommentResult =
  | { ok: true; id: string | null }
  | { ok: false; code: string; message: string; hint?: string };

/**
 * Post a comment. Every guard here exists because a wrong binding does not
 * error — it comments somewhere else, publicly, under the owner's name.
 */
export async function comment(
  confirmed: ConfirmedWrite<{ activityId: string; text: string; tokens: CommentTokens }>,
  client: Client,
): Promise<CommentResult> {
  const { activityId, text, tokens } = confirmed.payload;

  if (!keyMatchesPost(tokens.bindingKey, activityId)) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'the harvested binding key does not belong to this post',
      hint: 'Refusing to send: this is how a comment lands on the wrong post. Re-harvest.',
    };
  }

  const feedType = feedTypeFor(tokens.bindingKey);
  if (feedType === null) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: `unknown feed type in binding key '${tokens.bindingKey.slice(-24)}'`,
      hint:
        'Only FeedType_FEED_DETAIL has been observed, carrying feedType 3. Inventing a number ' +
        'for another context would be a malformed write against a real post. Capture the ' +
        'missing one with `bun run scripts/observe-write.ts`.',
    };
  }

  const result = await client.request({
    url: COMMENT_URL,
    method: 'POST',
    body: commentBody(activityId, text, tokens, feedType),
    spendClass: 'write',
    operation: 'comment.create',
  });

  if (!result.ok) {
    const out: CommentResult = { ok: false, code: result.code, message: result.message };
    if (result.hint !== undefined) out.hint = result.hint;
    return out;
  }
  return { ok: true, id: activityId };
}
