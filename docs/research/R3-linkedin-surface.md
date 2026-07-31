# R3 — LinkedIn's actual technical surface (engine-research seed)

Standard of specificity target: `x-relay`'s `docs/ENGINE-RESEARCH.md`. Primary source for §1-4 is the actual
**Nov 2024** PyPI release of `tomquirk/linkedin-api` v2.3.1 (`linkedin-api-2.3.1.tar.gz`, downloaded and read
directly from `files.pythonhosted.org` — this is real, current-ish source, not a paraphrase). Its GitHub repo
(`github.com/tomquirk/linkedin-api`) 404s as of this research (2026-08-01) despite the package being live on
PyPI — see "biggest unknowns" #3. Cross-checked against LinkedIn's own (public v2 API) Microsoft Learn docs and
one very actively maintained 2026 open-source client (`stickerdaniel/linkedin-mcp-server`, ~2,976 stars, pushed
2026-07-31).

---

## 1. Auth

**Cookies.** `li_at` (session token) + `JSESSIONID` are the two load-bearing cookies; **`csrf-token` header is
`JSESSIONID` with surrounding quotes stripped** — a literal derivation, not a separate secret:
```python
self.session.headers["csrf-token"] = self.session.cookies["JSESSIONID"].strip('"')
```
`[verified: tomquirk/linkedin-api client.py, PyPI 2.3.1, released 2024-11-07]`

**Headers sent on every Voyager call:**
```
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36
accept-language: en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7
x-li-lang: en_US
x-restli-protocol-version: 2.0.0
csrf-token: <JSESSIONID, unquoted>
```
`[verified: same source]` — the UA is a stale Chrome 83 default; a real 2026 client should refresh it, and a
closed-but-live issue on a popular fork (`nsandman/linkedin-api#8`, "Getting a CHALLENGE when logging in") was
resolved by bumping to a current Chrome UA — UA staleness is itself a detection signal `[reported: GitHub issue,
undated but referencing Chrome 131, i.e. ~early 2025]`.

Commonly-cited-elsewhere but **not seen in the code I read**: `x-li-track` (JSON blob:
`clientVersion, osName, timezoneOffset, deviceFormFactor, mpName`), `x-li-page-instance`, `x-li-deviceId`,
`bcookie`/`bscookie`, `li_rm`. The 2.3.1 source has an `x-li-track` line **commented out** — i.e. an actual
maintainer judged it non-essential for at least some endpoints. Treat all of these as
`[unverified — cargo-cult candidates]` pending a live capture.

**Auth flow (password-based, legacy path in this library):** `POST /uas/authenticate` with
`{session_key, session_password, JSESSIONID}`; success requires `login_result == "PASS"`, else the library
raises `ChallengeException(login_result)`. Auth-phase headers are a distinct, mobile-flavored set:
`X-Li-User-Agent: LIAuthLibrary:0.0.3 com.linkedin.android:4.1.881 Asus_ASUS_Z01QD:android_9`,
`User-Agent: ANDROID OS` `[verified: client.py]`. Session validity is checked purely by `JSESSIONID` cookie
expiry (`cookie.expires > now`) — no server round-trip `[verified: cookie_repository.py]`. **`li_at`'s actual
lifetime was not resolved by this research** `[unverified]`; widely claimed as ~1 year in SEO blogs, not
confirmed against a primary source.

**The 2026 alternative to cookie-injection: don't parse cookies at all.** The most-starred, most-recently-active
LinkedIn agent tool in this space, `stickerdaniel/linkedin-mcp-server` (README fetched 2026-07-31, repo pushed
same day), explicitly **does not do raw HTTP+cookie Voyager calls**. It drives a real Chromium instance
(Patchright, a stealth fork) against a persistent logged-in browser profile at `~/.linkedin-mcp/profile/`, and
states the rationale directly: *"This tool controls a real browser session; it doesn't exploit undocumented
APIs or bypass authentication."* `li_at` there is just whatever cookie lives inside that real browser profile —
sessions come from `--login`, import from an existing browser, or Docker-side host-cookie import
`[verified: README, fetched 2026-07-31]`. This is a load-bearing architectural signal for our design — see
"biggest unknowns" #2.

