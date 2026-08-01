# Engine research — grounded internals

Seeded from [research/R3-linkedin-surface.md](research/R3-linkedin-surface.md) (a documentation pass
over a **November 2024** reference client) and then **corrected against live traffic on 2026-08-01**.

Provenance markers, used throughout and load-bearing: ✅ **verified** — observed on live 2026 traffic
from this machine · 🔍 **discovered** — seen in a live capture but not yet exercised by us · 🔩
**inferred** — from documentation or another client, not confirmed here. **A 🔩 endpoint may not back
a shipped command.**

---

## 1. Phase 0 gate — PASSED (2026-08-01)

The design's load-bearing assumption was that raw HTTP with the user's own session cookies still
reaches Voyager in 2026, and that no stealth browser is needed in the hot path. It holds.

| probe | result |
|---|---|
| `GET /voyager/api/me` | ✅ **200**, 2,750 bytes |
| `GET /voyager/api/identity/profiles/{id}/profileView` | ❌ **410 Gone** — see §3 |
| `GET /voyager/api/feed/updatesV2?q=chronFeed&count=5` | ✅ **200**, 117,036 bytes |
| `GET /voyager/api/graphql?queryId=voyagerIdentityDashProfiles.…` | ✅ **200**, 1,334 bytes |

No HTTP 999, no challenge, no checkpoint, no login redirect. Requests were spaced ≥15s from a
residential IP on a headful-Chrome-derived session. Kill criteria #1 (detection) and #2 (irreproducible
token) **did not fire**.

Raw bodies are in `captures/` — gitignored, since they contain live session tokens and third-party
personal data. Redact by hand before promoting anything to `tests/fixtures/`.

## 2. Auth — ✅ verified

Exactly two cookies carry the session:

```
cookie: li_at=<40+ chars>; JSESSIONID="ajax:1234567890123456789"
csrf-token: ajax:1234567890123456789      ← JSESSIONID with quotes stripped. A derivation, not a secret.
x-restli-protocol-version: 2.0.0
accept: application/vnd.linkedin.normalized+json+2.1
x-li-lang: en_US
user-agent: <the real browser's UA, read from CDP /json/version>
```

Confirmed working with **no** `x-li-track`, `x-li-page-instance`, `x-li-deviceId`, `li_rm`, `bcookie`
or `bscookie`. R3 listed those as cargo-cult candidates; this capture shows the minimal set is
genuinely two cookies plus the derived CSRF header. ✅

Other LinkedIn cookies present in the jar and **not** sent: `lang`, `bcookie`, `bscookie`, `li_gc`,
`lidc`, `li_alerts`, `__cf_bm`, `dfpfpt`, `fptctx2`, `sdui_ver`, `timezone`. Sending an unexplained
header is as likely to be a fingerprint mismatch as a fix.

**The UA is read from the live browser** (`GET http://127.0.0.1:9222/json/version`), never hardcoded.
This machine reports Chrome/150. R3 §5 has direct evidence that a stale UA raises the challenge rate,
and hardcoding is exactly how the 2024 reference client ended up shipping a Chrome 83 string.

**Pre-auth state:** visiting linkedin.com sets `JSESSIONID` *without* `li_at`. So `JSESSIONID`
presence alone does not mean logged in — `li_at` is the session. Check both.

## 3. `profileView` is dead — ✅ verified, and this supersedes the research

`GET /voyager/api/identity/profiles/{public-id|urn}/profileView` returns:

```
HTTP 410
{"data":{"status":410},"included":[]}
```

Confirmed with both a bogus id and the real `publicIdentifier`. R3 quoted the reference client's own
comment — *"still works for now, but will probably eventually have to be converted"* — and that has
now happened. **Every client in the surveyed corpus that reads profiles through `profileView` is
broken**, which is consistent with R1's finding that the lineage is unmaintained.

Note the failure shape: a **structured Voyager envelope carrying a 410**, not an HTTP-level error page.
A parser that only inspects `included[]` would read this as an empty result. This is precisely the
`data`-references-with-empty-`included` case the design classifies as `SCHEMA_DRIFT` rather than
"no data", and it is now a real, reproducible fixture rather than a hypothetical.

**Replacement** — ✅ verified working headlessly:

```
GET /voyager/api/graphql
  ?includeWebMetadata=true
  &variables=(memberIdentity:<profileId>)
  &queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a
```

