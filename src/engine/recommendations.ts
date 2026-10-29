// ─── A profile's recommendations ──────────────────────────────────────────────
//
// Captured 2026-10-29 from /in/<id>/details/recommendations/. The full profile
// carries none; the details page draws them from a pager,
// `pagers.profile.details.recommendations`, with a payload the profile read
// already has: `{type: Received|Given, vanityName, profileId, start, count}`.
//
// Each recommendation is a header row (the recommender: their name, headline
// and profile URL as the loading states it sets on click, their degree, and
// the date-and-relationship line) and the text beside it, in fragments, some
// in rows of their own. The first sits inline in the page's root row with
// the others referenced after it; each other one has its own row. A
// recommendation's text is what lies between its header and the next one's.
// The date line comes in the session's language and is not split.

import { Rows } from './posts.ts';
import type { Failure } from './sdui-form.ts';

const PAGER = 'com.linkedin.sdui.pagers.profile.details.recommendations';
const SCREEN = 'com.linkedin.sdui.flagshipnav.profile.ProfileRecommendationDetails';
export const RECOMMENDATIONS_URL = `https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=${PAGER}`;
export const RECOMMENDATIONS_PAGE = 15;

export type RecommendationKind = 'received' | 'given';

export function recommendationsBody(
  kind: RecommendationKind,
  vanityName: string,
  profileId: string,
  start: number,
) {
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [],
    payload: {
      type: kind === 'received' ? 'Received' : 'Given',
      vanityName,
      profileId,
      start,
      detailScreenTabIndex: kind === 'received' ? '0' : '1',
      count: RECOMMENDATIONS_PAGE,
    },
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
  };
  return {
    pagerId: PAGER,
    clientArguments: { ...args, states: [], screenId: SCREEN, knownTemplateIds: [] },
    paginationRequest: {
      $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: PAGER,
      retryCount: 2,
      requestedArguments: args,
    },
  };
}

export interface Recommendation {
  /** The recommender, or for given ones, the person recommended. */
  name: string;
  url?: string;
  headline?: string;
  degree?: string;
  /** When, and how they worked together, as LinkedIn words it. */
  context?: string;
  text: string;
}

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const unquote = (s: string) => JSON.parse(`"${s}"`) as string;
const STR = '((?:[^"\\\\]|\\\\.)+)';
const loading = (id: string) =>
  new RegExp(
    `"id":"${id}"\\}\\},"namespace":"LoadingNamespace"\\},"value":\\{"\\$case":"stringValue","stringValue":"${STR}"`,
  );
const NAME = loading('profile_name_loading_state');
const HEADLINE = loading('profile_headline_loading_state');
const PROFILE_URL = /"url":"(https:\/\/www\.linkedin\.com\/in\/[^"]+)"/;
const TEXT = /"children":\["((?:[^"\\$]|\\.)(?:[^"\\]|\\.)*)"\]/g;
const FRAGMENT =
  /\["\$","\$9","\d+",\{"children":\[(?:null|\["\$","br",null,\{\}\]),"((?:[^"\\]|\\.)*)"\]/g;
const REF = /"\$L([0-9a-f]+)"/g;
/** A row referenced whole: lazily (`$L`) or as its value, as a long text is (`$18`). */
const ANY_REF = /"\$L?([0-9a-f]+)"/g;

/** The recommender, from their header row and what it references. */
function header(rows: Rows, id: string) {
  const row = rows.byId.get(id) ?? '';
  const name = row.match(NAME)?.[1];
  if (name === undefined) return undefined;
  const headline = row.match(HEADLINE)?.[1];
  const all = rows
    .reach(id)
    .map((r) => rows.byId.get(r) ?? '')
    .join('\n');
  const texts = [...all.matchAll(TEXT)].map((m) => unquote(m[1] as string).trim());
  const degree = texts.find((t) => t.startsWith('·'));
  const shown = new Set([unquote(name), headline === undefined ? '' : unquote(headline)]);
  const context = texts.filter((t) => t !== degree && !shown.has(t)).pop();
  const url = row.match(PROFILE_URL)?.[1];
  return {
    name: unquote(name).trim(),
    ...(url !== undefined ? { url } : {}),
    ...(headline !== undefined ? { headline: unquote(headline).trim() } : {}),
    ...(degree !== undefined ? { degree: degree.replace(/^·\s*/, '') } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

/**
 * A stretch of a row with its text written in, so it reads in order: fragment
 * rows inlined, and a text row (a long recommendation) as the string it is.
 */
function inlined(rows: Rows, segment: string, depth = 0): string {
  if (depth > 3) return segment;
  return segment.replace(ANY_REF, (ref, id: string) => {
    const row = rows.byId.get(id);
    if (row === undefined) return ref;
    if (rows.isText(id)) return JSON.stringify(row);
    return row.startsWith('["$","$9"') ? inlined(rows, row, depth + 1) : ref;
  });
}

/** The text: its fragments, or failing those its plain text lines. */
function bodyOf(segment: string): string {
  const fragments = [...segment.matchAll(FRAGMENT)].map((m) => unquote(m[1] as string));
  const lines =
    fragments.length > 0
      ? fragments
      : [...segment.matchAll(TEXT)].map((m) => unquote(m[1] as string));
  return lines
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseRecommendations(
  stream: string,
): { ok: true; items: Recommendation[] } | Failure {
  if (!stream.includes('isPartialPage') && !stream.includes(PAGER))
    return drift('the recommendations answer was not the recommendations list');
  const rows = new Rows(stream);
  const headers = [...rows.byId]
    .filter(([, row]) => NAME.test(row) && !row.startsWith('[["$"'))
    .map(([id]) => id);
  const heads = new Set(headers);
  // Where each header sits: the row that references it, and from where.
  const placed = headers.flatMap((h) => {
    for (const [id, row] of rows.byId) {
      const at = row.indexOf(`"$L${h}"`);
      if (at !== -1) return [{ h, row: id, at }];
    }
    return [];
  });
  // Rows that hold a header: an item's text stops where the next item starts.
  const holders = new Set(placed.map((p) => p.row));
  const items: Recommendation[] = [];
  for (const p of placed) {
    const row = rows.byId.get(p.row) ?? '';
    let end = row.length;
    for (const m of row.slice(p.at + 1).matchAll(REF)) {
      const id = m[1] as string;
      if (heads.has(id) || (holders.has(id) && id !== p.row)) {
        end = p.at + 1 + (m.index ?? 0);
        break;
      }
    }
    const who = header(rows, p.h);
    const text = bodyOf(inlined(rows, row.slice(p.at, end)));
    if (who !== undefined && text !== '') items.push({ ...who, text });
  }
  if (headers.length > 0 && items.length === 0)
    return drift(`${headers.length} recommendations were shown but none could be read`);
  return { ok: true, items };
}
