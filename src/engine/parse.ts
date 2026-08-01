// ─── Normalising Voyager's decoration model ───────────────────────────────────
//
// LinkedIn returns a graph with a side-table, not a nested document:
//
//   { data:     { "*elements": ["urn:li:activity:100", …] },   ← thin refs, ORDERED
//     included: [ { entityUrn: "urn:li:activity:100", $type: …, … }, … ] }  ← unordered
//
// So: index `included[]` once into a Map, then walk `data`'s references against
// it. The reference implementation instead does an O(n·m) substring scan across
// the two, which is both slow and subtly wrong — we do not re-derive that.
//
// Three rules here are load-bearing, and each one exists because its absence
// caused a real production bug in the sibling project:
//
//   1. FILTER BY EXCLUSION.  Drop known noise; let everything else through. An
//      accept-list naming the types we know silently dropped every reply in
//      every thread on x-relay, and 34 of 77 posts per feed page — invisible
//      behind ok:true, a live cursor and a plausible count. On a live LinkedIn
//      feed, 39 of 44 included[] nodes are decorations rather than content, so
//      an accept-list here would look reasonable right up until a rename.
//
//   2. UNKNOWN IS NOT DROPPED, AND IT IS COUNTED.  A $type we have never seen
//      arrives as data AND increments meta.unknownTypes, so drift shows up in
//      the very first response after a LinkedIn deploy rather than whenever
//      someone next thinks to count.
//
//   3. UNRESOLVABLE IS NOT ABSENT.  A reference in `data` that `included[]`
//      does not contain is a FAILED decoration. It goes to meta.unresolved and
//      makes the result `partial` — never silently shorter.

import type { FetchState } from '../types.ts';
import { canonicalUrn } from './restli.ts';

export type Entity = Record<string, unknown> & { entityUrn?: string; $type?: unknown };

/**
 * Type fragments that identify chrome rather than content. Matched as
 * case-insensitive substrings of `$type`, because LinkedIn versions its type
 * names (`UpdateV2` → `UpdateV3`) and a fragment survives that.
 *
 * This list is the ONLY thing that removes data. Adding to it is a deliberate
 * act; forgetting to add to it costs some noise in the output, which is the
 * cheap failure. Forgetting to add to an accept-list costs the entire result,
 * silently, which is the expensive one.
 */
const DROP_TYPE_FRAGMENTS = [
  'promoted',
  'sponsored',
  'adunit',
  'peopleyoumayknow',
  'recommendedentity',
  'discoveryentity',
  'discoverymodule',
  'promptcomponent',
  'carouselcomponent',
  'lego',
  // Search-result chrome, observed live alongside real results.
  'feedbackcard',
  'lazyloadedactions',
  'bannercard',
  'searchsuggestion',
  'keywordssuggestion',
  'queryclarification',
  'knowledgecard',
  'topicalquestion',
];

/** Types that are supporting decorations — real, but not the thing asked for. */
const DECORATION_FRAGMENTS = [
  'socialdetail',
  'socialactivitycounts',
  'socialpermissions',
  'saveaction',
  'updateactions',
  'hidepostaction',
  'followinginfo',
  'miniprofile',
  'minicompany',
  'videoplaymetadata',
  'hidecommentaction',
  'followingstate',
  'followaction',
  'connectaction',
];

function typeOf(node: Entity): string {
  const t = node.$type ?? (node as { _type?: unknown })._type;
  return typeof t === 'string' ? t : '';
}

/**
 * A promoted feed post carries the SAME `$type` as a real one — the ad marker
 * lives in the actor's subdescription ("Promoted", "Promoted by <brand>"), not
 * in the type. Found live: an ad reached the output while every type-level
 * filter passed, which is the same lesson as the accept-list in a new costume.
 * Type is not the only place a thing can identify itself.
 */
function isPromotedPost(node: Entity): boolean {
  const actor = node.actor as { subDescription?: { text?: unknown } } | undefined;
  const sub = actor?.subDescription?.text;
  return typeof sub === 'string' && /^promoted\b/i.test(sub.trim());
}

function isNoise(node: Entity): boolean {
  if (isPromotedPost(node)) return true;
  const t = typeOf(node).toLowerCase();
  if (t === '') return false;
  return DROP_TYPE_FRAGMENTS.some((f) => t.includes(f));
}

function isDecoration(node: Entity): boolean {
  const t = typeOf(node).toLowerCase();
  return DECORATION_FRAGMENTS.some((f) => t.includes(f));
}

/**
 * Whether we recognise this type as one we have actually seen. Used ONLY to
 * count unknowns for reporting — never to decide whether to keep something.
 */
const KNOWN_CONTENT = [
  'updatev2',
  'profile',
  'jobposting',
  'company',
  'comment',
  'reaction',
  'entityresult',
];

function isKnown(node: Entity): boolean {
  const t = typeOf(node).toLowerCase();
  return KNOWN_CONTENT.some((f) => t.includes(f)) || isDecoration(node) || isNoise(node);
}

/** Build the `entityUrn → node` index in one pass, canonicalising namespaces. */
export function indexIncluded(included: unknown): Map<string, Entity> {
  const index = new Map<string, Entity>();
  if (!Array.isArray(included)) return index;

  for (const raw of included) {
    if (raw === null || typeof raw !== 'object') continue;
    const node = raw as Entity;
    const urn = node.entityUrn;
    if (typeof urn !== 'string') continue;

    // Store under BOTH the canonical and the literal form: references in `data`
    // may use either side of the fs_*/fsd_* migration.
    const canonical = canonicalUrn(urn);
    index.set(canonical, node);
    if (canonical !== urn) index.set(urn, node);
  }
  return index;
}

