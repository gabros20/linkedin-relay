// Domain types + the envelope contract. Pure — no I/O, no network.

export interface Ok<T> {
  ok: true;
  command: string;
  data: T;
}

export interface Err {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    hint?: string;
    status?: number;
    retryAfterMs?: number;
  };
}

export type Envelope<T = unknown> = Ok<T> | Err;

/**
 * How complete a collection result is.
 *
 * Deliberately three-valued and REQUIRED on every collection payload. An
 * optional boolean would default to the reassuring answer when absent, which is
 * the same class of bug as an accept-list filter: a failure that reads as
 * success. `unknown` is a real and common state — we followed cursors to the
 * requested limit and cannot prove exhaustion.
 */
export type FetchState = 'complete' | 'partial' | 'unknown';

/** Where a rate cap's number actually came from. See docs/DESIGN.md §6. */
export type CapProvenance = 'guessed' | 'vendor-lore' | 'measured';

export interface BudgetMeta {
  class: string;
  spentInWindow: number;
  cap: number;
  remaining: number;
  capProvenance: CapProvenance;
  /** Present when remaining/cap has fallen below 25%. */
  warning?: string;
}

/**
 * Attached to every collection payload. The counts exist so drift is visible in
 * the response itself rather than only to someone who thinks to count.
 */
export interface FetchMeta {
  state: FetchState;
  operation: string;
  contractCapturedAt: string;
  rawCandidateCount: number;
  parsedCount: number;
  unknownCount: number;
  returnedCount?: number;
  claimedCount?: number;
  truncated?: boolean;
  unresolved?: { urn: string; referencedBy: string }[];
  unknownTypes?: { type: string; count: number }[];
  budget?: BudgetMeta;
  warnings: string[];
}

/** Provenance of an operation contract. Only `verified` may back a shipped command. */
export type ContractProvenance = 'verified' | 'discovered' | 'inferred';

export interface OperationContract {
  name: string;
  transport: 'voyager-restli' | 'voyager-graphql' | 'oauth';
  path: string;
  queryId?: string;
  decorationId?: string;
  provenance: ContractProvenance;
  capturedAt: string;
}