This returns the profile *identity* (thin), not the full profile: the web client resolves the URN
here and then fires further queries for sections. Building the `profile` command means composing
several of the calls in §5, not one.

## 4. Response shape — ✅ verified

```jsonc
{
  "data": {
    "identityDashProfilesByMemberIdentity": {
      "*elements": ["urn:li:fsd_profile:ACoAA…"],   // ← the *-prefixed reference key
      "$type": "com.linkedin.restli.common.CollectionResponse"
    }
  },
  "included": [
    { "entityUrn": "urn:li:fsd_profile:ACoAA…",
      "versionTag": "266152776",
      "$type": "com.linkedin.voyager.dash.identity.profile.Profile" }
  ],
  "meta": { … }
}
```

Every element of the design's parser model is present: `data` holds thin references under a
`*`-prefixed key, `included[]` is the flat decorated side-table keyed by `entityUrn`, and `$type`
carries the discriminator. Index `included[]` once into a `Map`, then resolve — never the O(n·m)
substring scan the reference implementation uses.

**The namespace migration is live.** `GET /me` returns the *same member id* under two namespaces in
one response:

```
urn:li:fs_miniProfile:ACoAABkU2WkBwVjyZrBxlHL0ykQ2sXWtJATrBww
urn:li:fsd_profile:ACoAABkU2WkBwVjyZrBxlHL0ykQ2sXWtJATrBww
```

This is the `core`/`legacy` split that cost x-relay real data, in the flesh. `canonicalUrn()` already
collapses it (`src/engine/restli.ts`), and there is now a real capture to write the fixture from.

**A third response envelope also exists**: `me` and `dashProfiles` both return `{data, included}`, but
`dashProfiles` additionally carries `meta`. Do not assume a fixed key set.

## 5. Live endpoint inventory — 🔍 discovered 2026-08-01

Twenty-one distinct Voyager calls observed from a **single profile page load**
(`scripts/observe.ts /in/<public-id>/`, full URLs in `captures/observed-*.json`). This is the ground
truth for `src/engine/contracts/`.

| operation | queryId / note |
|---|---|
| `voyagerIdentityDashProfiles` | `b5c27c04968c409fc0ed3546575b9b7a` — **the profileView replacement** |
| `voyagerIdentityDashNotificationCards` | decorationId `…CardsCollectionWithInjectionsNoPills-24` |
| `voyagerFeedDashGlobalNavs` | `5e79c576bb420351fa8ff438d86b2c31` |
| `voyagerFeedDashThirdPartyIdSyncs` | `e9d3044f7ad311ff359561b405629210` |
| `voyagerDashMySettings` | `8fdc6cac2e41f88f83e8d17dc78ac26c` |
| `voyagerPremiumDashFeatureAccess` | `c87b20dac35795f9920f2a8072fd7af5` |
| `voyagerJobsDashJobSeekerPreferences` | `53d4a0b454b82ce339abf8afc2c65190` |
| `voyagerLegoDashPageContents` | `6e5607181411f5835938e105d18564e2` |
| `voyagerMessagingDashAffiliatedMailboxes` | `aef223806c4270935ab6bdebfda1695d` |
| `voyagerMessagingDashAwayStatusV2` | `ee0ba3add6f8a58c35df3e08daa87b11` |
| `voyagerMessagingDashMessagingSettings` | `a555e413ad439d1d3f58ceef31ff0728` |
| `messengerConversations` | `0d5e6781bbee71c3e51c8843c6519f48` — on `voyagerMessagingGraphQL/graphql`, a **second GraphQL base path** |
| `messengerMailboxCounts` | `fc528a5a81a76dff212a4a3d2d48e84b` |
| plain REST | `me` · `premium/featureAccess` · `voyagerGlobalAlerts` · `voyagerNotificationsDashBadgingItemCounts` · `voyagerMessagingDashConversationNudges` · `voyagerSegmentsDashChameleonConfig` · `voyagerOrganizationDashPageMailbox/` · `POST messaging/dash/presenceStatuses` |

Two things worth noting. **`voyagerMessagingGraphQL/graphql` is a distinct base path** from
`/voyager/api/graphql` — an assumption of one GraphQL endpoint would be wrong. And a single page load
issues 21 calls, which is a useful calibration: our own per-command budgets are far below what
ordinary browsing generates.