---

## 2. The Voyager surface

Base: `https://www.linkedin.com/voyager/api` `[verified]`. Two coexisting request styles hit the same base:

**(a) Legacy REST.li-finder style** — `GET /voyager/api/{namespace}/{resource}?q=<finderName>&<params>`:
`/identity/profiles/{id}/profileView`, `/organization/companies?q=universalName&universalName=<id>&decorationId=...`,
`/feed/updates?q=chronFeed`, `/relationships/invitationViews?q=receivedInvitation`, `/messaging/conversations?q=participants&recipients=List(<urn>)`
`[verified: linkedin.py, 2.3.1]`.

**(b) GraphQL-flavored** — `GET /voyager/api/graphql?queryId=<OperationName>.<32-hex-hash>&variables=(...)`.
**Variables are NOT JSON** — they're Rest.li 2.0.0's own tuple/list grammar, exactly the thing the task brief
called out as the trap:
```
/graphql?variables=(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:foo,flagshipSearchIntent:SEARCH_SRP,
  queryParameters:List((key:resultType,value:List(PEOPLE)),(key:network,value:List(F | S))),
  includeFiltersInResponse:false))&queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0
```
`(key:value,key2:value2)` = object literal, `List(a,b,c)` = array, `a | b` = OR-group inside one filter value,
nesting is arbitrary-depth parens. `[verified: linkedin.py search() and get_profile_experiences(), 2.3.1]`.
queryId shape is `<OperationName>.<hash>`, e.g. `voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0`,
`voyagerIdentityDashProfileComponents.7af5d6f176f11583b382e37e5639e69e` `[verified, Nov-2024 snapshot]`. One
other source (`joshuatz/linkedin-to-jsonresume` dev notes, undated) describes **how** these are minted: the web
client resolves them at runtime via `window.require()` against the loaded Ember/webpack bundle, calling
`getGraphQLQueryId()` from `@linkedin/ember-restli-graphql` — i.e. queryIds are **pinned to the deployed web
client build**, not stable across LinkedIn frontend deploys, structurally identical to X's rotating
query-hashes. Exact rotation cadence: `[unverified]` — see "biggest unknowns" #1.

**`decorationId`** (e.g. `com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-174`,
`com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12`) is the internal-API cousin of the public
API's `projection=(...)` — it names a server-side field-expansion recipe rather than spelling out fields inline
`[verified: linkedin.py + cross-checked against the official decoration doc, §4]`.

**Pagination — two mechanisms coexist, pick per-endpoint:**
- Classic `start`/`count` offset paging (search, most collection finders).
- `paginationToken` cursor paging: token comes back in `metadata.paginationToken`, is re-sent as a param —
  used by `get_profile_posts` (`/identity/profileUpdatesV2`) and `get_post_comments` (`/feed/comments`).
`[verified: linkedin.py, both loops explicitly branch on `data["metadata"]["paginationToken"] != ""`]`

---

## 3. Endpoint inventory (intended commands → best-known path)

All entries **verified against the Nov-2024 `linkedin-api` 2.3.1 source** unless flagged otherwise.

