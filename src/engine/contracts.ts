// ─── Operation contracts ──────────────────────────────────────────────────────
//
// Every endpoint we call, as DATA — never inline in request logic. queryIds and
// decorationIds are pinned to LinkedIn's deployed web-client build and can
// rotate; keeping them here means a rotation is a data edit, not a code hunt.
//
// Each contract carries its provenance and the date it was captured, and
// `shippableContracts()` admits only `verified` ones. That rule is mechanical
// rather than a convention someone has to remember:
//
//   verified    returned 200 on this machine, on the date recorded
//   discovered  seen in live traffic (scripts/observe.ts) but never exercised
//   inferred    from documentation or another client — may be archaeology
//
// The cost of getting this wrong is documented: `identity/profiles/{id}/
// profileView` was the reference client's core profile endpoint, was documented
// as working in November 2024, and returns 410 Gone today. It is kept below,
// marked dead, so nobody re-adds it from an old blog post.
//
// Refresh with: bun run scripts/observe.ts <path>   (see docs/ENGINE-RESEARCH.md)

import type { OperationContract } from '../types.ts';

const VOYAGER = 'https://www.linkedin.com/voyager/api';

export const CONTRACTS: Record<string, OperationContract> = {
  me: {
    name: 'me',
    transport: 'voyager-restli',
    path: `${VOYAGER}/me`,
    provenance: 'verified',
    capturedAt: '2026-08-01',
  },

  // Three `voyagerIdentityDashProfiles` queryIds were observed on one page —
  // they are different PROJECTIONS of one operation, and picking the wrong one
  // gets you a 200 containing nothing useful:
  //
  //   b5c27c04…  identity only — entityUrn + versionTag. Looks like success.
  //   e9b08094…  the real profile: headline, geo, top position, education.  ← this
  //   da93c92b…  400s with (profileUrn:…); its variables shape is unknown.
  //
  // None of them returns firstName/lastName/publicIdentifier — LinkedIn splits
  // names into a projection we have not identified. Documented rather than
  // faked; the caller already knows who they asked for.
  profile: {
    name: 'profile',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerIdentityDashProfiles.e9b0809465a07db1f02e70a82d455e10',
    provenance: 'verified',
    capturedAt: '2026-08-01',
  },

  feed: {
    name: 'feed',
    transport: 'voyager-restli',
    path: `${VOYAGER}/feed/updatesV2`,
    provenance: 'verified',
    capturedAt: '2026-08-01',
  },

  // The November-2024 queryId, still returning 200 in August 2026 — roughly 21
  // months unchanged. Notable because kill criterion #3 assumed queryIds might
  // rotate weekly; on this evidence they are build-pinned but long-lived.
  search: {
    name: 'search',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0',
    provenance: 'verified',
    capturedAt: '2026-08-01',
  },

  // Observed on a live post page but not yet exercised by us, so it cannot back
  // a shipped command until someone runs it and it returns 200.
  reactions: {
    name: 'reactions',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerSocialDashReactions.41ebf31a9f4c4a84e35a49d5abc9010b',
    provenance: 'discovered',
    capturedAt: '2026-08-01',
  },
};

/**
 * Endpoints known to be DEAD. Listed so a future maintainer reading the
 * November-2024 reference client does not helpfully re-add one.
 */
export const RETIRED: Record<string, { path: string; diedBy: string; note: string }> = {
  profileView: {
    path: `${VOYAGER}/identity/profiles/{id}/profileView`,
    diedBy: '2026-08-01',
    note:
      'Returns 410 Gone inside a well-formed Voyager envelope. Superseded by the `profile` ' +
      'contract above. Every client that reads profiles through this is broken.',
  },
};

/** Only `verified` contracts may back a shipped command. */
export function shippableContracts(): Record<string, OperationContract> {
  return Object.fromEntries(
    Object.entries(CONTRACTS).filter(([, c]) => c.provenance === 'verified'),
  );
}

export function contractFor(name: string): OperationContract | undefined {
  return shippableContracts()[name];
}
