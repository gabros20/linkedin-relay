# linkedin-relay design proposal — GROK (grok-4.5)

**Panelist:** GROK · **Date:** 2026-08-01  
**Stance:** Build it as a true relay sibling — HTTP-first reads, narrow confirmed writes, own-session only, fail loud. Do not copy the browser-MCP majority. Ship research value before account-management ambition.

---

## 0. Interpretation of the brief (explicit)

I interpret “best possible personal, single-account, agent-driven deep-research and account-management tool” as:

1. **Research is primary.** Search, profile, post/thread, company, feed, notifications, and a local cache of *the user’s own graph and content* are the product.
2. **Account management is secondary and smaller than CONTEXT.md suggests.** Writes that double as research affordances (react, comment, post, follow) may ship; **connect/message automation is deferred** until the engine and pacing model are proven on reads.
3. **“Family shape” is non-negotiable** (R5 MUST checklist). LinkedIn hostility does not license abandoning network quarantine, exclusion-list parsers, loud feature-drift, or CLI-only writes.
4. **ToS breach is accepted and documented**, not redesigned away (R4 §8.2 items 2/13; hard constraints). Survival strategy is economics and posture (own-session, no lake, no farm), not legal cleverness.

---

## 1. Scope and command surface

**Naming (R5 §8):** repo `linkedin-relay`, CLI `lnrelay`, npm package/bin `linkedin-relay-mcp`, cache `~/.lnrelay` (`LNRELAY_CACHE_DIR`). Verify npm free before first publish.

### 1.1 Command registry (decision table)

