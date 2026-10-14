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
  // Needs the `fsd_profile` namespace, NOT the `fs_miniProfile` urn `whoami`
  // returns — the legacy form answers 200 with an empty result rather than an
  // error. That was invisible until the account had a post to return, and is
  // why engine.myPosts canonicalises the urn before sending it.
  //
  // KNOWN INCOMPLETE (2026-08-13): with the namespace fixed this returns the
  // owner's posts, but a post created minutes earlier did not appear here, nor
  // in `feed`, over ~1.5 hours. Whether that is an indexing lag or a coverage
  // A WRITE contract: creates a poll object that a post then references. The
  // queryId is from mguttmann/linkedin-internal-api (docs/24) and returned a
  // pollSummary urn on this machine on the date below.
  createPoll: {
    name: 'createPoll',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerFeedDashPollsPollSummary.f8ad99cf791d833d37dddb373d06fb3a',
    provenance: 'verified',
    capturedAt: '2026-10-13',
  },

  // The composer's link lookup: a URL in, the article LinkedIn made of it out
  // (`urn:li:article:<id>`), which a post then carries as ARTICLE media. queryId
  // from mguttmann/linkedin-internal-api; same article urn the web composer
  // attached when captured on the date below.
  urlPreview: {
    name: 'urlPreview',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/graphql`,
    queryId: 'voyagerContentcreationDashUpdateUrlPreview.b092c1aea4b6c087ec0d09614b3b3320',
    provenance: 'verified',
    capturedAt: '2026-10-13',
  },

  // limit of this projection is UNRESOLVED — do not treat this endpoint as an
  // authoritative "all my posts" until it is settled.
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

  // Job search, captured 2026-10-14. The jobs page itself now opens an SDUI
  // "AI job search" that drops filters it does not support; these are the
  // classic Voyager resources still behind /jobs/search/, which take them all.
  // See engine/jobs.ts.
  // The owner's messages, captured 2026-10-14; see engine/messaging.ts. Reads
  // only: the page's own "seen", read and delivery calls are not made.
  messengerConversations: {
    name: 'messengerConversations',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/voyagerMessagingGraphQL/graphql`,
    queryId: 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf',
    provenance: 'verified',
    capturedAt: '2026-10-14',
  },
  messengerMessages: {
    name: 'messengerMessages',
    transport: 'voyager-graphql',
    path: `${VOYAGER}/voyagerMessagingGraphQL/graphql`,
    queryId: 'messengerMessages.5846eeb71c981f11e0134cb6626cc314',
    provenance: 'verified',
    capturedAt: '2026-10-14',
  },

  // Connection invitations the owner has sent, captured 2026-10-14; see
  // engine/network.ts.
  sentInvitations: {
    name: 'sentInvitations',
    transport: 'voyager-restli',
    path: `${VOYAGER}/relationships/sentInvitationViewsV2`,
    provenance: 'verified',
    capturedAt: '2026-10-14',
  },

  jobCards: {
    name: 'jobCards',
    transport: 'voyager-restli',
    path: `${VOYAGER}/voyagerJobsDashJobCards`,
    decorationId: 'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220',
    provenance: 'verified',
    capturedAt: '2026-10-14',
  },
  jobFilters: {
    name: 'jobFilters',
    transport: 'voyager-restli',
    path: `${VOYAGER}/voyagerJobsDashSearchFilterClustersResource`,
    decorationId: 'com.linkedin.voyager.dash.deco.search.SearchFilterCluster-44',
    provenance: 'verified',
    capturedAt: '2026-10-14',
  },
  jobPosting: {
    name: 'jobPosting',
    transport: 'voyager-restli',
    path: `${VOYAGER}/jobs/jobPostings`,
    decorationId: 'com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65',
    provenance: 'verified',
    capturedAt: '2026-10-14',
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
