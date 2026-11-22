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
//
// Premium (captured 2026-11-22) names every viewer in the range, in one
// answer, and takes a date range: 7, 14, 28, 90 or 365 days, the value of the
// range state (`WvmpSearchFilterTimeRange_LAST_365_DAYS`). Its totals add
// highlights (top location, industry, company: value then label, between the
// `highlights` and `details` markers) and the companies viewers work at, each
// a name and "(25%)". Since then both requests answer 500 without a referer.

import { Rows } from './posts.ts';
import type { Failure } from './sdui-form.ts';

const SERVER_REQUEST = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
export const VIEWERS_URL = `${SERVER_REQUEST}?sduiid=WvmpEntityList`;
export const VIEW_TOTALS_URL = `${SERVER_REQUEST}?sduiid=WvmpAnalytics`;

/** Both requests answer 500 without a referer (since 2026-11); any LinkedIn page will do. */
export const VIEWERS_REFERER = 'https://www.linkedin.com/analytics/profile-views/';

/** The ranges the page offers, in days. */
export const VIEW_RANGES = [7, 14, 28, 90, 365] as const;
export type ViewRange = (typeof VIEW_RANGES)[number];

const RANGE = 'WvmpSearchFilterType_DATE_RANGE';
const META = { $type: 'proto.sdui.common.RequestMetadata' } as const;

/** The page's own request: its id, payload, and the date-range state it is keyed by. */
function serverRequest(
  requestId: string,
  stateKey: string,
  payload: Record<string, unknown>,
  days: ViewRange | undefined,
) {
  const state = {
    key: stateKey,
    namespace: 'MemoryNamespace',
    value: days === undefined ? [] : [`WvmpSearchFilterTimeRange_LAST_${days}_DAYS`],
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

export function viewersBody(days?: ViewRange) {
  return serverRequest(
    'WvmpEntityList',
    `entityListQueryFilterPrefix${RANGE}`,
    { sortType: 'ProfileViewSortType_TIME_DESCENDING' },
    days,
  );
}

export function viewTotalsBody(days?: ViewRange) {
  return serverRequest(
    'WvmpAnalytics',
    `analyticsFieldsFilterPrefix${RANGE}`,
    {
      highlightCardDimensions: [
        'DimensionType_LOCATION',
        'DimensionType_INDUSTRY',
        'DimensionType_ORGANIZATION',
      ],
      detailsCardDimensions: ['DimensionType_ORGANIZATION'],
      highlightCardResultCount: 4,
      detailsCardResultCount: 23,
    },
    days,
  );
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
/** Size and weight, whatever style props sit between them and the text (Premium adds two). */
const TEXT_PROPS =
  /"textProps":\{"fontFamily":"[^"]*","fontSize":"(\w+)","fontStyle":"[^"]*","fontWeight":"(\w+)"(?:,"\w+":"[^"]*")*?,"children":/g;
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
 * Each viewer's profile id, from the action that follows their row: written
 * inline after the reference to it (Premium), or in a row referenced there.
 */
function idsByViewer(rows: Rows, items: Set<string>): Map<string, string> {
  const ids = new Map<string, string>();
  for (const row of rows.byId.values()) {
    let current: string | undefined;
    let from = 0;
    // The first id found after a viewer's reference, inline or referenced, is theirs.
    const settle = (id: string | undefined) => {
      if (current !== undefined && id !== undefined && !ids.has(current)) ids.set(current, id);
    };
    for (const m of row.matchAll(REF)) {
      const ref = m[1] as string;
      const at = m.index ?? 0;
      settle(row.slice(from, at).match(PROFILE_ID)?.[0]);
      from = at + m[0].length;
      if (items.has(ref)) current = ref;
      else if (current !== undefined && !ids.has(current)) settle(idUnder(rows, ref, items));
    }
    settle(row.slice(from).match(PROFILE_ID)?.[0]);
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

export interface ViewTotals {
  ok: true;
  total: number;
  /** The total's own label, when it names the period ("… in the past 90 days"). */
  period?: string;
  /** Premium: top location, industry and company, labelled as LinkedIn words it. */
  highlights?: { label: string; value: string }[];
  /** Premium: the companies viewers work at, with their share in percent. */
  companies?: { name: string; share: number }[];
}

const textsIn = (s: string) =>
  [...s.matchAll(PLAIN_TEXT)].map((m) => unquote(m[1] as string).trim());

/** Value, label, value, label…, after the section's heading. */
function highlightsOf(stream: string): { label: string; value: string }[] {
  const from = stream.indexOf('"viewName":"highlights"');
  if (from === -1) return [];
  const to = stream.indexOf('"viewName":"details"', from);
  const texts = textsIn(stream.slice(from, to === -1 ? undefined : to)).slice(1);
  const out: { label: string; value: string }[] = [];
  for (let i = 0; i + 1 < texts.length; i += 2)
    out.push({ value: texts[i] as string, label: texts[i + 1] as string });
  return out;
}

/** Each name followed by "(N%)", once. */
function companiesOf(texts: string[]): { name: string; share: number }[] {
  const seen = new Map<string, number>();
  texts.forEach((t, i) => {
    const share = t.match(/^\((\d+)\s*%\)$/)?.[1];
    const name = texts[i - 1];
    if (share !== undefined && name !== undefined && !seen.has(name)) seen.set(name, Number(share));
  });
  return [...seen].map(([name, share]) => ({ name, share }));
}

export function parseViewTotals(stream: string): ViewTotals | Failure {
  const texts = textsIn(stream);
  const at = texts.findIndex((t) => /^\d[\d.,\s]*$/.test(t));
  if (at === -1) return drift('the profile view totals carried no number');
  const total = Number((texts[at] as string).replace(/\D/g, ''));
  // The free page labels its total with the period; Premium only "profile viewers".
  const label = texts[at + 1];
  const highlights = highlightsOf(stream);
  const companies = companiesOf(texts);
  return {
    ok: true,
    total,
    ...(label !== undefined && /\d/.test(label) ? { period: label } : {}),
    ...(highlights.length > 0 ? { highlights } : {}),
    ...(companies.length > 0 ? { companies } : {}),
  };
}
