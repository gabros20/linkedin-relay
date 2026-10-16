// ─── Who viewed the owner's profile ───────────────────────────────────────────
//
// Captured 2026-10-16. /me/profile-views/ (now /analytics/profile-views/) is
// drawn by two SDUI server requests: WvmpAnalytics, the total over the page's
// default range (past 90 days), and WvmpEntityList, the viewers newest first.
// Both answer in the session's language, so nothing here reads LinkedIn's
// words for meaning beyond the "•" before a degree.
//
// The list: each viewer is its own RSC row, tracked `viewer-list-item`. A
// named viewer links to their /in/ profile; an anonymous one ("Founder in the
// Software industry from Budapest") links to a people search instead. The
// viewer's profile id is not in their row: it is in the Connect or Message
// action, the rows the list references right after the viewer's. Private-mode
// viewers are only a count ("4 LinkedIn members"), outside every row.
//
// A free account shows up to 3 viewers; the list has a next-page marker
// (`wvmp-entity-list-next-page-loaded`) that was not exercised.

import { Rows } from './posts.ts';
import type { Failure } from './sdui-form.ts';

const SERVER_REQUEST = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
export const VIEWERS_URL = `${SERVER_REQUEST}?sduiid=WvmpEntityList`;
export const VIEW_TOTALS_URL = `${SERVER_REQUEST}?sduiid=WvmpAnalytics`;

const RANGE = 'WvmpSearchFilterType_DATE_RANGE';
const META = { $type: 'proto.sdui.common.RequestMetadata' } as const;

/** The page's own request: its id, payload, and the date-range state it is keyed by. */
function serverRequest(requestId: string, stateKey: string, payload: Record<string, unknown>) {
  const state = {
    key: stateKey,
    namespace: 'MemoryNamespace',
    value: [],
    originalProtoCase: 'stringListValue',
    protoKey: { $type: 'proto.sdui.Key', value: { $case: 'id', id: stateKey } },
  };
  const requestedArguments = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [{ key: { value: { $case: 'id', id: stateKey } } }],
    payload: {
      ...payload,
      filterTypeList: [RANGE],
      dateRangeSelectionFilters: { key: stateKey, namespace: 'MemoryNamespace' },
    },
    requestMetadata: META,
  };
  return {
    requestId,
    serverRequest: {
      requestId,
      requestedArguments,
      isApfcEnabled: false,
      isStreaming: false,
      rumPageKey: '',
    },
    states: [state],
    requestedArguments: {
      ...requestedArguments,
      states: [state],
      screenId: 'com.linkedin.sdui.flagshipnav.home.Home',
      knownTemplateIds: [],
    },
  };
}

export function viewersBody() {
  return serverRequest('WvmpEntityList', `entityListQueryFilterPrefix${RANGE}`, {
    sortType: 'ProfileViewSortType_TIME_DESCENDING',
  });
}

export function viewTotalsBody() {
  return serverRequest('WvmpAnalytics', `analyticsFieldsFilterPrefix${RANGE}`, {
    highlightCardDimensions: [
      'DimensionType_LOCATION',
      'DimensionType_INDUSTRY',
      'DimensionType_ORGANIZATION',
    ],
    detailsCardDimensions: ['DimensionType_ORGANIZATION'],
    highlightCardResultCount: 4,
    detailsCardResultCount: 23,
  });
}

export type Viewer =
  | {
      name: string;
      /** Their profile id: what `profile`, `messages` and `people --connection-of` take. */
      id?: string;
      url: string;
      /** Connection degree, as LinkedIn words it in the session's language. */
      degree?: string;
      headline?: string;
      /** When, as LinkedIn words it ("2d ago"). */
      viewed?: string;
    }
  | {
      anonymous: true;
      /** What LinkedIn says of them instead ("Founder in the Software industry from …"). */
      description: string;
      viewed?: string;
      /** The people search LinkedIn links them to. */
      searchUrl?: string;
    };

const drift = (message: string): Failure => ({ ok: false, code: 'SCHEMA_DRIFT', message });
const unquote = (s: string) => JSON.parse(`"${s}"`) as string;
const STR = '((?:[^"\\\\]|\\\\.)+)';

const ITEM =
  /"viewName":"viewer-list-item"(?:,"impressionThresholds":\[[^\]]*\])?[^{}]*"semanticPosition"/;
const TEXT_PROPS =
  /"textProps":\{"fontFamily":"[^"]*","fontSize":"(\w+)","fontStyle":"[^"]*","fontWeight":"(\w+)","lineHeight":"[^"]*","textAlign":"[^"]*","children":/g;
const OWN_TEXT = new RegExp(`^\\["${STR}"\\]`);
const NESTED_TEXT = new RegExp(`\\[null,"${STR}"`);
const LINK = new RegExp(`"urlValue":\\{"\\$case":"url","url":"${STR}"`);
const PROFILE_ID = /ACoA[A-Za-z0-9_-]{10,}/;
const PLAIN_TEXT = new RegExp(`"children":\\["${STR}"\\]`, 'g');

/** Each text in a viewer's row: its size and weight, then what it says. */
function textsOf(row: string): { size: string; weight: string; text: string }[] {
  return [...row.matchAll(TEXT_PROPS)].flatMap((m) => {
    const after = row.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 600);
    const raw = after.match(OWN_TEXT)?.[1] ?? after.match(NESTED_TEXT)?.[1];
    if (raw === undefined) return [];
    const text = unquote(raw).trim();
    return text === '' ? [] : [{ size: m[1] as string, weight: m[2] as string, text }];
  });
}