export interface ResolveResult {
  resolved: Entity[];
  unresolved: string[];
}

/** Resolve an ordered list of URN references against the index. */
export function resolveRefs(refs: unknown, index: Map<string, Entity>): ResolveResult {
  const resolved: Entity[] = [];
  const unresolved: string[] = [];
  if (!Array.isArray(refs)) return { resolved, unresolved };

  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    const node = index.get(ref) ?? index.get(canonicalUrn(ref));
    if (node === undefined) unresolved.push(ref);
    else resolved.push(node);
  }
  return { resolved, unresolved };
}

export interface ParseOpts {
  operation: string;
  /** What the platform claims exists, when it tells us. */
  claimedCount?: number;
  contractCapturedAt?: string;
  truncated?: boolean;
}

export interface ParseMeta {
  state: FetchState;
  operation: string;
  contractCapturedAt: string;
  rawCandidateCount: number;
  parsedCount: number;
  excludedCount: number;
  unknownCount: number;
  returnedCount: number;
  claimedCount?: number;
  truncated: boolean;
  unresolved?: string[];
  unknownTypes?: { type: string; count: number }[];
  warnings: string[];
}

export interface ParseResult {
  items: Entity[];
  meta: ParseMeta;
}

/**
 * Find the ordered reference list. Voyager marks references with a `*` prefix,
 * but arranges them in two quite different ways, and a parser that knows only
 * one returns an empty result for the other — with `ok:true`.
 *
 *   Collection shape   data["*elements"] = [urn, urn, …]
 *                      feed, dashProfiles. One array, already in order.
 *
 *   Cluster shape      data.data.<op>.elements[].items[].item["*entityResult"] = urn
 *                      search. One SINGLE string per item, nested three levels
 *                      down and spread across clusters.
 *
 * Both were captured live on 2026-08-01. Search parsed to zero items until this
 * handled the second shape — found only because the parser was run against a
 * real capture rather than its own fixtures.
 */
function findRefs(data: unknown): unknown[] {
  if (data === null || typeof data !== 'object') return [];

  // Pass 1 — the shallowest `*`-prefixed ARRAY wins. Breadth-first, so a
  // top-level "*elements" is preferred over anything nested beneath it.
  const queue: unknown[] = [data];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('*') && Array.isArray(value)) return value;
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') queue.push(value);
    }
  }

  // Pass 2 — no reference array anywhere, so collect `*`-prefixed STRINGS in
  // document order. Depth-first and in-order, because the order items appear
  // in the response IS the ranking LinkedIn assigned them.
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('*') && typeof value === 'string') refs.push(value);
      else walk(value);
    }
  };
  walk(data);
  return refs;
}

/**
 * A single-entity response (`/me`) carries no reference list at all — just one
 * decorated node in `included[]`. Returns undefined rather than throwing when
 * there is nothing, so callers decide what an absence means.
 */
export function parseSingle(payload: unknown): Entity | undefined {
  const envelope = (payload ?? {}) as { included?: unknown };
  const nodes = [...new Set(indexIncluded(envelope.included).values())];
  if (nodes.length === 0) return undefined;
  // Prefer a content node; fall back to the first, since a decoration is still
  // better than nothing when that is all the endpoint returns.
  return nodes.find((n) => !isNoise(n) && !isDecoration(n)) ?? nodes[0];
}

export function parseCollection(payload: unknown, opts: ParseOpts): ParseResult {
  const envelope = (payload ?? {}) as { data?: unknown; included?: unknown };
  const index = indexIncluded(envelope.included);
  const refs = findRefs(envelope.data);
  const { resolved, unresolved } = resolveRefs(refs, index);

  const items: Entity[] = [];
  const unknownTypes = new Map<string, number>();
  let excludedCount = 0;
  let unknownCount = 0;

  for (const node of resolved) {
    // Per-item isolation: one malformed node never takes the page with it.
    try {
      if (isNoise(node) || isDecoration(node)) {
        excludedCount++;
        continue;
      }
      if (!isKnown(node)) {
        // Unknown → KEEP it (rule 2), and count it so the drift is visible.
        const t = typeOf(node);
        unknownTypes.set(t, (unknownTypes.get(t) ?? 0) + 1);
        unknownCount++;
      }
      items.push(node);
    } catch {
      excludedCount++;
    }
  }

  const warnings: string[] = [];
  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} referenced entities were not present in included[] — the decoration failed for those, so this record is incomplete rather than short.`,
    );
  }
  if (opts.claimedCount !== undefined && opts.claimedCount > 0 && items.length === 0) {
    warnings.push(
      `LinkedIn claims ${opts.claimedCount} items but returned none — treat this as a FAILED FETCH, not an empty result.`,
    );
  }

  const state: FetchState =
    unresolved.length > 0 ? 'partial' : opts.truncated === true ? 'unknown' : 'complete';

  const meta: ParseMeta = {
    state,
    operation: opts.operation,
    contractCapturedAt: opts.contractCapturedAt ?? 'unknown',
    // parsedCount counts what we kept; `items` includes the unknowns, which is
    // why unknownCount is reported separately rather than added again here.
    rawCandidateCount: resolved.length,
    parsedCount: items.length - unknownCount,
    excludedCount,
    unknownCount,
    returnedCount: items.length,
    truncated: opts.truncated ?? false,
    warnings,
  };
  if (opts.claimedCount !== undefined) meta.claimedCount = opts.claimedCount;
  if (unresolved.length > 0) meta.unresolved = unresolved;
  if (unknownTypes.size > 0) {
    meta.unknownTypes = [...unknownTypes.entries()].map(([type, count]) => ({ type, count }));
  }

  return { items, meta };
}