| Command | Args (core) | Mode | MCP? | Cost hint | Why it exists |
|---|---|---|---|---|---|
| `doctor` | `[--offline]` | read | yes | free | Family MUST; setup when everything else is broken (R5 §8). |
| `me` | — | read | yes | cheap | Bootstrap identity / URN; smoke auth. |
| `search` | `<query> [--type people\|companies\|jobs\|posts] [--network F\|S\|O] [--limit N] [--compact] [--fields …]` | read | yes | cheap–mid | Primary research funnel entry (CONTEXT + R3 §3). |
| `profile` | `<publicId\|urn\|url> [--section experience\|…\|all] [--compact]` | read | yes | mid | Core research unit. |
| `company` | `<universalName\|url> [--updates]` | read | yes | mid | Company research. |
| `job` | `<id\|url>` | read | yes | cheap | Job detail when search surfaces one. |
| `post` | `<activityUrn\|url>` | read | yes | cheap | Single update + engagement counts. |
| `thread` | `<activityUrn\|url> [--limit N] [--sort relevance\|recent]` | read | yes | expensive | Full comment read with pagination + claimed/returned/truncated (R5 scar #1). |
| `reactions` | `<threadUrn> [--type LIKE\|…] [--limit N]` | read | yes | mid | Who engaged — research finalist step. |
| `feed` | `[--limit N] [--compact]` | read | yes | mid | Own chron feed (R3: `feed/updatesV2?q=chronFeed`). |
| `notifications` | `[--limit N]` | read | yes* | mid | *Ship only after live capture* — R3 marks unverified. |
| `inbox` | `[--limit N]` | read | no | mid | List conversations — **CLI-only** (PII-dense; not agent-default). |
| `conversation` | `<id> [--limit N]` | read | no | mid | Message thread read — CLI-only. |
| `connections` | `[--sync] [--query …] [--limit N]` | cache+read | yes | mid | Local graph + offline filter. |
| `posts` | `[--sync] [--query …]` | cache+read | yes | mid | Own authored posts cache (plural = cache, R5 naming lesson). |
| `saved` | `[--sync] [--query …]` | cache+read | yes | mid | Saved items if endpoint found in phase-1 capture; else stub with loud `NOT_IMPLEMENTED`. |
| `batch` | `--file queries.txt --out archive.json [--delay-ms N]` | read | yes† | expensive | Serialized multi-query archive; flush per query (R5 scar #2). †`out` required over MCP. |
| `archive` | `--out path` (from live command) | read | yes† | — | Persist result to disk. |
| `react` | `<urn> --type … --confirm` | write | **no** | 1 write | Confirmed engagement. |
| `comment` | `<urn> --text … --confirm` | write | **no** | 1 write | Confirmed comment. |
| `post-create` | `--text … [--url …] --confirm` | write | **no** | 1 write | Named to avoid `post` read collision (R5 singular/plural scar). |
| `follow` / `unfollow` | `<urn> --confirm` | write | **no** | 1 write | Reversible pair. |
| `connect` | `<profile> [--note …] --confirm` | write | **no** | 1 write | **Phase 3+ only**; daily budget hard-capped. |
| `message` | `<conversation\|profile> --text … --confirm` | write | **no** | 1 write | **Phase 3+ only**. |
| `purge` | `[--all\|--third-party\|--older-than Nd] --confirm` | local | no | free | GDPR retention kill-switch (R4 §4, hard constraints). |
| `risk` | — | local | yes | free | Prints current session risk state + ToS breach notice (see §5). |

Envelope: R5 MUST — `{ok,command,data}` / `{ok:false,command,error:{code,message,hint?,status?,retryAfterMs?}}`; exit 0/1/2; stdout JSON-only.

### 1.2 Explicitly left out (and why)

| Omitted | Why |
|---|---|
| Nested comment replies | Industry-wide unsolved (R1 mguttmann BACKLOG); do not ship a lying `thread` subtree. |
| Sales Navigator / Recruiter surfaces | Different product, higher ban/litigation gravity; not own free-session research. |
| Multi-account, proxy rotation, headless farms | Hard constraints (R4 §6–hard list); R2 cloud fingerprint-sharing hypothesis. |
| Mass public-profile harvest / export-for-CRM | Proxycurl/hiQ/ProAPIs fact patterns (R4 §1–2). |
| Auto-accept invitations, bulk react/comment loops | Professional Community Policies artificial engagement (R4 §2). |
| Invitation withdraw as v1 | Edge write; wait until connect exists. |
| Full SDUI profile-edit surface | mguttmann: writes may need non-headless Chrome (R1); not research-critical. |
| Browser-DOM scraping path as primary engine | Wrong family DNA; see §2 and **Where I dissent**. |

---

## 2. The engine

### 2.1 Architecture decision: HTTP-first Voyager, not Patchright-in-the-hot-path

**Decision:** `src/engine/` is a pure HTTP client over `https://www.linkedin.com/voyager/api` (and GraphQL sibling), authenticated with user cookies. Browser is used **only** for cookie bootstrap (and optionally a future write fallback), never for reads.

**Grounding:**
- R3 §1: `li_at` + `JSESSIONID` → `csrf-token` (unquoted JSESSIONID) is verified in tomquirk 2.3.1 and mguttmann.
- R1 mguttmann: after fresh cookies, “Browser fingerprint plays NO role” for reads (owner-run, single-account — treat as **hypothesis**, not law).
- R1 stickerdaniel (2,976★): bugs cluster on **UI-state ambiguity** (#573 double-message, #629 Follow vs Accept), not detection — that is the failure mode of DOM automation, not a reason to adopt it.
- R5 MUST: network quarantine + unit-testable pure modules. A Patchright hot path destroys that.

**Falsifier (phase 1 kill/re-scope test):** With residential IP, current Chrome UA, fresh `li_at`+`JSESSIONID` from CDP, ≥20 paced reads of `/me`, profileView, search, feed — if we see systematic HTTP 999 / CHALLENGE / empty-with-challenge bodies that a same-session real browser does **not** see, abandon pure-HTTP and re-scope to browser-backed reads.

### 2.2 Auth

```
Bootstrap (once / on AUTH_FAILED):
  1. Prefer env LNRELAY_COOKIES or ~/.lnrelay/cookies.json
  2. Else `lnrelay login` → Chrome+CDP (mguttmann pattern): open /feed/ so JSESSIONID is set,
     Network.getAllCookies → persist. NEVER print cookie values (doctor: presence+length only).

Every request headers (minimum verified set — R3 §1, R1 §steal#5):
  cookie: li_at=…; JSESSIONID=…
  csrf-token: <JSESSIONID strip quotes>
  x-restli-protocol-version: 2.0.0
  accept: application/vnd.linkedin.normalized+json+2.1  (mguttmann docs)
  user-agent: CURRENT desktop Chrome (not Chrome 83 — R3: UA staleness → CHALLENGE)
  x-li-lang: en_US
```

Cargo-cult candidates (`x-li-track`, `x-li-page-instance`, `bcookie`/`bscookie`, `li_rm`) — **do not invent**. Capture live browser traffic in phase 1; add only headers present on successful browser Voyager calls. R3: `x-li-track` was commented out in 2.3.1.

**Session validity:** treat 401/403 as terminal `AUTH_FAILED` (no retry). Cookie expiry without round-trip is insufficient (mguttmann’s 302 loop was expired cookies mistaken for bot detection).

### 2.3 Transport and contract drift

Module layout (R5 §1 port):

```
engine/
  auth.ts          cookie → headers
  ops.ts           queryIds, decorationIds, feature blobs — EXTERNALIZED, never inline
  client.ts        classify → retry state machine
  parse.ts         included[] resolution, exclusion filters
  encode.ts        Rest.li variables grammar (objects, List(), | )
  index.ts         Engine interface + createEngine()
```

**client.ts policy (stricter than x-relay on challenges):**

| Signal | Action |
|---|---|
| 200 + well-formed body | success |
| 200 + known empty-drift signature (TBD from capture) | `FEATURE_DRIFT` loud — never empty success |
| 401/403 | `AUTH_FAILED`, no retry |
| 429 | surface `RATE_LIMITED` + `retryAfterMs` if parseable; **at most 1** polite sleep-retry on pure 429 with header; then terminal |
| HTTP 999 | `BLOCKED` terminal — **zero retry** (R3: pre-auth network deny) |
| Body/HTML challenge / checkpoint / captcha markers | `CHALLENGE` terminal — **zero retry** (R4 hard constraint; R1 jjuanrivvera: no auto-retry on soft-block) |
| 404 | endpoint-specific: may mean stale decorationId/queryId → `FEATURE_DRIFT` after 1 regenerate attempt if we have a refresh path; else `NOT_FOUND` |
| network error | `FETCH_FAILED`, no retry loop |

Rotating `queryId` / `decorationId` live in `ops.ts`. Rejected-config → distinct `FEATURE_DRIFT` with hint: “re-capture ops from logged-in browser; see docs/ENGINE-RESEARCH.md”. Provenance tags on every op: ✅ verified / 🔍 discovered / 🔩 inferred (steal from R1 mguttmann STATUS-MATRIX).

### 2.4 What we can build now vs must discover first

| Build now (documented facts) | Discover empirically before engine code freezes |
|---|---|
| Cookie/CSRF header model (R3 verified) | 2026 queryId hashes + variable shapes (R3 unknown #1) |
| Envelope, registry, pure parse tests against **captured fixtures** | Whether minimal cookie set is 2 cookies or full jar (#4) |
| Rest.li encode/decode unit tests | Modern headers beyond the verified set (#5) |
| Exclusion-list parser structure | Real 429/999 body shapes and challenge markers |
| Pacing/budget skeleton with configurable numbers | Whether pure HTTP still works mid-2026 (#2) — **phase-1 gate** |
| | Saved-items + notifications paths (R3 unverified) |
| | Nested-reply binding (defer indefinitely) |

**Write transport fork (opinionated):** Prefer official OAuth **`w_member_social`** for *self-originated* post/comment/react when the user opts in (`lnrelay auth-oauth`), because R3 §6 shows that slice is the only self-serve legitimate write path. Voyager remains for all reads and for connect/follow/message. One account, two credentials is fine; document clearly. If OAuth app setup is too heavy for v1 users, ship Voyager writes first but keep the interface so OAuth can replace the react/comment/post-create runners without CLI churn.

---

## 3. The parser

LinkedIn’s analogue of X’s `instructions[]→entries[]` is:

```
{ data: { "*elements"?: Urn[], … }, included: Entity[] }
Entity ≈ { entityUrn, $type | _type, …fields, nested URN refs }
```

### 3.1 Normalization pipeline

1. **`indexIncluded(included)`** → `Map<entityUrn, Entity>` in one pass. Never O(n·m) linear zip (R3 §4 critiques tomquirk helpers).
2. **Order from `data`**, content from map. Feed: walk `data["*elements"]` (or GraphQL equivalent) for order; resolve each URN; drop unresolved with a per-item warning, not page abort.
3. **URN normalize:** strip composite/tuple wrappers (`urn:li:fs_updateV2:(inner,…)` → inner) with a real small parser, not only `split("(")[1]` — but accept legacy hand forms in tests from live captures.
4. **Namespace dual-read:** `fs_miniProfile` / `fsd_profile` / `fs_profile` are the legacy/hoist problem (R3 §4). Field accessors: `dashField ?? legacyField` everywhere (R5 dual-shape rule).
5. **Filter by EXCLUSION, never accept-list** (R5 §6b, commit `5827398` — apply undiluted):

```ts
// Pseudocode — drop known chrome; KEEP unrecognized $types
const DROP_TYPE_SUFFIXES = [
  /* promoted / ads / PYMK / cursor scaffolding — filled from live fixtures */
];
const DROP_URN_PREFIXES = [/* … */];

function keepEntity(e: Entity): boolean {
  if (isKnownNoise(e)) return false;
  return true; // unknown $type → include + flag unrecognizedType
}
```

**Concrete application of the x-relay scar:** If we accept-list only `com.linkedin.voyager.dash.feed.Update` and LinkedIn renames to a new feed component type, we get `ok:true`, plausible count, empty posts — silent death of the product. Exclusion + `unrecognizedTypes[]` on the envelope makes junk visible.

6. **Per-item try/catch** — one bad included node never kills the page.
7. **Claimed vs returned** on `thread`, `connections`, `reactions`, `feed`:

```ts
{
  items, returnedCount, claimedCount?, truncated, nextCursor?,
  warning?: "CLAIMED_BUT_EMPTY" // claimed>0 && returned===0 → failed fetch, not "no comments"
}
```

MCP tool descriptions must restate this (R5 §4). Nested replies: parse top-level only; document `nestedReplies: "unsupported"`.

8. **Development counting invariant:** every new fixture asserts `parsedContentBearing >= rawContentBearing - knownNoise` (R5 scar #4 lesson).

---

## 4. Local cache and incremental sync

**Layout:** `~/.lnrelay/{connections,posts,saved,meta}.json` — load-never-throws, atomic write via tmp+rename (R5 §5).

### 4.1 What is cached (GDPR + litigation posture)

| Source | Cached? | Rationale |
|---|---|---|
| User’s own posts | yes | Owner data; research history |
| Direct connections (1st-degree graph the user already has) | yes | Own network, not harvested strangers |
| Explicitly saved/bookmarked items | yes | User intent signal |
| Profiles touched only by `search`/`profile` | **no by default** | Avoid multi-subject lake (R4 hard constraint #2,#8). Optional `--pin` writes a single entity into a pin store with TTL |
| Feed/search result dumps | only via explicit `archive`/`batch --out` | Ephemeral research artifacts, not silent accumulation |

**Retention:** third-party entities in pin/archive default TTL **30 days**; `purge --third-party` / `--older-than` / `--all --confirm`. Own posts and connection **ids** retained until user purges (connections are the user’s graph, still third-party PII — allow `purge --connections` separately). Document legitimate-interest LIA in `docs/RISK.md` (R4 §4).

### 4.2 Watermarks without snowflakes

LinkedIn activity ids are **not** X snowflakes. Do not pretend they are.

| Source | Ordering assumption | Freshness key | Sync strategy |
|---|---|---|---|
| Own posts | Newest-first if API returns chron (verify in capture) | **`createdAt` timestamp watermark** (ISO, compare parsed ms) — R5 already abstracts `isHigherId` toward timestamp fallback | Fetch newest-first; stop when page is entirely ≤ watermark; `--full`/`--repair` rewrite |
| Saved items | Same if chron | timestamp watermark | same |
| Connections | **Not reliably monotonic by id** | **Wall-clock `syncedAt` + set-diff on `entityUrn`** | Periodic full page walk under budget (not O(new) watermark). Store `Record<urn, Connection>`; on sync, merge adds, mark missing as `edgeGoneAt` after N consecutive absences — do **not** force a false id-watermark |
| Feed | ephemeral | no durable watermark | live only + optional archive |

**Mutable metrics:** refresh engagement on re-sync of the head window; freeze body (R5 §5 explicit policy).

**Falsifier:** If own-posts API is not newest-first, drop watermark and use full resync under cap — state so in code comments, do not silently compare unordered ids.

---

## 5. Safety architecture (constraints in control flow, not README)

### 5.1 Type-level / structural gates

```ts
type WriteCommand = 'react' | 'comment' | 'post-create' | 'follow' | 'unfollow' | 'connect' | 'message';
// MCP registration list is a ReadonlyArray of read-only command names — writes cannot be registered (compile-time + test).
// runWrite(cmd, args): requires args.confirm === true; else return err(CONFIRMATION_REQUIRED) BEFORE getEngine().
```

- **Single session:** `Engine` holds one `CookieJar`; no API for swapping accounts mid-process; multi-account env vars rejected at startup with `INVALID_INPUT`.
- **No autonomous bulk writes:** no `batch` mode for writes; connect/message are single-target only.
- **Pacing middleware** wraps every `client.fetch`:

```ts
// Defaults — configurable, not sacred (R2: no corroborated numeric envelope)
minGapMs: jitter(3000, 15000)   // steal R1 jjuanrivvera 3–15s
maxInFlight: 1
dailyBudgets: {
  profile: 40,    // conservative vs SEO lore ~50; configurable
  search: 80,
  feed: 100,
  writeConnect: 15,  // under ~20/day lore (R2); not gospel
  writeMessage: 20,
  writeReact: 40,
}
// On budget exhaust → BUDGET_EXCEEDED local error, no network.
```

R2 finding that **read velocity alone** triggers restriction (tekbog et al.) → budgets apply to **reads and writes**. Numbers are **starting knobs**, not LinkedIn facts — document as such.

### 5.2 Loud failure, no challenge hammer

`CHALLENGE` / `BLOCKED` / repeated `RATE_LIMITED` set a durable `~/.lnrelay/risk-state.json`:

```json
{ "state": "restricted", "since": "…", "lastSignal": "CHALLENGE", "clearRequires": "human" }
```

While `state !== ok`, **all network commands refuse** except `doctor` and `risk`, until `lnrelay risk --clear-ack` (human acknowledges they fixed login/challenge in a real browser). This encodes “don’t retry-hammer” structurally.

### 5.3 Risk legibility at the moment of risk

- First network command of a day / first write ever: stderr banner + `data.riskNotice` in envelope (still one JSON object; notice inside `data` or top-level allowed field `notice`) citing User Agreement §8.2 breach (R4 hard constraint).
- `lnrelay risk` always available; MCP exposes `risk` as read tool so agents see state before spending budget.
- Write `--confirm` help text names permanent professional-identity loss (R4 §3 asymmetry vs X).

### 5.4 Cache purge

`purge` is a first-class command, tested, not a footnote. Default install docs lead with retention.

---

## 6. MCP surface and skill

**MCP:** read-only subset: `doctor`, `risk`, `me`, `search`, `profile`, `company`, `job`, `post`, `thread`, `reactions`, `feed`, `connections`, `posts`, `saved`, `batch` (out required), `notifications` when implemented. **No** inbox/conversation by default (message PII — CLI for human). **No writes.**

**Defaults:** `compact=true` on list tools; CLI defaults full. Lazy shared Engine (R5 §4).

**Tool description pattern** (mandatory for `thread`, `profile`, `feed`):

> Always check `returnedCount` / `claimedCount` / `truncated` / `warning`. `warning: CLAIMED_BUT_EMPTY` means **failed fetch**, not empty content. Empty `items` with `ok:true` and no warning means genuine empty. `error.code === AUTH_FAILED|CHALLENGE|RATE_LIMITED|FEATURE_DRIFT` are hard stops — do not re-call in a loop.

Skill: hand-written `.claude/skills/linkedin-relay/SKILL.md` + `scripts/generate-skill.ts` bake-in; snapshot test vs disk (R5 §2). Funnel prose: wide `search` → rank offline → deep `profile`/`thread` on 2–3 finalists only (github-relay cost discipline).

---

## 7. Build order

| Phase | Deliverable | Done means |
|---|---|---|
| **0 — Capture** | Live logged-in HAR/fixtures for `/me`, profileView, search people, feed, comments, reactions; cookie bootstrap script | Fixtures in `tests/fixtures/`; ops.ts stubs filled with ✅ hashes from *this* capture |
| **1 — Engine gate** | HTTP client + doctor + me + profile; pacing + CHALLENGE/999/429 handling; **pure-HTTP viability experiment** | 20 paced reads succeed on operator account; or documented failure → browser re-scope |
| **2 — Research core** | search, company, job, post, thread, reactions, feed; exclusion parser + claimed/returned; MCP read subset; skill | Agent can research a person/company end-to-end offline-testable |
| **3 — Cache** | connections + own posts sync (timestamp / set-diff); purge; offline query | Incremental own-posts sync O(new); connections full sync under budget |
| **4 — Narrow writes** | react, comment, post-create, follow with `--confirm`; optional OAuth path | One confirmed write works; MCP still write-free |
| **5 — Deferred** | connect, message, saved, notifications, inbox | Only if phase 1–4 stable and risk-state stays clean for weeks |

**Riskiest assumption:** pure HTTP Voyager with cookie auth remains viable for personal residential use in 2026 without mandatory stealth-Chromium (R3 unknown #2; R1 market tip toward Patchright).

**Cheapest test:** Phase 1 — one afternoon, one real account, residential IP, CDP cookies, 20 reads. If it fails systematically, stop and redesign engine; do not build 15 commands on a dead transport.

**Family scaffolding** (parallel, pure): registry, envelope, entry.ts port, generate-skill, biome/tsup/semantic-release — from day 0, independent of LinkedIn viability.

---

## 8. Kill criteria

Abandon or radically rescope if any of these are observed:

1. **Transport death:** Pure HTTP + full browser-cookie jar still 999/CHALLENGE on residential IP while interactive browser works → either (a) rescope to Patchright engine (no longer thin relay; re-evaluate) or (b) abandon.
2. **queryId churn unmaintainable:** hashes rotate faster than a solo maintainer can re-capture (e.g. multiple forced breaks per week with no stable scrape path from web bundle) → abandon or freeze as “fixtures-only offline demo.”
3. **Account harm at research volumes:** temporary restriction from phase-2 read-only use at ≤ human browsing budgets → **stop**; product is net-negative vs manual LinkedIn (R4 identity asymmetry).
4. **Legal escalation pattern change:** verified LinkedIn suits/C&Ds against non-reselling personal own-session tools → abandon; our litigation thesis was ROI-based (R4 §2).
5. **Official self-serve read API appears** for individuals → pivot to OAuth-only; Voyager path becomes legacy.
6. **Nested-everything / SDUI-only future:** if Voyager read endpoints for profile/search die and only opaque browser SDUI remains without stable HTTP → product collapses to browser-scraper; that is a different project — kill the relay framing.

A **legitimate full-negative answer** I reject *today*: the premise is not unsound. Unipile-class own-session tools still stand (R4 §5); mguttmann shows browserless reads on 2026-07; no verified personal-tool suit (R4 §2). The premise is **fragile and high-blast-radius**, which is why kill criteria are sharp and phase 1 is an experiment, not a roadmap ceremony.

---

## Where I dissent

1. **Against CONTEXT’s full write surface as co-equal product.** Connect + message are how ban stories and ToS §8.2 item 13 cluster (R2, R4). Shipping them in the same breath as `search`/`thread` invites agents (and humans) to treat linkedin-relay as Expandi-class outreach. Research-first is the correct product; writes are a thin confirmed layer later.

2. **Against following stickerdaniel’s browser-primary architecture** despite it being the market winner. Stars track “what agents can demo,” not “what matches relay DNA or survives DOM churn.” Their open issues are the future maintenance cost. HTTP-first with a falsifiable phase-1 gate is the honest engineering bet; browser is a contingency, not the brand.

3. **Against forcing x-relay’s id-watermark onto connections.** R5 already says to confront non-monotonic platforms. Connections need set-diff + wall-clock sync. Pretending URN strings are snowflakes would create silent incompleteness of the same class as accept-list filtering.

4. **Against caching every viewed profile “for offline research.”** That recreates a personal Proxycurl on disk. Pins + short TTL + purge are the design; convenience loses to R4 hard constraints and GDPR balancing (EDPB 03/2026 weights anti-scraping ToS against legitimate interest).

5. **Against encoding R2/SEO rate numbers as truth.** The corpus is explicit it has no hard ceilings for most actions. Budgets must be labeled `heuristic` in code and docs; the real safety is fail-loud + risk-state lockout, not a magic 20.

6. **Against hybrid-OAuth being a distraction.** R3’s fork (OAuth writes / Voyager reads) is the one legitimacy wedge that actually exists for individuals. Ignoring it to copy x-relay’s pure-cookie purity on *writes* leaves free correctness on the table for the only actions that also have an official path.

7. **Mild dissent on family “batch for everything.”** Batch is essential for multi-query research archives, but default agent guidance should discourage large people-search sweeps — volume itself drew suits even without resale (R4). Skill must teach *narrow finalist deep-read*, not “scrape my TAM.”

---

## Falsifiable assumptions (summary)

| Assumption | Disproof observation |
|---|---|
| Pure HTTP Voyager works for personal residential reads | Systematic 999/CHALLENGE with fresh cookies while browser works |
| `li_at`+`JSESSIONID` (+ captured companions) suffice | Calls fail until extra cookies/headers from live jar are added |
| Timestamp watermark works for own posts | API order is not recency-monotonic |
| Read budgets ~human browsing avoid restriction | Restriction after phase-2 use inside budgets |
| Exclusion-list parser stays correct under drift | Fixtures show content-bearing types dropped or silent empty |
| Own-session non-resale avoids LinkedIn litigation interest | C&D/suit against comparable personal tools |
| OAuth `w_member_social` can replace Voyager for self writes | Scope unusable or blocked for personal apps in practice |

---

## Family checklist commitment

All R5 summary checkboxes accepted, with documented deviations only for: (1) connections sync = set-diff not id-watermark; (2) optional OAuth write path; (3) write command set smaller than CONTEXT; (4) challenge/999 → hard session lockout stricter than x-relay’s 429 retry culture.

**Bottom line:** Build `lnrelay` as x-relay’s disciplined sibling on a meaner host: discover traffic first, prove HTTP in phase 1, ship agent research with exclusion-safe parsers and claimed/returned honesty, cache only what the user already owns or pins, write almost nothing without `--confirm`, and keep a kill switch in the design so a bad world-state ends the project before it ends the user’s career identity.
