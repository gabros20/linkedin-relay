// ─── The scheduled-posts queue ────────────────────────────────────────────────
//
// Voyager cannot read a scheduled post: `normShares/<urn>` answers 400, and
// `my-posts` lists only what has published. The web client's "Scheduled (N)"
// list is SDUI — a pager over React Server Components — and that is the only
// place the queue is visible. Captured 2026-10-13 with three probes scheduled
// (two over normShares, one from the web composer), then with none.
//
// The stream is not JSON, so it is read by exclusion-tolerant scanning, and
// held to the same rule as every parser here: never an empty success on
// failure. The stream carries LinkedIn's own count (`ShareBoxscheduledPostCount`,
// the N in the tab); without it an empty queue and a page we no longer
// understand look the same, so its absence is SCHEMA_DRIFT.

import type { FetchState } from '../types.ts';
import type { Client } from './client.ts';

export const PAGER_ID = 'com.linkedin.sdui.pagers.sharing.scheduledPosts';
const PAGER_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${PAGER_ID}`;
const SCREEN_ID = 'com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList';

/** A page as the web client asks for it when the list is scrolled. */
export function scheduledPageBody(start: number, count: number) {
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload: { start, count, shareLifeCycleState: 'ShareLifeCycleState_SCHEDULED' },
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    pagerId: PAGER_ID,
    clientArguments: { ...args, states: [], screenId: SCREEN_ID, knownTemplateIds: [] },
    paginationRequest: {
      $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: PAGER_ID,
      retryCount: 0,
      requestedArguments: args,
    },
  };
}

export interface ScheduledPost {
  /** The urn `delete` cancels it by, and `edit` edits it by. */
  urn: string;
  /** Epoch ms. */
  scheduledAt: number;
  /**
   * The text as the list renders it: whole, but with links shortened to
   * lnkd.in. Null when it could not be paired with its row for certain.
   */
  text: string | null;
}

type Failure = { ok: false; code: string; message: string; hint?: string };

const COUNT =
  /"id":"ShareBoxscheduledPostCount"\}\}\},"value":\{"\$case":"intValue","intValue":(\d+)\}/;
const ROW = /"feedUpdateUrn":"(urn:li:(?:share|ugcPost):\d+)","scheduledAtEpochMillis":"(\d+)"/g;
// Each row's preview block holds the text as a single string child. A row
// whose text is shaped differently simply does not match, and the pairing
// check below then refuses to guess.
const TEXT =
  /"viewName":"mini-update-container"[\s\S]*?"textProps":\{[^{}]*?"children":\["((?:[^"\\]|\\.)*)"\]/g;

export function parseScheduledPage(
  stream: string,
): { ok: true; claimedCount: number; posts: ScheduledPost[] } | Failure {
  const count = stream.match(COUNT);
  if (count?.[1] === undefined) {
    return drift('the scheduled-posts page carried no post count');
  }
  const claimedCount = Number(count[1]);

  const posts: ScheduledPost[] = [];
  const seen = new Set<string>();
  for (const [, urn, at] of stream.matchAll(ROW)) {
    if (urn === undefined || seen.has(urn)) continue;
    seen.add(urn);
    posts.push({ urn, scheduledAt: Number(at), text: null });
  }
  if (claimedCount > 0 && posts.length === 0) {
    return drift(`LinkedIn counts ${claimedCount} scheduled posts but no row could be read`);
  }

  // Texts arrive in row order. Pair them only when there is exactly one per
  // row: a text on the wrong post is worse than none.
  const texts = [...stream.matchAll(TEXT)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  if (texts.length === posts.length) {
    posts.forEach((p, i) => {
      p.text = texts[i] ?? null;
    });
  }
  return { ok: true, claimedCount, posts };
}

function drift(message: string): Failure {
  return {
    ok: false,
    code: 'SCHEMA_DRIFT',
    message,
    hint: 'Re-capture the scheduled list (open "Scheduled" in the composer) with scripts/observe-write.ts.',
  };
}

const PAGE_SIZE = 10;
/** LinkedIn's own UI pages by 5; 10 pages of 10 is far past any real queue. */
const MAX_PAGES = 10;

/**
 * The whole queue, paged until it holds as many posts as LinkedIn counts.
 * `state` is `complete` only when it does.
 */
export async function fetchScheduled(
  client: Client,
  pageSize = PAGE_SIZE,
): Promise<
  { ok: true; posts: ScheduledPost[]; claimedCount: number; state: FetchState } | Failure
> {
  const posts: ScheduledPost[] = [];
  const seen = new Set<string>();
  let claimedCount = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.request({
      url: PAGER_URL,
      method: 'POST',
      body: scheduledPageBody(posts.length, pageSize),
      spendClass: 'page',
      operation: 'scheduled',
    });
    if (!result.ok) {
      const out: Failure = { ok: false, code: result.code, message: result.message };
      if (result.hint !== undefined) out.hint = result.hint;
      return out;
    }
    // Not JSON; the client keeps the raw stream on the classification.
    const parsed = parseScheduledPage((result.classification as { raw?: string }).raw ?? '');
    if (!parsed.ok) return parsed;

    // The highest count seen: a later page that comes back emptier must not
    // shrink what LinkedIn said was there and turn a short read into `complete`.
    claimedCount = Math.max(claimedCount, parsed.claimedCount);
    const fresh = parsed.posts.filter((p) => !seen.has(p.urn));
    for (const p of fresh) {
      seen.add(p.urn);
      posts.push(p);
    }
    if (posts.length >= claimedCount || fresh.length === 0) break;
  }

  const state: FetchState = posts.length >= claimedCount ? 'complete' : 'partial';
  return { ok: true, posts, claimedCount, state };
}