| Intent | Path / shape | Notes |
|---|---|---|
| People search | `GET /graphql?queryId=voyagerSearchDashClusters.<hash>&variables=(...,queryParameters:List((key:resultType,value:List(PEOPLE)),...))` | filters: network depth, current/past company, region, industry, school, language, keyword first/last/title/company/school |
| Company search | same `search()` call, `resultType=COMPANIES` | |
| Job search | `GET /voyagerJobsDashJobCards?decorationId=...&q=jobSearch&query=(origin:JOB_SEARCH_PAGE_QUERY_EXPANSION,keywords:...,selectedFilters:(...))&start=&count=` | response filtered from `included[]` where `$type == com.linkedin.voyager.dash.jobs.JobPosting` — **exclusion-style filter on the decoration side**, not the request side |
| Post/content search | via the same `graphql?queryId=voyagerSearchDashClusters...` search with a content-flavored `resultType` | not explicitly modeled in this library; **unverified path for posts specifically** |
| Profile fetch | `GET /identity/profiles/{public_id\|urn_id}/profileView` — legacy, monolithic (experience/education/skills/languages/publications/certs/volunteer/honors/projects all in one response) | code comment: *"still works for now, but will probably eventually have to be converted to `/identity/profiles/{urn}`"* — LinkedIn's own maintainer expects this to move |
| Profile "full" fan-out | `profileView` (bulk) **or** per-section GraphQL: `GET /graphql?queryId=voyagerIdentityDashProfileComponents.7af5d6f176f11583b382e37e5639e69e&variables=(profileUrn:<urn-encoded>,sectionType:experience)` | the dash/GraphQL replacement path, section-at-a-time |
| Contact info | `GET /identity/profiles/{id}/profileContactInfo` | |
| Skills | `GET /identity/profiles/{id}/skills?count=&start=` | |
| Privacy / badges / network info | `GET /identity/profiles/{id}/{privacySettings\|memberBadges\|networkinfo}` | response wrapped `{data: {...}}` |
| Post + comment thread | `GET /feed/comments?q=comments&sortOrder=RELEVANCE&updateId=activity:<urn>&count=&start=` | `paginationToken` paging; empty `elements` on next page = end |
| Reactions/commenters on a post | `GET /voyagerSocialDashReactions?decorationId=com.linkedin.voyager.dash.deco.social.ReactionsByTypeWithProfileActions-13&q=reactionType&threadUrn=<urn>&count=&start=` | code comment flags this itself as likely due for a GraphQL rewrite (links `tomquirk/linkedin-api#309`) |
| React to a post | `POST /voyagerSocialDashReactions?threadUrn=urn:li:activity:<id>` body `{reactionType: LIKE\|PRAISE\|APPRECIATION\|EMPATHY\|INTEREST\|ENTERTAINMENT}`, expects `201` | |
| Own feed | `GET /feed/updatesV2?q=chronFeed&count=&start=` | response has **both** `data.*elements` (URN list, correctly chron-sorted, includes promoted) and `included[]` (full objects, unsorted) — must cross-reference, see §4 |
| Company page + updates | `GET /organization/companies?q=universalName&universalName=<id>&decorationId=...`; updates via `GET /feed/updates?q=companyFeedByUniversalName&companyUniversalName=<id>` | |
| Connections list | `search_people(connection_of=<urn_id>)` — i.e. connections is just a filtered people-search, not a dedicated endpoint | |
| Saved/bookmarked items | **no endpoint found in this source** | `[unverified]` — likely exists under a `savedItems`/`bookmark` Voyager namespace but not covered by this library |
| Notifications | **no endpoint found in this source** | `[unverified]` |
| Messaging — list | `GET /messaging/conversations?keyVersion=LEGACY_INBOX` | |
| Messaging — thread | `GET /messaging/conversations/{id}/events` | |
| Messaging — send | `POST /messaging/conversations/{id}/events?action=create` or `POST /messaging/conversations?action=create` (new thread) with an `eventCreate.value["com.linkedin.voyager.messaging.create.MessageCreate"]` payload | |
| Connect / withdraw | `POST /voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=...` body `{invitee:{inviteeUnion:{memberProfile:"urn:li:fsd_profile:<id>"}},customMessage}`; invitations list `GET /relationships/invitationViews?q=receivedInvitation`; accept/reject `POST /relationships/invitations/{id}?action=accept\|reject` | |
| Follow / unfollow | follow: `POST /feed/dash/followingStates/{urn}` body `{"patch":{"$set":{"following":true}}}` (Rest.li **PATCH `$set` semantics**, not a plain PUT); unfollow: `POST /feed/follows?action=unfollowByEntityUrn` body `{urn:"urn:li:fs_followingInfo:<id>"}` | |
| Current user ("me") | `GET /me`, cached in-process | |
| Jobs — detail | `GET /jobs/jobPostings/{id}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebLightJobPosting-23` | |
| Jobs — skills match | `GET /voyagerAssessmentsDashJobSkillMatchInsight/urn%3Ali%3Afsd_jobSkillMatchInsight%3A{id}?decorationId=...` | |
| Analytics beacon (not useful to us) | `POST /li/track` (hits `linkedin.com` directly, not `/voyager/api`) | included only because it shows a **third** base-path pattern exists |

