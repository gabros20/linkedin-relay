// ─── The owner's notifications ────────────────────────────────────────────────
//
// Probed 2026-10-29. The bell's list is a REST finder:
//
//   voyagerIdentityDashNotificationCards?q=filterVanityName&count=N&start=S
//
// Each card is a node in `included`: a headline, optional sub-lines, `read`,
// `publishedAt`, and where it goes (`cardAction.actionTarget`) and who or what
// it is about (`headerImage.actionTarget`). Its kind is the first part of its
// urn (FOLLOW_PAGE_HERO, …). `metadata.nextStart` is the next page; the last
// page has none and an empty-section card instead. A page can hold fewer
// cards than asked for (10 asked, 9 sent, next start 10), so paging follows
// nextStart, not the count.
//
// Not read: the page's tabs (my posts, mentions, jobs). `filterVanityName`
// is the finder's key, but `mentions` answered as `all`; the tab names are
// unverified. Reading here never marks anything seen.

import { CONTRACTS } from './contracts.ts';
import type { Failure } from './sdui-form.ts';

type Node = Record<string, unknown>;

export function notificationsUrl(count: number, start: number): string {
  const c = CONTRACTS.notifications;
  if (c?.decorationId === undefined) throw new Error("the 'notifications' contract is missing");
  return `${c.path}?decorationId=${c.decorationId}&q=filterVanityName&count=${count}&start=${start}`;
}

export interface Notification {
  /** LinkedIn's own name for the kind of notification. */
  kind: string;
  text: string;
  /** Sub-lines, when the card has them. */
  detail?: string;
  /** ISO time it was published. */
  at?: string;
  read: boolean;
  /** Where the card goes. */
  url?: string;
  /** Who or what it is about: a profile, a company. */
  from?: string;
}

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const textOf = (v: unknown) => {
  const t = (v as { text?: unknown } | null)?.text;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : undefined;
};
const absolute = (v: unknown) =>
  typeof v === 'string' && v !== ''
    ? v.startsWith('/')
      ? `https://www.linkedin.com${v}`
      : v
    : undefined;

function card(n: Node): Notification | undefined {
  const text = textOf(n.headline);
  if (text === undefined) return undefined;
  const kind = String(n.entityUrn ?? '').match(/fsd_notificationCard:\(([^,]+),/)?.[1] ?? 'UNKNOWN';
  const detail = [n.subHeadline, n.contentPrimaryText, n.contentSecondaryText, n.kickerText]
    .map(textOf)
    .filter((t): t is string => t !== undefined)
    .join(' · ');
  const at = typeof n.publishedAt === 'number' ? new Date(n.publishedAt).toISOString() : undefined;
  const url = absolute((n.cardAction as Node | null)?.actionTarget);
  const from = absolute((n.headerImage as Node | null)?.actionTarget);
  return {
    kind,
    text,
    ...(detail !== '' ? { detail } : {}),
    ...(at !== undefined ? { at } : {}),
    read: n.read === true,
    ...(url !== undefined ? { url } : {}),
    ...(from !== undefined ? { from } : {}),
  };
}

export function parseNotifications(
  json: unknown,
): { ok: true; items: Notification[]; unseen?: number; next?: number } | Failure {
  const root = json as { data?: Node; included?: Node[] } | null;
  const data = root?.data;
  const listed = data?.['*elements'] ?? data?.elements;
  if (!Array.isArray(listed)) return drift('the notifications answer carried no card list');
  const byUrn = new Map((root?.included ?? []).map((n) => [n.entityUrn, n]));
  const items = listed.flatMap((u) => {
    const n = byUrn.get(u);
    const c = n === undefined ? undefined : card(n);
    return c === undefined ? [] : [c];
  });
  if (listed.length > 0 && items.length === 0)
    return drift(`${listed.length} notifications were listed but none could be read`);
  const meta = (data?.metadata ?? {}) as Node;
  return {
    ok: true,
    items,
    ...(typeof meta.numUnseen === 'number' ? { unseen: meta.numUnseen } : {}),
    ...(typeof meta.nextStart === 'number' ? { next: meta.nextStart } : {}),
  };
}