## 5a. Search — ✅ verified, and it largely retires kill criterion #3

The web UI is **fully server-rendered**: navigating to `/search/results/people/?keywords=…`,
paginating, and toggling network filters all issue full page loads and **zero** Voyager XHRs. There
is nothing to observe. That is itself worth recording — an observation-only discovery strategy would
conclude, wrongly, that search has no API.

The API path does exist, and the **November-2024 queryId still works**:

```
GET /voyager/api/graphql
  ?variables=(start:0,origin:GLOBAL_SEARCH_HEADER,query:(keywords:rust%20developer,
     flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),
     includeFiltersInResponse:false))
  &queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0
→ 200, 56 KB, data.data.searchDashClustersByAll.metadata.totalResultCount = 1,457,213
```

**`voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0` was documented in November 2024 and
still returns 200 in August 2026 — roughly 21 months unchanged.** Kill criterion #3 assumed queryIds
might rotate faster than a solo maintainer could re-capture, possibly weekly. On this evidence they
are closer to *build-pinned but long-lived*. The 14-day rotation diff is still worth running, but the
expected answer has moved a long way toward "stable".

Caveat worth keeping: this is one queryId over one interval. It does not license hardcoding. Contracts
stay in versioned data with a `capturedAt`, exactly as designed — the finding lowers the maintenance
estimate, it does not remove the need for the mechanism.

## 5b. `urn:li:activity:` ≠ `urn:li:ugcPost:` — ✅ verified

A post permalink carries an **activity** URN; its own social endpoints key off a **ugcPost** URN, and
the numbers differ:

```
permalink   /feed/update/urn:li:activity:7489213448686600193/
reactions   …&variables=(count:10,start:0,threadUrn:urn:li:ugcPost:7489213447814144000)
            &queryId=voyagerSocialDashReactions.41ebf31a9f4c4a84e35a49d5abc9010b
```

So `post` and `reactions` cannot share an identifier naively: the ugcPost URN has to be read out of
the post response, not derived from the activity id. Assuming they are interchangeable would produce
`NOT_FOUND` or, worse, another post's reactions.

Also captured — a genuine three-member composite URN, now a regression fixture in
`tests/restli.test.ts`:

```
urn:li:fsd_socialDetail:(urn:li:ugcPost:748…,urn:li:ugcPost:748…,urn:li:highlightedReply:-)
```

The reference client's `split("(")[1].split(",")[0]` returns `"urn"` for this and silently loses the
rest. Our paren-aware parser returns all three members.

**Comments were not observed.** They load on interaction, and the observed post had none. The comment
thread queryId is still unknown — the largest gap before `post` can ship.

## 5c. The feed is legacy-namespaced — ✅ verified

`feed/updatesV2?q=chronFeed` returns **`com.linkedin.voyager.feed.*`** types, not `dash`. One page:
44 `included[]` nodes across 11 distinct `$type`s, of which **5 are the actual posts**
(`com.linkedin.voyager.feed.render.UpdateV2`); the rest are supporting decorations — `SocialDetail`,
`SocialActivityCounts`, `SaveAction`, `UpdateActions`, `SocialPermissions`, `HidePostAction`,
`FollowingInfo`, `MiniProfile`, `MiniCompany`, `VideoPlayMetadata`.

This is the exclusion filter's whole justification in one response: **39 of 44 nodes are not content**.
An accept-list naming only `UpdateV2` would work until LinkedIn renames it, then silently return an
empty feed with `ok:true`. Dropping known noise and passing everything else through — counting the
unknowns into `meta.unknownTypes` — fails the safe way instead.

## 5d. Profile projections — ✅ verified, and picking the wrong one looks like success

Three `voyagerIdentityDashProfiles` queryIds appear on a single page load. They are different
**projections** of one operation, and the difference is not visible from the queryId:

| queryId | variables | result |
|---|---|---|
| `b5c27c04…` | `(memberIdentity:<id>)` | **identity only** — `entityUrn` + `versionTag`, 1.3 KB. A 200 containing nothing useful. |
| `e9b08094…` | `(memberIdentity:<id>)` | **the real profile** — headline, geo, top position, education, 37 KB across 10 nodes. ← shipped |
| `da93c92b…` | `(profileUrn:urn:li:fsd_profile:<id>)` | 400. Its true variables shape is unknown. |