---

## 4. Response shapes — the `included[]`/`data` decoration model

**Voyager's own shape** (dash/GraphQL-era, e.g. `feed/updatesV2`, `graphql` search): top-level
`{data: {...}, included: [...]}`. `data` holds thin *references* — often literally an array of URN strings under
a `*`-prefixed key (`data["*elements"]` in `feed/updatesV2`). `included[]` is a **flat, unordered array** of
fully-decorated objects, each carrying a `$type` (legacy namespace, e.g.
`com.linkedin.voyager.dash.jobs.JobPosting`) or nested `_type` discriminators inside GraphQL result trees (e.g.
`com.linkedin.voyager.dash.search.EntityResultViewModel`), and identified by its own `entityUrn`.
`[verified: linkedin.py, multiple methods]`

**Resolution mechanism, as this library actually implements it**: for `feed/updatesV2`, it walks `included[]`
and hand-extracts fields via helper functions (`get_update_author_name`, `get_update_url`, ...) into a flat list
of dicts keyed by a synthesized `url` field, walks `data["*elements"]` separately to get the *correctly ordered*
URN list, then does an **O(n·m) linear scan** matching `urn in post["url"]` to zip the two together and drop
anything tagged `"Promoted"` `[verified: utils/helpers.py: get_urn_from_raw_update, parse_list_raw_posts,
get_list_posts_sorted_without_promoted]`. This is a working reference implementation but a naive one — our
port should build an `entityUrn → object` map first (same shape as x-relay's flat `{tweets:{id}, users:{id}}`
maps from its `__typename` walk) rather than re-deriving x-relay's own lesson the hard way.

**Composite/tuple URNs** appear inside this model, not just simple `urn:li:type:id` — e.g.
`urn:li:fs_updateV2:(<innerUrn>,GROUP_FEED,EMPTY,DEFAULT,false)`, extracted by the library via
`raw_string.split("(")[1].split(",")[0]` (i.e. hand-rolled tuple parsing, not a generic parser)
`[verified: get_urn_from_raw_update]`. Also seen: `urn:li:fsd_profilePositionGroup:(<a>,<b>)` for grouped
experience entries.

**A live legacy→dash migration is visible in the URN namespaces themselves** — directly parallel to X's
`legacy:null` core/legacy split that cost x-relay real data. `get_profile()` explicitly rewrites
`profile["miniProfile"]["entityUrn"]` by string-replacing `"fs_miniProfile"` → `"fsd_profile"` before using it
elsewhere, and comments elsewhere flag REST endpoints as "will probably eventually have to be converted." URNs
observed: `urn:li:fs_miniProfile:<id>` (legacy), `urn:li:fsd_profile:<id>` (dash/new), `urn:li:fs_profile:<id>`
(a *third* profile URN form, seen in `entityUrn` at profile root), `urn:li:activity:<id>` (post),
`urn:li:fs_followingInfo:<id>`, `urn:li:fsd_jobSkillMatchInsight:<id>`. **Treat `fs_*` vs `fsd_*` as the same
migration-drift risk x-relay already learned to fear — filter by exclusion, never by an accept-list of known
`$type`/URN-namespace values.** `[verified via source + my synthesis of the parallel to x-relay's own documented
incident]`

