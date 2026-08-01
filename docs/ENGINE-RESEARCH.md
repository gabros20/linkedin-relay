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

## 6. The Rest.li codec is byte-correct — ✅ verified

The web client sent `variables=(memberIdentity:ACoAA…)`. Our `encodeVariables()` produced the
identical string, and the resulting request returned 200. The codec in `src/engine/restli.ts` is
validated against real traffic, not just its own unit tests.

## 7. Still unknown

1. **queryId rotation cadence.** The single highest-value open question — kill criterion #3 turns on
   it. Re-run `scripts/observe.ts` daily for 14 days and diff. Nothing else in this document can be
   trusted long-term until this is measured.
2. **Which queryIds back search, comment threads and reactions.** Not observed here; a profile page
   does not exercise them. Run `observe.ts` against `/search/results/people/?keywords=…`, a post
   permalink, and `/feed/`.
3. **The full profile fan-out.** `voyagerIdentityDashProfiles` returns identity only. Which further
   calls assemble experience, education and skills is unobserved.
4. **`li_at` lifetime.** Unmeasured. Record the issue date and watch for the first `AUTH_FAILED`.
5. **Real throttle thresholds.** Still zero corroborated numbers. Our caps remain `guessed`.
6. **Saved items and notifications.** `voyagerIdentityDashNotificationCards` was observed 🔍 but not
   exercised; nothing resembling a saved-items endpoint has been seen at all.

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