function viewerOf(row: string, id: string | undefined): Viewer | undefined {
  // In order: the name (or the anonymous description), the degree, the
  // headline, and last when they looked.
  const texts = textsOf(row);
  const at = texts.findIndex((t) => t.size === 'medium' && t.weight === 'bold');
  const first = texts[at]?.text;
  if (first === undefined) return undefined;
  const rest = texts.slice(at + 1).map((t) => t.text);
  const degreeText = rest.find((t) => t.startsWith('•'));
  const lines = rest.filter((t) => t !== degreeText);
  const viewed = lines.at(-1);
  const link = row.match(LINK)?.[1];
  const url = link === undefined ? undefined : unquote(link);
  if (url === undefined || !/linkedin\.com\/in\//.test(url)) {
    const v: Viewer = { anonymous: true, description: first };
    if (viewed !== undefined) v.viewed = viewed;
    if (url !== undefined) v.searchUrl = url;
    return v;
  }
  const degree = degreeText?.replace(/^•\s*/, '');
  const headline = lines.length > 1 ? lines[0] : undefined;
  return {
    name: first,
    ...(id !== undefined ? { id } : {}),
    url,
    ...(degree !== undefined ? { degree } : {}),
    ...(headline !== undefined ? { headline } : {}),
    ...(viewed !== undefined ? { viewed } : {}),
  };
}

/**
 * Whole-row references only: `$L` (lazy), `$Q` (a map) or bare. A `$b:4:props…`
 * path points back INTO a row, here into the list itself, and is not followed.
 */
const REF = /"\$[LQ]?([0-9a-f]+)"/g;

/** The first profile id in `ref` or the rows it references, never via a viewer's row. */
function idUnder(rows: Rows, ref: string, items: Set<string>): string | undefined {
  const seen = new Set([ref]);
  const queue = [ref];
  while (queue.length > 0 && seen.size < 200) {
    const row = rows.byId.get(queue.shift() as string) ?? '';
    const id = row.match(PROFILE_ID)?.[0];
    if (id !== undefined) return id;
    for (const m of row.matchAll(REF)) {
      const next = m[1] as string;
      if (!seen.has(next) && !items.has(next) && rows.byId.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return undefined;
}

/**
 * Each viewer's profile id, from the action the list references after their
 * row and before the next viewer's.
 */
function idsByViewer(rows: Rows, items: Set<string>): Map<string, string> {
  const ids = new Map<string, string>();
  for (const row of rows.byId.values()) {
    let current: string | undefined;
    for (const m of row.matchAll(REF)) {
      const ref = m[1] as string;
      if (items.has(ref)) current = ref;
      else if (current !== undefined && !ids.has(current)) {
        const id = idUnder(rows, ref, items);
        if (id !== undefined) ids.set(current, id);
      }
    }
  }
  return ids;
}

export function parseViewers(
  stream: string,
): { ok: true; viewers: Viewer[]; privateViewers?: number } | Failure {
  if (!stream.includes('"viewName":"viewer-list"'))
    return drift('the profile viewers answer was not the viewer list');
  const rows = new Rows(stream);
  const items = new Set([...rows.byId].filter(([, row]) => ITEM.test(row)).map(([id]) => id));
  const ids = idsByViewer(rows, items);
  const viewers = [...items].flatMap((id) => viewerOf(rows.byId.get(id) ?? '', ids.get(id)) ?? []);
  const shown = Math.max(items.size, (stream.match(new RegExp(ITEM, 'g')) ?? []).length);
  if (shown > 0 && viewers.length === 0)
    return drift(`${shown} profile viewers were shown but none could be read`);

  // "4 LinkedIn members": the one number outside every viewer's row.
  let privateViewers: number | undefined;
  for (const [id, row] of rows.byId) {
    if (items.has(id) || privateViewers !== undefined) continue;
    for (const m of row.matchAll(PLAIN_TEXT)) {
      const n = unquote(m[1] as string).match(/^(\d[\d.,\s]*)\s+\D/)?.[1];
      if (n !== undefined) {
        privateViewers = Number(n.replace(/\D/g, ''));
        break;
      }
    }
  }
  return privateViewers === undefined
    ? { ok: true, viewers }
    : { ok: true, viewers, privateViewers };
}

export function parseViewTotals(
  stream: string,
): { ok: true; total: number; period?: string } | Failure {
  const texts = [...stream.matchAll(PLAIN_TEXT)].map((m) => unquote(m[1] as string).trim());
  const at = texts.findIndex((t) => /^\d[\d.,\s]*$/.test(t));
  if (at === -1) return drift('the profile view totals carried no number');
  const total = Number((texts[at] as string).replace(/\D/g, ''));
  const period = texts[at + 1];
  return period === undefined ? { ok: true, total } : { ok: true, total, period };
}