**The official (public, OAuth) v2 API uses a related but structurally different decoration syntax** —
inline expansion via a `~` suffix rather than a flat side-table:
```
GET /v2/shares/1234?projection=(id,owner~(localizedFirstName,localizedLastName))
→ {"id":"1234","owner":"urn:li:person:...","owner~":{"localizedFirstName":"Schrute","localizedLastName":"Dwight"}}
```
and a failed expansion returns `owner!` (bang-suffixed) with a `{serviceErrorCode, message, status}` error
object **instead of** failing the whole request — e.g. a `/me` call succeeds while its embedded
`profilePicture.displayImage~` sub-expansion independently 429s. `[verified: Microsoft Learn "URNs" (dated
2021-02, still live 2026) and "Response Decoration" (dated 2023-09, updated 2024-09) docs, live-fetched]`. This
is architecturally not Voyager, but the same LinkedIn-wide Rest.li decoration DNA — useful as a second, cleaner
reference for what the *general* mechanism is trying to do, even though Voyager's own encoding (flat
`included[]`, not inline `~`) is what our parser actually has to handle.

---

## 5. Defenses

- **HTTP 999 "Request Denied"** — LinkedIn-specific, non-standard, pre-auth network-layer block for bot-shaped
  traffic (non-browser UA, datacenter/cloud IP ranges, high request velocity, robots.txt violations); LinkedIn's
  own stated framing is that it's automatic and lifts once traffic normalizes. `[reported: multiple 2026
  scraping guides + http.dev status-code reference; this mechanism has been documented since at least 2013 per
  an old HN thread, i.e. it is old and durable, not new]`
- **CHALLENGE / login failure**: in the password-auth flow, any `login_result != "PASS"` raises
  `ChallengeException` `[verified: client.py]`. In the real-browser-automation flow (2026 state of the art per
  §1), practitioners report CAPTCHA prompts, LinkedIn-mobile-app login confirmations, and IP/proxy-change-
  triggered checkpoints as the live defenses — explicitly: *"switching to [a proxy] is itself the kind of
  change that triggers a checkpoint"* `[reported: stickerdaniel/linkedin-mcp-server README/FAQ, fetched
  2026-07-31]`.
- **429 (official API)**: error body `{"message":"Resource level throttle limit for calls to this resource is
  reached.","serviceErrorCode":429,"status":429}`; can fire on a decoration sub-call while the primary call
  returns 200 (see §4); LinkedIn states some 429s are unannounced "infrastructure protection" that self-resolves
  `[verified: MS Learn error-handling doc, dated 2025-03-24]`. **No equivalent official documentation exists for
  Voyager's actual thresholds** — only anecdotal numbers from SEO-tier guides (~900 requests/hour in one
  account; ~50 direct profile-URL loads/day as a "safe" ceiling) `[reported, low-confidence — no primary
  source]`.
- **Escalation ladder** consistently reported across 2026 practitioner/vendor content: warning → temporary
  restriction (search capped, profile views throttled, typically 1–3 weeks) → permanent ban; a new account
  created during a restriction gets flagged too. `[reported, consistent across several sources, none primary —
  treat as directionally right, not numerically precise]`
- **UA/fingerprint staleness as a live trigger**: a still-open GitHub issue on a maintained fork
  (`nsandman/linkedin-api#8`, "Getting a CHALLENGE when logging in") reports the challenge disappearing after
  updating the hardcoded UA string to a current Chrome version — direct evidence that header freshness alone
  measurably affects challenge rate. `[reported: live GitHub issue, references Chrome 131 i.e. ~early 2025]`