We shipped `b5c27c04…` first and `lnrelay profile` returned a type and a URN — a perfectly healthy
200 with no information in it. Worth noting as a distinct failure mode from the ones this design
already guards: not drift, not an empty result, just the *wrong projection* of a working endpoint.

**None of the three returns `firstName`/`lastName`/`publicIdentifier`.** LinkedIn splits names into a
projection we have not identified, so a looked-up profile currently has no name attached. The caller
supplied the identifier, so this is a real limit rather than a silent one — recorded in
`src/engine/contracts.ts` next to the queryId.

Location, current position and education arrive as URN references into `included[]`, so the profile
node alone is mostly pointers — `shapeProfile()` takes the index and dereferences them.

## 5e. Promoted posts wear the same `$type` as real ones — ✅ verified

An advertisement reached `lnrelay feed` output while every type-level filter passed, because a
promoted post is a `com.linkedin.voyager.feed.render.UpdateV2` exactly like an organic one. The only
marker is in the actor's subdescription:

```
actor.subDescription.text = "Promoted by MailerLite"
```

The general lesson, and the reason it is worth a section: **type is not the only place an entity
identifies itself.** The exclusion filter was built to survive renames of the type field, and it
does — but an entity can also be noise for reasons the type never expresses. Ads are now dropped on
that marker and counted in `excludedCount`, so the exclusion stays visible rather than silent.

## 6. The Rest.li codec is byte-correct — ✅ verified

The web client sent `variables=(memberIdentity:ACoAA…)`. Our `encodeVariables()` produced the
identical string, and the resulting request returned 200. The codec in `src/engine/restli.ts` is
validated against real traffic, not just its own unit tests.

**Exercising it against live search also found a real bug in it.** The codec escaped the five
characters that matter to the Rest.li *grammar* (`( ) , : |`) but not the ones that matter to the
*URL* the tuple is spliced into. A search for `tom & jerry` would have injected a second query
parameter — and LinkedIn would have answered with 200 and plausible results for a query we never
asked. Silent, and exactly the class of failure this project keeps finding.

Now escaped: `% ( ) , : | & # +` and space, with `%` handled first in a single pass so an escape is
never re-escaped. Re-verified live afterwards: same endpoint, 200, 1,457,213 results.

## 7. Still unknown

1. **The comment-thread queryId.** Now the largest gap, and the one blocking `post` — the headline
   research command. Comments load on interaction; observe a post that actually has some, with an
   in-page action that expands them.
2. **The full profile fan-out.** `voyagerIdentityDashProfiles` returns identity only, and three
   distinct queryIds for that operation were observed (`b5c27c04…`, `e9b08094…`, `da93c92b…`) —
   evidently different projections. Which calls assemble experience, education and skills is
   unobserved.
3. **queryId rotation cadence.** Substantially de-risked by §5a (a 21-month-old queryId still works),
   but not measured. Run the 14-day `observe.ts` diff to confirm.
4. **`li_at` lifetime.** Unmeasured. Record the issue date and watch for the first `AUTH_FAILED`.
5. **Real throttle thresholds.** Still zero corroborated numbers. Our caps remain `guessed`, and
   nothing in this session's traffic tested them — roughly 8 API calls were made in total.
6. **Saved items and notifications.** `voyagerIdentityDashNotificationCards` was observed 🔍 but not
   exercised; nothing resembling a saved-items endpoint has been seen at all.

### Method note: observation alone is not enough

Search would have been marked "no API" if we had trusted `observe.ts` and stopped. It is server-
rendered, so nothing fires. It took a direct probe of a queryId from the *documentation* to establish
that the endpoint exists and works. Conversely, `profileView` was documented as working and is
**410 Gone**. Neither source is sufficient alone: **observe to discover, probe to verify, and trust
only what returned 200 on this machine.**

## 8. Method notes

`scripts/capture.ts` mints cookies over CDP and issues paced probes. `scripts/observe.ts` records
what the real web client requests during an ordinary page load — no request is issued that the
browser would not have made anyway, which is why it is the cheapest way to discover a rotating
contract. Both are development tools and are not part of the shipped CLI.

Launch the debug browser detached, or the shell blocks and takes Chrome down with it when it times
out:

```bash
nohup /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.lnrelay/chrome" \
  --no-first-run --no-default-browser-check https://www.linkedin.com/feed/ >/dev/null 2>&1 & disown
```
