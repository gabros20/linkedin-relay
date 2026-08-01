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

  reactions: {
    name: 'reactions',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerSocialDashReactions.41ebf31a9f4c4a84e35a49d5abc9010b',
    provenance: 'verified',
    capturedAt: '2026-08-02',
  },

  // Comments. The variables carry a COMPOSITE socialDetailUrn assembled from the
  // post's own urn, repeated, plus a highlightedReply placeholder:
  //
  //   urn:li:fsd_socialDetail:(<postUrn>,<postUrn>,urn:li:highlightedReply:-)
  //
  // Two things were established by probing rather than assumed. Our codec's
  // percent-encoding of that urn's colons and parens is REQUIRED — the literal
  // form returns 400. And an `urn:li:activity:` post urn works directly, so
  // `post` does not need a feed lookup to find the ugcPost form first.
  comments: {
    name: 'comments',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerSocialDashComments.afec6d88d7810d45548797a8dac4fb87',
    provenance: 'verified',
    capturedAt: '2026-08-02',
  },

  // The member's own posts. Verified 200; returns an empty collection on an
  // account with no posts, which is a true empty rather than a failure.
  myPosts: {
    name: 'myPosts',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerFeedDashProfileUpdates.20c70fe0314184158516a7ec004c0408',
    provenance: 'verified',
    capturedAt: '2026-08-02',
  },

  // Discovered and returns 200, but the projection is useless: 39 KB containing
  // one `guideFetcher` wrapper and no name, tagline, description or headcount.
  // The same trap as the thin profile projection, so it stays unverified and
  // `company` does not ship. The richer path is probably
  // voyagerOrganizationDashViewWrapper with an organizationalPageUrn, which
  // first requires resolving that urn — unfinished work, not a dead end.
  company: {
    name: 'company',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerOrganizationDashCompanies.148b1aebfadd0a455f32806df656c3c1',
    provenance: 'discovered',
    capturedAt: '2026-08-02',
  },

  // A job CARDS list, not a job detail. Observed on /jobs/collections/recommended
  // and never exercised; `job` needs a detail endpoint we have not captured.
  jobCards: {
    name: 'jobCards',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerJobsDashJobCards.e5b6b761ede078dabe8ad857aa42c220',
    provenance: 'discovered',
    capturedAt: '2026-08-02',
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