- **Legal, not just technical**: *LinkedIn Corp. v. Nubela Pte. Ltd. / Proxycurl* — filed **2025-01-24**, N.D.
  Cal., Case No. 3:25-cv-00828. Six claims: breach of the LinkedIn User Agreement (§§8.2(2) fraud/deceit,
  8.2(4) buying from "data aggregators or brokers," 8.2(11), 8.2(13)), CFAA, California UCL, Lanham Act
  trademark dilution, misappropriation. Settled 2025; Proxycurl (at the time ~$10M ARR) shut down entirely.
  `[verified: Law.com court-filing report, 2025-01-27; corroborated by the founder's own first-person account,
  nubela.co/blog, undated but referencing the 2025 filing and post-hoc 2026 reflection]`. The founder's own
  stated lessons, directly relevant even to a **single personal account**: (1) §8.2(4)'s "no data
  aggregators/brokers" clause reaches downstream *buyers* of scraped data, not just the scraper; (2) creating a
  LinkedIn **Company Page** alone was the contractual hook that gave LinkedIn jurisdiction over a foreign
  entity — i.e. *any* account-holding relationship with LinkedIn, not scale, is what creates contract exposure;
  (3) his verbatim conclusion: **"Legal does not mean safe."** `[verified, first-person primary source]`. Read
  alongside *hiQ v. LinkedIn* (9th Cir. 2019, later proceedings) — hiQ established that scraping logged-out,
  public data doesn't itself violate the CFAA, but explicitly does **not** immunize breach-of-contract claims
  once an account and its User Agreement are in play, which is exactly the theory that later worked against
  Proxycurl. **For linkedin-relay this matters concretely: it operates through the user's own logged-in
  account, so the CFAA question is moot and the User Agreement is the entire exposure surface — the same
  clauses Proxycurl was sued under apply, undiminished, to a single-account personal tool.** `[my synthesis of
  verified case facts]`

---

## 6. The official path — precisely what's self-serve

Two products are genuinely self-serve, in-portal, no partner review, no company verification, no screencast —
literally "select your app → Products tab → click add":

**Sign In with LinkedIn using OpenID Connect** — scopes `openid` (required), `profile` (id, name, picture),
`email` (address, optional in response). OAuth endpoints (from the live discovery document,
`https://www.linkedin.com/oauth/.well-known/openid-configuration`, fetched 2026-08-01):
`authorization_endpoint: https://www.linkedin.com/oauth/v2/authorization`,
`token_endpoint: https://www.linkedin.com/oauth/v2/accessToken`,
`userinfo_endpoint: https://api.linkedin.com/v2/userinfo`, `jwks_uri: https://www.linkedin.com/oauth/openid/jwks`.
Returns an RS256 JWT id_token (`iss, sub, aud, iat, exp` + optional `name, given_name, family_name, picture,
email, email_verified, locale`) plus an access token good for calling `/v2/userinfo` directly. **Read-only
identity only — no content, no connections, no feed.** `[verified: MS Learn self-serve doc, updated 2024-08-08;
discovery JSON live-fetched 2026-08-01]`

**Share on LinkedIn** — scope `w_member_social`: lets the app **post, comment, and like as the authenticated
member**. `[verified: MS Learn self-serve doc]` It is **write-only** — no documented way to read back the
member's own feed, connections, or post analytics under this scope; that requires Marketing Developer Platform.

Everything else in linkedin-relay's intended read/research surface — people/company search, follower or
engagement analytics, a company page's post history, the authenticated user's own feed, notifications,
Recruiter/Sales Navigator data — sits behind partner-gated programs:

- **Marketing Developer Platform**: manual approval, no published timeline, "weeks at best, months on
  average" per third-party guides; no published pricing, third-party estimates ~$699+/mo alone, $50k–$300k+/yr
  for enterprise multi-product deals `[reported: getphyllo/connectsafely 2026 guides — industry-analysis tier,
  not LinkedIn-primary, treat pricing figures as rough]`.
