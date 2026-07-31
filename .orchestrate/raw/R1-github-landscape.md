# R1 — GitHub landscape of LinkedIn tooling

Research date: 2026-08-01. Method: `ghrelay` (github-relay) funnel — `hydrate` on WebSearch-curated
candidates → `search` wide-net (`linkedin scraper voyager`, `linkedin api unofficial`, `linkedin mcp`,
`voyager api linkedin`) → `code` token probes (`voyager/api/identity`, `li_at`) → `enrich`/`rank`
(profile `build-on`) → `health` on 7 shortlisted finalists → `skim`/`read`/`digest` on the 4 true
finalists. Corpus: 90 deduped repos at
`/Users/tamas/Documents/Personal/Projects/linkedin-relay/.orchestrate/raw/corpus.json`. GitHub issue
trackers pulled live via `gh issue list`.

## Ranked table — 12 most relevant repos

| repo | stars | last push | lang | approach | verdict | why it matters |
|---|---|---|---|---|---|---|
| [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) | 2,976 | 2026-07-31 | Python | browser (Patchright, stealth-Playwright fork) | **ALIVE, dominant** | The de facto standard LinkedIn MCP server today; 20 open issues, daily commits, sponsored by Unipile |
| [joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper) | 4,381 | 2026-04-10 | Python | browser (Playwright, rewritten from Selenium in v3.0.0) | **ALIVE but rotting** | Most-starred LinkedIn scraper on GitHub overall, but responsiveness health subscore 0.08/1 — issues from 2024-2025 still open |
| [mguttmann/linkedin-internal-api](https://github.com/mguttmann/linkedin-internal-api) | 2 | 2026-07-31 | Python | browserless raw-HTTP (`requests`) + MCP server | **ALIVE, tiny, best-documented** | 130 reverse-engineered endpoints (Voyager + SDUI) with verified/discovered/inferred provenance — closest architectural and *ethical-documentation* sibling to x-relay |
| [jjuanrivvera/linkedin-cli](https://github.com/jjuanrivvera/linkedin-cli) | 0 | 2026-07-30 | Go | browserless raw-HTTP, read-only, cookie auth | **ALIVE, brand new** | Explicitly frames itself in "the same caveat class as `slackctl`'s `xoxc`/session auth" — someone else has already converged on the relay-family's exact risk framing |
| [Linked-API/linkedapi-mcp](https://github.com/Linked-API/linkedapi-mcp) | 63 | 2026-07-23 | TypeScript | paid cloud-browser wrapper (commercial backend) | **ALIVE, commercial** | Direct MCP competitor; "safely" runs LinkedIn through *their* cloud browser, not the user's |
| [anysiteio/anysite-mcp-server](https://github.com/anysiteio/anysite-mcp-server) | 62 | 2026-05-20 | JavaScript | paid multi-platform data wrapper (LinkedIn one of 7 sources) | **ALIVE, commercial** | Remote-MCP-with-OAuth model; LinkedIn is a commodity data source alongside X/Instagram/Reddit |
| [spinlud/py-linkedin-jobs-scraper](https://github.com/spinlud/py-linkedin-jobs-scraper) (+ [JS twin](https://github.com/spinlud/linkedin-jobs-scraper)) | 487 / 186 | 2025-03-14 | Python / TS | headless-browser, jobs-only | **going stale** | ~17 months with no commit as of this research date; narrow scope (public job listings only) |
| [nsandman/linkedin-api](https://github.com/nsandman/linkedin-api) | 183 | 2021-04-30 | Python | browserless raw-HTTP (fork of tomquirk/linkedin-api) | **DEAD** | Most-starred living descendant of the flagship raw-Voyager-REST client lineage; 5+ years stale |
| ~~tomquirk/linkedin-api~~ | historically ~1,156★/272 forks (per secondary sources; unverified directly) | — | Python | browserless raw-HTTP | **GONE** | The original, most-forked unofficial LinkedIn API client. `github.com/tomquirk/linkedin-api` returns 404 as of 2026-08-01 and does not appear in the owner's current repo list — cause unverified (rename/deletion/takedown all possible) |
| [quinnjr/linkedin-mcp](https://github.com/quinnjr/linkedin-mcp) | 59 | 2026-07-27 | TypeScript | unclear (claims "comprehensive" profile/post/connection management) | **ALIVE, mid-tier** | One of many small MCP entrants; D (responsiveness) subscore 0/1 |
| [Dishant27/linkedin-mcp-server](https://github.com/Dishant27/linkedin-mcp-server) | 50 | 2026-07-31 | TypeScript | unclear | **ALIVE, small** | Fresh commits but near-zero issue responsiveness; illustrates how crowded/undifferentiated this niche is |
| [om-ashish-soni/headless-linkedin](https://github.com/om-ashish-soni/headless-linkedin) | 1 | 2026-04-26 | TypeScript | browserless via Chrome CDP, "zero API keys, zero mutations" | **ALIVE, tiny** | Independent convergence on the same CDP-cookie-extraction pattern as mguttmann, read-only by design |

## Deep notes — 4 finalists

### 1. stickerdaniel/linkedin-mcp-server — the incumbent
- **Auth/rendering**: `patchright>=1.40.0` (a stealth/undetected-Chromium fork of Playwright) drives a
  real, persistent, logged-in browser session — confirmed in `pyproject.toml`. Not a raw-HTTP client;
  every read is a live page render + DOM extraction. `fastmcp>=3.4.4` is the MCP framework.
- **Endpoint coverage**: profiles, companies, jobs, messaging inbox/conversations, connection
  requests, sidebar recommendations, company posts/employees — the broadest surface of any repo found.
- **Detection handling**: relies entirely on Patchright's stealth patches + the user's own real browser
  session; no proxy/fingerprint-rotation logic of its own.
- **What the issue tracker says is broken right now** (20 open issues, `gh issue list`, live 2026-08-01):
  - #558 (2026-06-30): "Linux/Codex login flow is hard to recover: Google SSO blocked, empty exported
    cookies, stale client transport" — the manual-login bootstrap is fragile cross-platform.
  - #573 (2026-07-09) and #483 (2026-06-02): `send_message` can double-fire or create a new DM thread
    instead of replying to an existing one — LinkedIn's messaging UI has non-deterministic modal states.
  - #629 (2026-07-29): a "creator-mode" profile makes the client click **Follow** when it meant
    **Accept** — a DOM-selector ambiguity that only shows up for a subset of account types.
  - #533 (2026-06-21): Patchright's browser download silently stalls with no progress indicator.
  - #590 (2026-07-22): skills section is hard-truncated to ~10 items — LinkedIn paginates but the
    scraper doesn't follow it.
  - Overall shape: bugs cluster around **UI-state ambiguity and account-mode variance**, not raw
    detection/blocking — consistent with a browser-DOM approach.

### 2. joeyism/linkedin_scraper — most-starred, least-responsive
- **Auth/rendering**: v3.0.0 (breaking rewrite) moved from Selenium to Playwright, async throughout,
  Pydantic models. v2.x (Selenium) still pip-installable for anyone who needs the old shape.
- **Health-scored responsiveness (D) = 0.08/1** — the worst of any finalist. Confirmed by the tracker
  itself: issue #257 "Job search is broken" opened 2025-07-21 is **still open 13 months later**.
  #277 (2026-02-18) reports `detect_rate_limit()` **false-positives on a React RSC payload** — i.e.
  LinkedIn's frontend now ships React Server Components, and a scraper written against the old DOM
  shape misreads RSC streaming chunks as a block/challenge page. This is a direct, dated confirmation
  that LinkedIn's client-side rendering has structurally changed underneath older scrapers.
- Two open "sponsorship inquiry" issues (#295, #244) and two automated "TrustScope" bot-filed
  governance/security-improvement issues (#296, #297, both 2026-07-22) with zero maintainer response —
  the tracker's overall texture is a project coasting on stars, not being actively triaged.

### 3. mguttmann/linkedin-internal-api — smallest repo, most valuable documentation
- **Auth/rendering**: **browserless-first**. Two cookies decide everything: `li_at` (session token)
  and `JSESSIONID` (its unquoted value becomes the `csrf-token` header — omit it and every call 403s).
  The browser is used **only once**, to mint fresh cookies via Chrome DevTools Protocol
  (`lib/cookies_extract.py`): launch headless Chrome with a persistent automation profile, navigate to
  `/feed/` (this is what causes `JSESSIONID` to be set), then `Network.getAllCookies` over the CDP
  websocket and write them to a JSON file. After that, every API call is a plain `requests` call
  (`lib/vgreq.py`) — no browser in the hot path.
  - **Documented, dated pitfall** (`docs/01-AUTH-AND-COOKIES.md`): early tests hit a 302 redirect loop
    on `/voyager/api/me` and the author initially suspected bot-detection/fingerprinting; the real
    cause was simply expired cookies. Their conclusion, stated explicitly: **"Browser fingerprint
    plays NO role"** for reads once cookies are fresh — a single-operator, single-account finding
    (unverified against a second account/IP), not a general claim.
  - Write actions via the newer **SDUI** surface (`/flagship-web/rsc-action/...`, protobuf-JSON) need
    a **non-headless, visible** Chrome, because LinkedIn's post/edit modals don't render reliably
    headless (`docs/04-WRITE-OPERATIONS.md`) — i.e. reads are pure-HTTP but writes may still need a
    real rendered browser, at least for some actions.
- **Endpoint coverage**: 130 endpoints across two backends — legacy **Voyager** (REST.li + GraphQL,
  "established, broad") and newer **SDUI** ("server-driven UI", protobuf-JSON, "newer, growing," and
  where most profile-edit/comment/unlike/delete actions now live). Each endpoint is tagged
  ✅ verified (executed live, status documented) / 🔍 discovered (seen in real traffic) /
  🔩 inferred (guessed, unconfirmed) — see `docs/STATUS-MATRIX.md`. This provenance discipline is the
  single most reusable idea in this whole survey (see "what to steal" below).
- **Honest backlog** (`docs/BACKLOG.md`, 2026-07-16/07-30): nested comment replies are explicitly
  **diagnosed as unimplementable with current captures** — the only "reply" capture on file is
  byte-identical to a top-level comment except for tracking IDs, so the `parentComment` binding this
  would need is admitted to be a guessed name, "never send it." This is an honest, dated admission of
  a gap that the whole ecosystem shares (no repo in this survey has working nested-reply support).
- Zero open GitHub issues — too new/small (2 stars) to have accumulated any yet; its value is 100%
  in the documentation quality, not community signal.

### 4. jjuanrivvera/linkedin-cli — smallest surface, tightest safety posture
- **Auth/rendering**: browserless raw-HTTP over Voyager, read-only by design (jobs, companies, geo
  lookup only — explicitly refuses to add write actions).
- **Ban-safety defaults, stated in the README as defaults, not options**: human-paced 3–15s delays
  between requests, one request in flight at a time, a **~30/day cap on job-detail fetches**, and
  **no automatic retry** on throttle/soft-block/challenge responses (retrying into a challenge is
  treated as the failure mode to avoid, not a transient error to paper over).
  Explicitly self-analogizes: "this is the same caveat class as `slackctl`'s `xoxc`/session auth" —
  i.e. an independent author has already converged on exactly the cookie/session-auth risk framing
  the relay family uses, and named concrete numeric rate limits worth adopting as linkedin-relay
  defaults rather than inventing them from scratch.
- Zero open issues (too new — pushed 2026-07-30), CI green, ships an MCP surface alongside the CLI.

## What we should steal

1. **Verified / discovered / inferred provenance tagging on every documented endpoint**
   (`mguttmann/linkedin-internal-api`, `docs/STATUS-MATRIX.md` + `data/endpoints_voyager.json` /
   `data/endpoints_sdui.json`) — maps directly onto x-relay's own "fail loudly, never guess" ethos.
   linkedin-relay's `docs/ENGINE-RESEARCH.md` should adopt this exact three-state marker convention
   from day one, given how fast LinkedIn's surface is shown to drift (see BACKLOG.md's own admission
   that two docs had to be *downgraded* from ✅ to inferred after a closer look).
2. **CDP-based cookie bootstrap** (`mguttmann`, `lib/cookies_extract.py`): launch a real Chrome with a
   persistent automation profile, force-navigate to `/feed/` specifically because that's what sets
   `JSESSIONID`, then pull all cookies via `Network.getAllCookies` over the DevTools websocket. This is
   a concrete, working alternative to browser-extension cookie export for the `XRELAY_COOKIES`-style
   env/file bootstrap linkedin-relay will need.
3. **Numeric ban-safety defaults** (`jjuanrivvera/linkedin-cli`): 3–15s human-paced jitter, one request
   in flight, a low daily cap on the most expensive read (~30/day), zero auto-retry on
   throttle/soft-block/challenge. These are concrete starting numbers, not just a "be careful" policy.
4. **Read/write split by transport**, not just by risk (`mguttmann`): reads can stay pure-HTTP
   (`requests`, no browser in the hot path) while at least some writes structurally require a real
   rendered, non-headless browser because LinkedIn's SDUI modals don't render headless. Plan for
   linkedin-relay's write commands to possibly need a Patchright/Playwright fallback even if the read
   path stays browserless — don't assume one transport covers both.
5. **Two-cookie auth model, documented precisely**: `li_at` (session) + `JSESSIONID` (its unquoted
   value → `csrf-token` header) is the entire auth surface; `docs/01-AUTH-AND-COOKIES.md` spells out
   the exact header set (`x-restli-protocol-version: 2.0.0`, `accept:
   application/vnd.linkedin.normalized+json+2.1`, etc.) needed on every call.

## What we should avoid

1. **Unmaintained raw-Voyager-REST clients as a foundation.** The entire `tomquirk/linkedin-api`
   lineage — the historically most popular unofficial LinkedIn client — is now either gone
   (`tomquirk/linkedin-api` 404s and isn't in the owner's current repo list, cause unverified) or
   stale for 5+ years (`nsandman/linkedin-api`, last push 2021-04-30). Building on any fork of this
   lineage means building on abandonware; LinkedIn's endpoint/query-id drift will not be tracked.
2. **Coasting on stars.** `joeyism/linkedin_scraper` is the single most-starred repo in this whole
   survey (4,381★) and has the *worst* measured responsiveness (0.08/1) — a year-plus-old "job search
   is broken" issue still open, automated governance-bot issues ignored. Stars are a lagging, gameable
   signal; this survey's own ranking tooling flags exactly this pattern (`ratio-anomaly`/health flags
   fired on several small repos too — see corpus).
3. **Puppeteer-stealth-plugin-based scraping**, as a category: `puppeteer-extra-plugin-stealth`, the
   plugin that made Puppeteer viable for anti-bot evasion, was deprecated in February 2025 and has
   received no updates against newer detection since. Anything built on it in 2026 is running blind.
4. **Narrow single-purpose scrapers going quiet**: `spinlud/py-linkedin-jobs-scraper` (487★) and its
   JS twin (186★) have had no commits since 2025-03-14 (~17 months) — a once-solid, narrow (jobs-only)
   tool with no signs of active drift-tracking as LinkedIn's job-search DOM changes.

## Open questions for the panel

1. **Why did `tomquirk/linkedin-api` disappear?** Confirmed via `gh api repos/tomquirk/linkedin-api`
   (404) and the owner's current repo list (no `linkedin-api`/`linkedin_api` entry). A code-search of
   `github/dmca` for "linkedin" returned 71 hits; time-boxed before isolating one that names this repo
   specifically. Unverified whether this was a rename, a voluntary takedown, or a DMCA/C&D — but
   regardless of cause, the flagship of this whole category can vanish overnight, and linkedin-relay's
   design should treat that as a live risk to itself, not just to precedent tools.
2. **Does "browser fingerprint plays no role" generalize?** mguttmann's repo states this as a
   conclusion from the repo owner's own single-account debugging session (marked "(owner-run)" in
   their own provenance convention) — not corroborated by a second account, IP, or independent report
   found in this survey.
4. **How much of the write surface structurally needs a real browser?** mguttmann needs non-headless
   Chrome specifically for SDUI write modals; stickerdaniel is 100% browser-driven for everything.
   No repo in this survey demonstrates a fully browserless write path for anything beyond simple
   REST.li POSTs (connect, like). This bounds how "thin" linkedin-relay's write engine can be.
5. **Nested comment replies remain unsolved industry-wide** — mguttmann's own honest backlog entry
   diagnoses it as blocked on a missing capture even after deliberate effort; no repo in the corpus
   claims working support. Treat as a known-hard, not-yet-solved feature rather than an oversight to
   fix quickly.
6. **No incremental/local-cache analog to x-relay's bookmark sync was found** anywhere in the 90-repo
   corpus. This may be genuinely unclaimed territory for linkedin-relay to own — or it may simply be
   outside what a code/keyword search surfaces; not verified exhaustively given the time-box.
