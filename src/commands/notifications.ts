// ─── `lnrelay notifications` ──────────────────────────────────────────────────
//
// The owner's notifications, newest first; see engine/notifications.ts. One
// page call per 25, following LinkedIn's next start. Reading them here does
// not mark them seen.

import { createLiveClient } from '../engine/index.ts';
import {
  type Notification,
  notificationsUrl,
  parseNotifications,
} from '../engine/notifications.ts';
import { loadSession } from '../engine/session.ts';
import { err, ok } from '../output.ts';
import type { Envelope, FetchState } from '../types.ts';
import type { OutputOpts } from './live.ts';
import { line } from './paged.ts';
import { shape } from './people.ts';

type Fetched =
  | { ok: true; json: unknown }
  | { ok: false; code: string; message: string; hint?: string };

/** One accounted GET. Injectable so tests send nothing. */
export type NotificationsFetch = (url: string, spendClass: 'page') => Promise<Fetched>;

function liveFetch(quiet: boolean): NotificationsFetch | Envelope {
  const session = loadSession();
  if (session.state !== 'ok')
    return err('notifications', 'AUTH_FAILED', 'no LinkedIn session — run `lnrelay login`');
  const client = createLiveClient(session.session, undefined, quiet);
  return async (url, spendClass) => {
    const r = await client.request({ url, spendClass, operation: 'notifications' });
    return r.ok ? { ok: true, json: r.json } : r;
  };
}

export interface NotificationsRequest {
  limit: number;
  /** Only the ones not yet read. */
  unread?: boolean;
}

const PAGE = 25;

const compactNotification = (n: Notification) =>
  line([n.read ? undefined : 'unread', n.at, n.kind, n.text, n.detail, n.url]);

export async function runNotifications(
  req: NotificationsRequest,
  opts: OutputOpts = {},
  fetch?: NotificationsFetch,
): Promise<Envelope> {
  const get = fetch ?? liveFetch(opts.quiet === true);
  if (typeof get !== 'function') return get;
  const limit = Math.max(1, req.limit);
  const items: Notification[] = [];
  let unseen: number | undefined;
  let start: number | undefined = 0;
  let stoppedBy: string | undefined;
  while (start !== undefined && items.length < limit) {
    const res = await get(notificationsUrl(PAGE, start), 'page');
    const page = res.ok ? parseNotifications(res.json) : res;
    if (!page.ok) {
      if (items.length === 0 && start === 0)
        return err('notifications', page.code, page.message, page.hint);
      stoppedBy = page.code;
      break;
    }
    unseen ??= page.unseen;
    items.push(...page.items.filter((n) => req.unread !== true || !n.read));
    start = page.next !== undefined && page.next > start ? page.next : undefined;
  }
  const kept = items.slice(0, limit);
  const state: FetchState =
    stoppedBy !== undefined || (start !== undefined && kept.length === limit)
      ? 'partial'
      : 'complete';
  return ok('notifications', {
    ...(unseen !== undefined ? { unseen } : {}),
    items: shape(kept, opts, compactNotification),
    meta: {
      state,
      operation: 'notifications',
      returnedCount: kept.length,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    },
  });
}