- **Community Management API**: two-tier (Development → Standard), requires registered company + **verified
  Page**, and — notably — **must be the only product on that developer app** (mutually exclusive with any other
  product grant on the same app); Standard tier upgrade requires a screencast demonstrating each claimed use
  case `[reported: MS Learn Community Management overview, view=li-lms-2026-06, i.e. current per LinkedIn's own
  versioned docs]`.
- **Sales Navigator API (SNAP)**: LinkedIn's own portal states it is not accepting new partner applications as
  of 2026 `[reported, 2026 guide — could not independently verify against LinkedIn's own portal copy]`.

**Bottom line for the hybrid-legitimacy question the design must answer**: an individual developer can legally,
self-serve get exactly (1) "log in with LinkedIn" identity and (2) posting/commenting/reacting as themselves.
That's it. **There is no officially-sanctioned read path at all** for search, profile-reading, thread-reading,
feed, notifications, or connections — the entire read/research half of linkedin-relay's ambition has zero
legitimate API alternative to Voyager. The **write** half is different: `w_member_social` could, in principle,
replace cookie-authenticated Voyager calls for the account's *own* posts/comments/reactions, trading Voyager
fragility and ToS exposure for OAuth stability on exactly that slice. Worth putting to the panel as a concrete
fork: **official OAuth for self-originated writes, Voyager (accepted risk) for all reads** — rather than
Voyager end-to-end.

---

## Biggest unknowns (only resolved by watching real traffic)

1. **Current (2026) queryId values, `variables`/feature shapes, and rotation cadence** for the operations
   linkedin-relay actually needs. Everything in §2-3 is a real Nov-2024 snapshot, not a 2026 capture. Exactly
   like x-relay's `ops.ts`, these must be scraped from a live logged-in browser session before implementation —
   we have zero evidence of *how often* LinkedIn's web client redeploys and invalidates queryIds (daily? per
   sprint? pinned for months?).
2. **Whether raw HTTP+cookie Voyager calls are still viable at all in mid-2026**, or whether the ecosystem has
   already tipped into real-browser-automation-only. The single most-starred, most-recently-pushed (2026-07-31)
   open-source LinkedIn agent tool in this space has abandoned raw HTTP entirely for a stealth-Chromium
   (Patchright) approach against a persistent logged-in profile, explicitly citing "doesn't exploit undocumented
   APIs" as the reason. That's a strong signal, not proof of technical necessity — could be legal-risk-aversion
   by that maintainer rather than a hard technical wall. This is probably the single highest-leverage question
   for the design panel: **does linkedin-relay need a headless-browser layer under it, unlike x-relay's pure
   HTTP client?**
3. **`tomquirk/linkedin-api`'s GitHub repo 404s** as of this research (2026-08-01) while its PyPI package
   (2.3.1, Nov 2024) is still installable. Unresolved: account suspension, rename, takedown, or something
   unrelated. Worth a direct check before leaning on it as a "living" upstream reference — it may already be
   dead as an actively maintained project even though its last snapshot is the best primary source we have.
4. **`li_at` cookie lifetime, and which of `li_rm`/`bcookie`/`bscookie` are load-bearing vs. cargo-culted.**
   No source in this pass resolves this with confidence; every practitioner treats "send whatever's in the
   browser's cookie jar" as the safe default rather than isolating the minimal required set.
5. **Modern anti-bot headers** (`x-li-track`, `x-li-page-instance`, device-fingerprint headers, TLS/JA3
   fingerprint relevance) — the one primary source we read has `x-li-track` *commented out*, suggesting it may
   not be strictly required, but this cannot be confirmed without a live network capture, which this research
   was explicitly scoped to avoid.
6. **Real Voyager rate-limit thresholds and windows.** The official v2 API's 429 semantics are documented; Voyager's are not. All numbers in circulation (~900 req/hr, ~50 profile-loads/day) are SEO-blog assertions with no
   cited methodology or source traffic — do not build alerting thresholds on them without independent
   verification.
