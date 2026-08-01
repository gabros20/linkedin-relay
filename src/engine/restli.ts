// ─── Rest.li 2.0 variables grammar ────────────────────────────────────────────
//
// LinkedIn's Voyager GraphQL endpoint does NOT take JSON variables. It takes
// Rest.li 2.0's own tuple grammar:
//
//   (key:value,key2:value2)   object literal
//   List(a,b,c)               array
//   a | b                     OR-group inside a single filter value
//
// nested to arbitrary depth. Example (verified, R3 §2):
//
//   ?queryId=voyagerSearchDashClusters.<hash>&variables=(start:0,query:(keywords:foo,
//     queryParameters:List((key:resultType,value:List(PEOPLE)))))
//
// Every client in the 90-repo corpus string-templates this. That is why adding a
// filter is a guessing game for them: an unescaped comma or paren in a user's
// search term silently terminates a tuple early and changes what you asked for
// without erroring. This module is the pure, tested alternative.

/** A value expressible in the Rest.li variables grammar. */
export type RestliValue =
  | string
  | number
  | boolean
  | undefined
  | RestliValue[]
  | { [key: string]: RestliValue };

/**
 * Characters that carry structural meaning in the grammar. They must be
 * percent-encoded inside a scalar, or the tuple's shape changes silently.
 */
const RESERVED = /[(),:|]/g;

const ENCODED: Record<string, string> = {
  '(': '%28',
  ')': '%29',
  ',': '%2C',
  ':': '%3A',
  '|': '%7C',
};

function encodeScalar(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  return value.replace(RESERVED, (c) => ENCODED[c] ?? c);
}

function encodeValue(value: RestliValue): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const members = value.map(encodeValue).filter((m): m is string => m !== undefined);
    return `List(${members.join(',')})`;
  }
  if (typeof value === 'object') return encodeObject(value);
  return encodeScalar(value);
}

function encodeObject(obj: { [key: string]: RestliValue }): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const encoded = encodeValue(value);
    // An undefined value is omitted entirely — never emitted as the string
    // "undefined", which LinkedIn would treat as a real filter value.
    if (encoded !== undefined) parts.push(`${key}:${encoded}`);
  }
  return `(${parts.join(',')})`;
}

/** Encode a variables object into the Rest.li 2.0 grammar. */
export function encodeVariables(vars: { [key: string]: RestliValue }): string {
  return encodeObject(vars);
}

// ─── Composite URNs ───────────────────────────────────────────────────────────
//
// Voyager URNs are not always `urn:li:type:id`. Tuple forms appear inline:
//
//   urn:li:fs_updateV2:(urn:li:activity:999,GROUP_FEED,EMPTY,DEFAULT,false)
//   urn:li:fsd_profilePositionGroup:(urn:li:fsd_profile:ABC,urn:li:fsd_company:(1,2))
//
// R3 §4 documents the reference implementation extracting the inner URN with
// `split("(")[1].split(",")[0]`. That is correct only until a member is itself a
// tuple — and nested tuples do occur. A paren-aware split is barely more code
// and does not have a silent failure mode.

export interface TupleUrn {
  /** The URN's own namespace, e.g. `fs_updateV2`. */
  namespace: string;
  /** Top-level members, with nested tuples left intact. */
  members: string[];
}

/**
 * Parse a composite (tuple-form) URN. Returns null when the URN is not
 * composite, or when its parentheses are unbalanced — an unbalanced URN is
 * malformed data, and guessing at its members would invent structure.
 */
export function parseTupleUrn(urn: string): TupleUrn | null {
  const open = urn.indexOf(':(');
  if (open === -1 || !urn.endsWith(')')) return null;

  const namespace = urn.slice(0, open).split(':').pop();
  if (namespace === undefined || namespace === '') return null;

  const body = urn.slice(open + 2, -1);
  const members: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of body) {
    if (char === '(') depth++;
    else if (char === ')') depth--;

    if (depth < 0) return null; // closed one we never opened

    if (char === ',' && depth === 0) {
      members.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (depth !== 0) return null; // opened one we never closed

  members.push(current);
  return { namespace, members };
}

/**
 * The identity a composite URN wraps — its first member. A non-composite URN is
 * returned unchanged, so this is safe to call on any URN.
 */
export function innerUrn(urn: string): string {
  const parsed = parseTupleUrn(urn);
  const first = parsed?.members[0];
  return first ?? urn;
}

// ─── Namespace collapse ───────────────────────────────────────────────────────
//
// R3 §4: LinkedIn is mid-migration from `fs_*` (legacy) to `fsd_*` (dash), and
// three profile URN forms coexist in live responses — the reference client
// literally string-replaces between them. This is the same legacy/hoisted split
// that cost x-relay real data, and the fix is the same: collapse to one identity
// so dedupe and cross-referencing are structural rather than best-effort.
//
// Only mappings we have direct evidence for are listed. An unknown namespace
// passes through untouched — inventing a mapping would silently merge two
// distinct entities, which is worse than leaving them separate.
const NAMESPACE_ALIASES: Record<string, string> = {
  fs_miniProfile: 'fsd_profile',
  fs_profile: 'fsd_profile',
};

/**
 * Canonicalise a URN: unwrap composite forms to their inner identity, then
 * collapse known legacy namespace aliases onto their dash equivalent.
 * Idempotent.
 */
export function canonicalUrn(urn: string): string {
  const inner = innerUrn(urn);
  const parts = inner.split(':');
  // urn:li:<namespace>:<id...>
  const namespace = parts[2];
  if (namespace === undefined) return inner;

  const alias = NAMESPACE_ALIASES[namespace];
  if (alias === undefined) return inner;

  parts[2] = alias;
  return parts.join(':');
}
