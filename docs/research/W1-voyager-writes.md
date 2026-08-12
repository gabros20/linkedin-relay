# W1 — Voyager write endpoints: post, comment, react, delete

Researched 2026-08-12 via `ghrelay` (GitHub code/repo search) + WebSearch. **No live capture was
made in this pass** — everything below is `repo` or `doc/blog` evidence unless marked otherwise. This
supersedes nothing in `ENGINE-RESEARCH.md` (which is our own ✅ verified read-side traffic); treat
this doc as the write-side hypothesis to verify the same way §1 verified reads.

## Verdict

**Likely yes, with one real caveat.** Four independent, actively-maintained (2025–2026) OSS clients
converge on the *identical* request shape for creating a post via raw HTTP against
`/voyager/api/contentcreation/normShares`, using only the two cookies (`li_at`, `JSESSIONID`) this
project already holds, plus a small, static header set — no client-generated fingerprint token, no
device-attestation blob, and no CAPTCHA/challenge-solving step appears anywhere in any of the four
independent implementations. One of the four (`markrussinovich/Polypost`) has a script that
specifically drives a live-authenticated browser tab to fire the raw `DELETE` against
`normShares/{urn}` and asserts on a real `204` — that is the strongest single piece of evidence in
this pass, though it's still `repo` evidence (I did not run it myself).

The caveat: **that same author's shipped product does *not* use the raw API to create posts** — the
Polypost LinkedIn extension drives LinkedIn's own native composer UI (synthetic clicks on "Start a
post" / the real Post button) rather than POSTing JSON to `normShares` directly, even though a raw
POST would work mechanically. That's a data point about risk tolerance, not a technical blocker — the
other three post-creation implementations (`sigcli/sigcli`, `CRAKZOR/linkedin-post-automator`,
`bcharleson/linkedincli`) all do call `normShares` directly and none of their READMEs/issues mention
it being blocked. Read this as: *raw-HTTP writes mechanically work; whether they're worth the
account-risk for a shipped product is a separate, judgment call some authors made differently.*

Comments and reactions are less certain — see §2/§3, both have an unresolved discrepancy against our
own read-side findings that needs live verification before `linkedin-relay` ships them.

---

## 1. Create a post (share)

**Endpoint**: `POST /voyager/api/contentcreation/normShares` — still this path, not a GraphQL
mutation and not under a `dash` namespace, as of the most recent evidence (2026-08-10 push).

**Evidence**, all independently converging on the same body shape:

| repo | last push | evidence |
|---|---|---|
| [`sigcli/sigcli`](https://github.com/sigcli/sigcli) `skills/linkedin/scripts/linkedin_post.py` | 2026-08-10 | `repo` |
| [`bcharleson/linkedincli`](https://github.com/bcharleson/linkedincli) `src/commands/posts/create.ts` | 2026-03-16 | `repo` |
| [`CRAKZOR/linkedin-post-automator`](https://github.com/CRAKZOR/linkedin-post-automator) `core/linkedin.py` | 2025-04-13 | `repo` |
| [`ZhixiangLuo/10xProductivity`](https://github.com/ZhixiangLuo/10xProductivity) `tool_connections/linkedin/connection-session-cookie.md` | 2026-07-13 | `doc`, explicitly labeled "Verified: Production... post creation — 2026-03" by that author (their claim, not ours) |

**Request body** (`bcharleson/linkedincli`, `src/commands/posts/create.ts:47-58`, matches `sigcli` and
`CRAKZOR` field-for-field):

```jsonc
{
  "visibleToConnectionsOnly": false,          // true = CONNECTIONS-only visibility; false = PUBLIC
  "externalAudienceProviders": [],
  "commentaryV2": {
    "text": "post body here",
    "attributes": []                          // mention/hashtag/link rich-text spans go here, unpopulated for plain text
  },
  "origin": "FEED",
  "allowedCommentersScope": "ALL",             // ALL | CONNECTIONS_ONLY | NONE — bcharleson's own mapping
  "postState": "PUBLISHED",
  "media": []                                  // image objects: {category:"IMAGE", mediaUrn, tapTargets:[]}
}
```

`sigcli`'s script omits `postState` and `media` (its payload is the minimal text-only subset) but is
otherwise identical, which is itself a useful signal — the API tolerates a body with only
`visibleToConnectionsOnly` / `externalAudienceProviders` / `commentaryV2` / `origin` /
`allowedCommentersScope` set.

**Visibility**: boolean `visibleToConnectionsOnly`, not an enum string — `false` for public,
`true` for connections-only. No repo shows a `PUBLIC`/`CONNECTIONS` string literal anywhere in the
write path (that vocabulary only showed up in `ZhixiangLuo`'s doc as a `MemberNetworkVisibility`
constant used elsewhere, not in the `normShares` body itself — worth treating as unconfirmed for this
specific field).

**Plain text carrier**: `commentaryV2.text`, a flat string, with `attributes: []`. This is the
"v2" commentary shape — none of the four repos use a bare `commentary` string field or the older
UGC-style `com.linkedin.ugc.ShareContent` object seen in LinkedIn's *official* API docs. Reposting
with commentary (`bcharleson`'s `engage share`) uses the *same* endpoint/body plus a
`resharedUpdate: "<original share urn>"` field.

**Response**: no repo shows a raw captured response body — only test fixtures (`sigcli`'s
`test_linkedin_post.py`, which is a `responses`-mocked unit test, not live traffic) and the parsing
code around it. Two response shapes are defensively handled: a bare `{urn: "..."}` and a nested
`{value: {urn: "..."}}` (`sigcli/sigcli linkedin_post.py:17-18`). `sigcli`'s parser also reaches for
`status["*updateV2"]` to extract an activity URN and `status["toastCtaUrl"]`/`status["mainToastText"]`
for a permalink/confirmation message, which implies the *real* response envelope is richer than
either test fixture shows and carries a `data.status` object — consistent with the `{data, included}`
Voyager shape documented in `ENGINE-RESEARCH.md` §4, but **this specific field layout is unverified,
not directly observed** by us or (as far as the code shows) demonstrably by `sigcli` either — it reads
like defensive code written against inconsistent hearsay/logs rather than one clean capture.

**Edit** (`bcharleson/linkedincli` only, single source): `POST /contentcreation/normShares/{url-encoded share URN}`
with a JSON-Patch-flavored body:
```json
{"patch": {"$set": {"commentaryV2": {"text": "new text", "attributes": [], "$type": "com.linkedin.voyager.common.TextViewModel"}}}}
```
Note the `$type` discriminator appears only in the edit payload, not create — plausible given Rest.li
PATCH semantics need the type when replacing a typed field, but this is `inferred`, not stated by any
source.

**Delete**: see §4, same `normShares/{urn}` resource, `DELETE` verb.

---

## 2. Comment on a post

**Endpoint** (single source — `bcharleson/linkedincli`, `src/commands/engage/engage.ts:66-77`, pushed
2026-03-16): `POST /feed/comments?action=create`

```json
{
  "updateId": "activity:7123456789",
  "commentaryV2": {"text": "Great post!", "attributes": []}
}
```

**This conflicts with our own read-side finding.** `ENGINE-RESEARCH.md` §2 (this project's own ✅
verified capture) established that reading a post's social detail requires the three-member composite
`urn:li:fsd_socialDetail:(<postUrn>,<postUrn>,urn:li:highlightedReply:-)`, percent-encoded. The one
write-side sample found here uses a flat `"activity:{numericId}"` string under a differently-named
field (`updateId`, not `socialDetailUrn`) and never constructs that composite URN at all. Both could
be true simultaneously — Voyager's *read* and *write* surfaces are not required to share a URN
grammar, and `updateId: "activity:<id>"` is a plausible legacy-REST-action convention distinct from
the newer `fsd_socialDetail` GraphQL-side identifier — but **this is unconfirmed** from a single
repo, and it's exactly the kind of detail a wrong guess breaks silently on. Official LinkedIn API docs
(`learn.microsoft.com`, Community Management Comments API — a *different*, non-Voyager surface) use an
`object` field carrying a bare share/ugcPost URN, which is structurally closer to `bcharleson`'s
`updateId` than to the composite `fsd_socialDetail` triple — weak corroboration, `doc`-grade, and for
a different API surface entirely.

**No second implementation of comment-creation was found** in this pass. This is the single largest
gap in the whole write surface.

**List comments** (same repo, same file): `GET /feed/comments?count=&start=&q=comments&sortOrder=&updateId=activity:{id}` — read-only, included here only because it shares the `updateId` convention with create and is corroborating evidence for that field name being real (if wrong, both the list and create paths would presumably be wrong the same way, and READMEs claim both work).

**Percent-encoding**: not exercised in the one comment sample at all — `updateId` is a short bare
string here, not a URN needing paren-escaping the way `ENGINE-RESEARCH.md` §6 describes for the codec
bug found on `variables=(...)`. Whether an analogous escaping requirement exists for whatever URN
*does* end up needed is **unknown**.

---

## 3. React to a post (and undo)

**React** (single source — `bcharleson/linkedincli`, `src/commands/engage/engage.ts:24-30`):
`POST /voyagerSocialDashReactions?threadUrn=urn:li:activity:{id}`
```json
{"reactionType": "LIKE"}
```
Reaction type enum in this client: `LIKE | PRAISE | APPRECIATION | EMPATHY | INTEREST | ENTERTAINMENT`
(matches LinkedIn's public reaction set: Like / Celebrate / Support / Love / Insightful / Funny).

**This also conflicts with our own read-side finding**, differently than §2. `ENGINE-RESEARCH.md` §5b
(✅ verified) states reactions key off a **ugcPost** URN, not the activity URN — `threadUrn:urn:li:ugcPost:748…`
was the observed working value for the read-side GraphQL `voyagerSocialDashReactions` queryId, and the
same doc explicitly warns "`post` and `reactions` cannot share an identifier naively." The one write
sample found here uses `urn:li:activity:{id}` for the same `threadUrn` parameter name on what's
structurally the same operation name (`voyagerSocialDashReactions`) but called as a plain REST
action (`?threadUrn=...`), not the GraphQL `queryId=` form our reads use. Three explanations are all
consistent with the evidence and none can be ruled out from `repo` evidence alone: (a) the REST write
action genuinely accepts the activity URN where the GraphQL read requires the ugcPost URN, (b)
`bcharleson`'s code is simply untested/wrong (repo has `hasTests: false`, no CI), or (c) LinkedIn
accepts both URN forms for this parameter and our read-side capture just happened to be given a
ugcPost URN because that's what was on hand at capture time. **Needs a live probe with a known
ugcPost/activity URN pair before shipping** — this is not a place to guess.

**Undo (unreact)**: **not found in any source.** No repo in this pass implements removing a reaction.
By symmetry with `normShares`'s create/delete pair (same resource, `POST` to create / `DELETE` to
remove) a `DELETE` to the same `/voyagerSocialDashReactions?threadUrn=...` resource is a *plausible*
guess, but that is pure `inferred` — no implementation, doc, or blog post in this pass shows it. Mark
unknown.

**List reactions** (`bcharleson`, same file): `GET /feed/reactions?count=&q=reactionType&sortOrder=REV_CHRON&start=&threadUrn=urn:li:activity:{id}` — again uses the activity URN, for what it's worth as corroboration of the write-side choice above (same author, same convention, still only one source).

---

## 4. Delete a post

**Endpoint**: `DELETE /voyager/api/contentcreation/normShares/{url-encoded share URN}`

This is the best-evidenced write operation in this pass, with two independent implementations plus
one that looks like it was actually exercised against production:

- `bcharleson/linkedincli`, `src/commands/posts/create.ts:96-107` (`repo`) — `client.delete(...)` on the same resource path as create/edit.
- [`markrussinovich/Polypost`](https://github.com/markrussinovich/Polypost), `scripts/cdp-delete-share.mjs` (`repo`, but reads as author-executed validation, not just written-and-hoped code — see below).

The Polypost script is worth quoting because it's the most concrete evidence in this whole document.
It attaches to a real, already-authenticated LinkedIn tab over Chrome DevTools Protocol and runs this
`fetch` **from inside the page's own JS context** (so cookies/CSRF are exactly what the real browser
session has, not manually reconstructed):

```js
const del = await fetch(
  'https://www.linkedin.com/voyager/api/contentcreation/normShares/' + encodeURIComponent('urn:li:share:{shareId}'),
  {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' },
  }
);
// script exits 0 iff outcome.deleteStatus === 204, and separately re-fetches the
// public permalink afterward to confirm the post's HTML no longer contains its marker text
```

Two things this script tells us that a static read of the code wouldn't: **the only headers sent are
`csrf-token` and `x-restli-protocol-version`** — nothing else, no `x-li-track`, no device blob — and
the author built an *automated pass/fail check* around a real `204` and a real disappearance from the
public permalink, which is a materially stronger claim than "I wrote a DELETE call and assume it
works." I did not run this myself, so it stays `repo`-labeled, not `observed` — but it's the
highest-confidence `repo` claim in this document.

Companion script `scripts/cdp-validate-post-flow.mjs` in the same repo runs a full
create-then-immediately-delete cycle as part of that project's own test policy ("Publishes a real
post... then deletes it immediately via the Voyager API" — their comment, describing their own CI-ish
discipline), which is exactly the kind of "test post we can retract" workflow this project needs —
worth reading in full as a template (`scripts/cdp-validate-post-flow.mjs`,
`scripts/cdp-validate-media-post-flow.mjs`, `scripts/cdp-validate-takeover.mjs` in that repo).

**Important nuance**: Polypost's *shipped extension* does not create posts this way — see Verdict
above. Only its delete path (and its own internal test scripts) call `normShares` directly.

---

## 5. Required headers beyond auth — the load-bearing question

**Short answer: nothing found across any of the five write-capable repos surveyed requires a
client-generated fingerprint, device-attestation blob, or any value raw HTTP cannot produce.** This is
consistent with — not contradicting — `ENGINE-RESEARCH.md` §2's own ✅ verified finding for reads.

What was actually observed across sources, side by side:

| header | `markrussinovich/Polypost` (delete, in-page fetch) | `bcharleson/linkedincli` (`src/core/client.ts`) | `CRAKZOR/linkedin-post-automator` (`core/linkedin.py`) |
|---|---|---|---|
| `csrf-token` | ✅ (JSESSIONID, quotes stripped) | ✅ | ✅ |
| `x-restli-protocol-version` | ✅ `2.0.0` | ✅ `2.0.0` | not shown in the snippet read |
| `cookie` (`li_at` + `JSESSIONID`) | implicit (`credentials:'include'`, real browser tab) | ✅ explicit | ✅ explicit |
| `accept` | not set (default) | ✅ `application/vnd.linkedin.normalized+json+2.1` | ✅ same |
| `x-li-lang` | not set | ✅ `en_US` | not shown |
| `x-li-track` | not set | ✅ — a JSON blob: `{clientVersion, osName:"web", timezoneOffset, deviceFormFactor:"DESKTOP", mpName:"voyager-web"}`, entirely client-constructed from static/local values, no server round-trip or opaque token | not shown |
| `user-agent` | real browser's own | ✅ hardcoded Chrome 131 string | ✅ hardcoded Chrome 119 string |
| `origin` / `referer` | real browser's own | `origin` only, on requests with a body | ✅ both |

The one header that looks most like it could be a "fingerprint" — `x-li-track` — is, on inspection,
just a static JSON object the *client itself* constructs from values it already knows (a hardcoded
version string, the OS name, the local timezone offset, a device-class label). Nothing about it is
opaque, signed, or round-tripped from a prior server response, so even where a client sends it, it is
not evidence of a capability raw HTTP lacks — it's evidence, at most, that *some* client authors chose
to mimic more of the browser's fingerprint defensively. `CRAKZOR`'s client omits it entirely and (per
its own README) is a long-running scheduled poster, which is weak but real corroboration that it's not
required.

**One indirect counter-signal, flagged loudly per your instructions**: `ZhixiangLuo/10xProductivity`'s
doc states outright — *"All Voyager API calls are made from within a Playwright page context
(injecting the cookies), because LinkedIn's bot detection blocks raw `urllib` calls."* This is the one
piece of evidence in this pass that argues *against* pure raw-HTTP. Read carefully, though, it doesn't
show a *header* raw HTTP can't produce — it names a specific failure mode (`urllib`, Python's
default HTTP client) that's a classic TLS/JA3-fingerprint or IP-reputation tell, not a missing
capability. `ENGINE-RESEARCH.md` §1/§2 (this project's own verified capture) already found raw HTTP
reads succeed from a residential IP with a real browser's UA string, and flags exactly this class of
risk generically ("a stale UA raises the challenge rate"). The two findings aren't necessarily in
tension: `urllib`'s TLS handshake and default UA are both distinctly non-browser-shaped in ways this
project's own request layer is already built to avoid. But it's a real, named data point that a raw
Python HTTP client failed against LinkedIn for someone else, and it deserves to be re-tested here
rather than assumed away.

**Verdict on this question**: no evidence found that writes need anything raw HTTP cannot produce.
The `ZhixiangLuo` counter-signal is about transport fingerprinting (client library / TLS / IP), not
about a missing header or token — but it's real enough that the first live write attempt should be
watched closely for a challenge/999/HTML response rather than assumed clean.

---

## 6. Rate limits / thresholds for writes

**Unknown — nothing corroborated found.** The only numbers in this pass are defensive, self-imposed
client-side pacing, not measured LinkedIn thresholds:

- `bcharleson/linkedincli`: hardcoded `MIN_REQUEST_GAP_MS = 2_000` between any two requests, plus a
  2–5s randomized delay before retries ("human-like delay to avoid rate limits" — the author's own
  comment, not a measured threshold).
- `CRAKZOR/linkedin-post-automator`: posts on an hours-scale schedule (`hour_interval` +
  random offset in `config.json`), which is a posting-cadence choice, not evidence of where a real
  limit sits.

No source in this pass reports having actually hit a write-specific rate limit, a write-specific
CAPTCHA/checkpoint, or a documented number of posts/comments/reactions per hour or day. Treat this
exactly as `ENGINE-RESEARCH.md` §7 already treats read-side throttling: caps stay `guessed` until
measured on this account.

---

## What we could not determine

1. **The comment-creation URN/field contract** — genuinely unresolved, not just under-evidenced. One
   source (`bcharleson/linkedincli`) says `updateId: "activity:{id}"`; our own read-side research says
   the *related* social-detail surface needs a percent-encoded three-member `fsd_socialDetail`
   composite. Whether the write path really diverges from the read path this much, or whether the one
   sample found is simply wrong, is unknown. **Do not build `comment` from this doc alone — probe it
   live first**, the same way `ENGINE-RESEARCH.md` §5a probed search before trusting a documented
   queryId.
2. **Reaction `threadUrn` — activity URN vs. ugcPost URN for the write path.** Same shape of problem:
   one write sample uses the activity URN where our own verified read-side evidence says the *read*
   side needs the ugcPost URN for the same conceptual operation. Live-probe both before shipping.
3. **Reaction removal (unreact/unlike).** No implementation found anywhere. A symmetric `DELETE` on
   the same resource is a plausible guess and nothing more — explicitly `inferred`, not backed by any
   source.
4. **The real shape of a `normShares` create response.** Only test-mock fixtures were found, and the
   one client that parses defensively for multiple shapes (`sigcli/sigcli`) suggests even that author
   wasn't fully sure. We don't know what fields are actually present, whether an activity URN or a
   share URN comes back first, or whether a `data`/`included` envelope wraps it the way reads do.
5. **Edit-post JSON-Patch shape** — one source only (`bcharleson/linkedincli`), never cross-checked.
6. **Real write-side rate limits, CAPTCHA/checkpoint triggers, or `li_at` write-scope validity
   differences from read-scope.** No source measured any of this.
7. **Media/image upload as a write prerequisite** — two sources (`bcharleson`, `CRAKZOR`) show a
   two-step flow (`POST voyagerVideoDashMediaUploadMetadata?action=upload` → `PUT` the binary to the
   returned `singleUploadUrl` → embed the returned `urn` in `normShares.media[]`), consistent between
   both, but out of scope for this pass beyond noting it exists and looks stable.
8. **Whether `visibleToConnectionsOnly` is really the only visibility control**, or whether a
   `PUBLIC`/`CONNECTIONS` enum string appears somewhere in a response or a variant payload this pass
   didn't see — the one hit for that vocabulary was in an unrelated doc snippet, not the write body
   itself.

## Sources

- [sigcli/sigcli](https://github.com/sigcli/sigcli) — `skills/linkedin/scripts/linkedin_post.py`, `skills/linkedin/tests/test_linkedin_post.py` (pushed 2026-08-10)
- [bcharleson/linkedincli](https://github.com/bcharleson/linkedincli) — `src/commands/posts/create.ts`, `src/commands/engage/engage.ts`, `src/core/client.ts` (pushed 2026-03-16)
- [CRAKZOR/linkedin-post-automator](https://github.com/CRAKZOR/linkedin-post-automator) — `core/linkedin.py` (pushed 2025-04-13)
- [markrussinovich/Polypost](https://github.com/markrussinovich/Polypost) — `scripts/cdp-delete-share.mjs`, `scripts/cdp-validate-post-flow.mjs`, `scripts/cdp-validate-media-post-flow.mjs`, `scripts/cdp-validate-takeover.mjs`, README (pushed 2026-07-25)
- [ZhixiangLuo/10xProductivity](https://github.com/ZhixiangLuo/10xProductivity) — `tool_connections/linkedin/connection-session-cookie.md` (pushed 2026-07-13)
- [southleft/linkedin-mcp](https://github.com/southleft/linkedin-mcp) — checked, but comments/reactions in this project route through the *official* Community Management OAuth API (`w_member_social_feed` scope) plus browser automation, not raw Voyager writes — a negative data point (one active 2026 project chose not to reverse-engineer this surface) rather than positive evidence, so not cited above by claim.
- [nsandman/linkedin-api](https://github.com/nsandman/linkedin-api) — checked (tomquirk-lineage Python fork, pushed 2021-04-30); read-only (search/profile/messaging/connections), no post/comment/reaction/delete code at all — confirms this classic lineage never covered writes, cited here only as an absence.
- Microsoft Learn — [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), [Reactions API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api), [Network Update Social Actions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions) — official, OAuth-scoped API docs for a *different* (non-Voyager) surface; used only as weak structural corroboration in §2, not as a primary source.

grep.app's code-search lane was down (`SOURCE_DOWN`, circuit-breaker open) for most of this pass after
two early hits — the initial `normShares` and `contentcreation/normShares` searches succeeded and
surfaced all the repos above; later searches for `feed/comments`, `socialActions`, `reactionType`, and
`highlightedReply` as independent corroboration were blocked and had to be substituted with WebSearch,
which is weaker for finding literal code matches. **Worth re-running the blocked `code` searches once
grep.app recovers** — they were aimed exactly at closing gaps 1–3 above.
