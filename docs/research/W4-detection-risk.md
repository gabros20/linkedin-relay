# W4 — Detection Risk: Raw Voyager Writes (A) vs. CDP-Driven Real Browser (B)

Researched 2026-08-12. Builds directly on `R1-github-landscape.md`, `R2-field-reports.md`,
`R3-linkedin-surface.md`, `R4-risk-and-market.md` (already in this repo) plus new targeted research:
GitHub issue-tracker sweeps (`gh search issues`) across the six candidate Voyager/scraper repos, a
fresh X sweep (`xrelay search`), and web research into client-side and CDP-protocol-level detection
mechanics. Confidence tags carried over from R2's convention: **measured** (published numbers/experiment),
**report** (named individual's first-person account), **vendor** (marketing content — discounted),
**doc** (LinkedIn's own documentation), **inferred** (my synthesis, not a direct source).

**Context this lane assumes, not re-litigates:** the official OAuth write path (`w_member_social`) that
`docs/DESIGN.md` §2 ratified as the sole write transport is currently blocked for the owner (needs a
developer app tied to a company Page they don't have). This lane evaluates the two remaining options —
raw Voyager writes (A) and CDP-driven browser control (B) — purely on detection risk, for exactly the
three actions already in scope: `share`, `comment`, `react`. It does not revisit whether writing at all
is wise; `R4-risk-and-market.md` §2-3 already covers that the account itself is the asset at stake.

---

## Verdict, up front

**Weak-to-moderate lean toward B (CDP attached to a real, already-logged-in Chrome, driven by a
stealth-patched framework, not `puppeteer.launch()`), and only if that specific configuration is used —
not CDP automation in general.** Confidence: **low-moderate**. The margin between A and B is smaller
than either option's margin over *cadence*, which is the best-attested variable in the entire evidence
base by a wide margin and swamps the transport choice.

The reasoning, compressed:

- LinkedIn's own web client is **confirmed** (not inferred) to run client-side JavaScript that checks
  `navigator.webdriver`, PhantomJS/Selenium markers, and probes ~1,000+ browser-extension IDs
  `[report: Castle.io blog, Jan 2026 — a bot-detection vendor's read of LinkedIn's live obfuscated JS,
  technical and specific rather than marketing copy]`. Raw HTTP (A) never executes this JS at all —
  categorically immune to this whole detection class, because the mechanism requires a JS runtime in a
  browser context that A never spins up.
- CDP-driven browser control (B) *does* run that JS, and therefore is exposed to exactly what it's
  designed to catch — `navigator.webdriver` is `false` if the browser is attached to (not launched by)
  the automation tool via `--remote-debugging-port` with no `--enable-automation` switch, but a second,
  independent detection layer exists at the CDP-protocol level itself (`Runtime.enable` object-serialization
  leak, ChromeDriver `cdc_*` artifacts, non-trusted synthetic input events) that fires regardless of
  launch method, unless the driving framework is specifically stealth-patched to suppress it
  `[report: DataDome/Scrappey technical writeups, generic Chromium mechanism, not LinkedIn-specific
  confirmation]`. The dominant, most-maintained LinkedIn agent tool in this whole space
  (`stickerdaniel/linkedin-mcp-server`, R1) uses `patchright` — a stealth fork of Playwright built
  specifically to suppress these leaks — rather than vanilla Playwright/Puppeteer. That the ecosystem's
  best-resourced project pays for a stealth fork rather than trusting vanilla CDP automation is itself
  circumstantial evidence that **vanilla** CDP is not safely invisible; a correctly-configured stealth
  setup is a different, better claim than "CDP automation" as a category.
- Feasibility, not just safety, points the same direction for **writes specifically**: `mguttmann/linkedin-internal-api`
  (R1) — the most-documented pure raw-HTTP client in this survey — states its own write actions on the
  newer SDUI surface (where `comment`/`react`/`post`-edit increasingly live) need a **visible, non-headless**
  browser because the write modals don't render reliably headless. That is a working-implementation
  constraint independent of ban risk: a pure-Voyager-REST.li write path (A, as scoped in R3 §3) may be
  incomplete or already legacy for some of these three actions, not just riskier.
- What does **not** distinguish A from B at all: **legal/contract exposure.** §8.2, item 13 bans "bots or
  other unauthorized automated methods to ... comment on, like, share, or re-share posts" without regard
  to transport — a CDP-driven browser executing LinkedIn's own JS is still "software... used to access
  the Services" per §8.2, item 2. Switching from A to B buys zero reduction in ToS/contract risk (R3 §5,
  R4 §2); it only moves the *technical*-detection needle, and only maybe.
- What swamps both: **behavioral/velocity signal, server-side, independent of transport.** R2's single
  strongest finding is that fast *manual*, zero-automation browsing alone has triggered restrictions
  (`@tekbog`, verified-by-corroborated-thread, R2 §1/§3). That signal is evaluated on the account's action
  stream, not on how any individual request was generated — it applies identically whether the bytes on
  the wire came from `curl`-equivalent code or from a real Chromium tab. A slow, jittered, human-plausible
  write cadence is a bigger lever than the A/B choice.

If forced to a single sentence: **use B, configured as CDP-attach-not-launch with a stealth-patched
framework, but do not expect it to buy much more than A does, and spend your actual risk budget on
cadence, not transport.**

---

## 1. What actually triggers restrictions — mechanism by mechanism

| Mechanism | Fires on reads? | Fires on writes? | Evidence |
|---|---|---|---|
| **Request velocity / burst cadence** | Yes — best-attested trigger in the whole corpus | Yes, and probably harder (see §4) | `[report]` R2 §1/§3: `@tekbog` restricted for "clicking around... no automation tool used"; `@BehrensCorey`-adjacent report of manual rapid profile-opens. Multiple independent, unrelated accounts. This is server-side account-stream analysis — transport-agnostic by construction. |
| **Read:write ratio / behavioral asymmetry** | Contributory | Contributory | `[report, single source]` R2 §3: `@brettfarrow` reply theorizes account "looked automated" because it was reading without posting — i.e. an *unusual mix*, not just raw volume, may be part of the signal. Folk theory, not confirmed mechanism. |
| **Client-side JS: automation-framework markers** | Only if reading via a real browser page render (B); **structurally inert against raw HTTP (A)** | Same | `[report]` Castle.io, Jan 2026: LinkedIn's client JS checks `navigator.webdriver`, `window.callPhantom`/`_phantom`, `_Selenium_IDE_Recorder`, `__webdriver_script_fn`. This is LinkedIn's *own* code, read by a third-party bot-detection researcher — not vendor marketing about LinkedIn, an actual technical account of what LinkedIn ships. |
| **Client-side JS: browser-extension fingerprinting** | Same as above | Same | `[report]` same source: LinkedIn iterates a list of ~1,000+ known extension IDs, batch-fetches `chrome-extension://<id>/<known-resource>` and infers install from which promises resolve (e.g. Grammarly). Only executes inside a rendered page — inert against A. |
| **CDP-protocol-level leaks** (`Runtime.enable` serialization side-effect, ChromeDriver `cdc_*` properties, non-trusted synthetic `Input.dispatch*` events, framework globals like `__playwright__binding__`) | Only relevant to B | Only relevant to B | `[report, generic Chromium mechanism — not confirmed LinkedIn-specific]` DataDome/Scrappey technical writeups: these are detectable regardless of whether the browser was launched with automation flags or attached to after a normal launch, because the leak comes from *enabling the CDP domain itself*, not from how the browser process started. No source found confirming LinkedIn specifically probes for these on its own pages — this is inferred exposure from a generic mechanism, not observed LinkedIn behavior. |
| **UA / header staleness** | Yes (A specifically) | Yes | `[report]` R3 §5: a still-open fork issue (`nsandman/linkedin-api#8`) reports a login CHALLENGE clearing after updating a hardcoded UA string from Chrome 83 to current — direct, if single-source, evidence that stale headers alone measurably raise challenge rate for raw-HTTP clients. |
| **TLS/JA3, HTTP/2 fingerprint, header ordering** | Unconfirmed either way | Unconfirmed either way | **Not found** in this pass or in R1-R4. Generic anti-bot vendors sell this as a product category broadly; no source in either the X sweep, the GitHub sweep, or this web pass names LinkedIn specifically as deploying it against Voyager. Absence of evidence, not evidence of absence — flagged explicitly in §5. |
| **IP reputation (datacenter/cloud vs. residential)** | Yes | Yes | `[doc + report]` R3 §5: HTTP 999 is a pre-auth, network-layer block LinkedIn documents as automatic for bot-shaped traffic including datacenter IP ranges; consistent, durable mechanism since at least 2013. Applies identically to A and B — a CDP-driven browser on a datacenter box is just as blockable as raw HTTP from one. |
| **Content/engagement policy** (fake profiles, coordinated liking/resharing, "agree ahead of time to like/reshare") | N/A | Yes, specifically for `react` | `[doc]` R4 §2: LinkedIn's Professional Community Policies name "artificial engagement" explicitly — this is a *content-policy* trigger, independent of bot-detection, and applies equally to A and B since it's about the pattern of the engagement, not how it was executed. |
| **Fingerprint-sharing across shared automation infrastructure** ("cloud scrapers... when one gets flagged, they all do") | — | — | `[rumor]` R2 §3: single 27-follower self-interested source. Plausible generic pattern for anti-bot vendors elsewhere, not corroborated for LinkedIn. Irrelevant to this project regardless (single-account, single-machine, own residential IP — not shared infra). |
| **User reports / spam complaints** | N/A | Possible for `comment`/`react` | Not directly evidenced in this corpus. Included for completeness: this is a plausible, LinkedIn-typical trust-and-safety input (any social platform), but no source in R1-R4 or this pass names it as a confirmed LinkedIn automation-detection trigger specifically. Treat as `[inferred]` background risk, not a documented mechanism. |

**Net read:** velocity/behavioral signal is the only mechanism with strong, repeated, independent
corroboration. Everything else in the table is either single-source, generic-not-LinkedIn-confirmed, or
purely inferred. This matters for the verdict: don't let the A-vs-B question absorb more design attention
than the cadence question, which the evidence actually supports strongly.

---

## 2. Does LinkedIn detect raw Voyager calls specifically? (Option A)

**Short answer: no confirmed evidence they distinguish a well-formed raw-HTTP Voyager call from a
browser-issued one at the network layer — but "no evidence found" is not "evidence it doesn't happen,"**
and the sample size behind the positive claim is small.

- **What a raw Voyager call needs to look plausible**, per R3 §1 (verified against `tomquirk/linkedin-api`
  2.3.1 source): `li_at` + `JSESSIONID` cookies, `csrf-token` derived from `JSESSIONID` (not a separate
  secret), `x-restli-protocol-version: 2.0.0`, a current UA string, `accept-language`. Headers commonly
  cited elsewhere (`x-li-track`, `x-li-page-instance`, `x-li-deviceId`) appear **commented out** in the
  one primary source read — `[report]` an actual maintainer judged them non-essential for at least some
  endpoints, as of the Nov 2024 snapshot. Not confirmed current for 2026.
- **Positive survivorship evidence**: two actively-maintained, browserless, raw-HTTP Voyager clients —
  `mguttmann/linkedin-internal-api` (pushed 2026-07-31) and `jjuanrivvera/linkedin-cli` (pushed
  2026-07-30) — exist and are apparently functioning as of this research date `[report, R1]`.
  `mguttmann`'s own documented conclusion, stated explicitly in `docs/01-AUTH-AND-COOKIES.md`: **"Browser
  fingerprint plays NO role"** for reads once cookies are fresh — a 302-redirect-loop they initially
  suspected was fingerprinting turned out to just be expired cookies. **This is explicitly marked
  "(owner-run)" in their own provenance convention** — one operator, one account, short observation
  window, no adversarial pressure (2-star repo, essentially unused). Weak evidence, not proof.
- **GitHub issue-tracker sweep for this pass** (`gh search issues`, six candidate repos —
  `mguttmann/linkedin-internal-api`, `jjuanrivvera/linkedin-cli`, `stickerdaniel/linkedin-mcp-server`,
  `joeyism/linkedin_scraper`, `tomquirk/linkedin-api`, `nsandman/linkedin-api` — plus unrestricted
  cross-repo searches for "linkedin scraper banned," "voyager api linkedin banned," "linkedin api
  restricted") **returned zero relevant results.** This is itself informative, in the same direction R2
  already found for GitHub: the topic is too thin on issue trackers to corroborate or refute anything
  specific to raw-Voyager detection. Absence of complaints from a 2-star, week-old repo is not meaningful
  survivorship; absence of complaints from the (dead) `tomquirk`/`nsandman` lineage that ran for years is
  slightly more meaningful but confounded by those repos also being effectively unmaintained/unwatched by
  now.
- **What would move this from "no evidence" to "evidence of absence"**: a longer-running, higher-usage
  raw-Voyager client with a real issue tracker reporting *zero* fingerprint-specific bans over a long
  window, cross-referenced against known ban reports for the *same account* attributable to something
  else. Nothing in this corpus reaches that bar.

---

## 3. Is CDP-driven browser control actually safer? (Option B)

**More nuanced than "the request is generated by LinkedIn's own JS, so it's strictly better."** That
framing is correct for the *network request shape* layer and wrong if it implies the automation layer
disappears.

- **`navigator.webdriver` specifically**: this flag is set `true` by the `--enable-automation` Chrome
  switch, which Puppeteer's `launch()` and Selenium/ChromeDriver set by default. **Attaching CDP to an
  already-running, normally-launched Chrome** (e.g. `chrome --remote-debugging-port=9222` started by the
  user, then `puppeteer.connect()`/raw CDP websocket against it — not `puppeteer.launch()`) does **not**
  set this flag, and does not add ChromeDriver's `cdc_*` window properties either `[inferred from
  documented CDP/automation-flag mechanics; not independently tested against LinkedIn in this pass]`.
  This is the load-bearing distinction between "CDP automation" as a category and the specific
  attach-to-existing-profile pattern this design should use.
- **This does not clear the CDP-protocol leak layer.** `Runtime.enable` (needed by most frameworks for
  console/exception capture) causes Chrome to serialize logged objects for the controller — a behavior a
  page can detect by logging an object with a getter and checking whether it ran
  `[report: DataDome/Scrappey technical writeups]`. This fires **because the CDP domain is enabled**, not
  because of how the browser was launched — so attach-not-launch alone does not neutralize it. Neither
  does it neutralize non-trusted synthetic input: if `share`/`comment`/`react` are executed by dispatching
  `Input.dispatchMouseEvent`/`dispatchKeyEvent` over CDP rather than real OS-level input injection, those
  events can lack properties a real click/keypress carries (`isTrusted` and related characteristics) —
  another documented, generic detection avenue.
- **What actually mitigates this**: the same source class describes three concrete countermeasures —
  don't enable Runtime/Console CDP domains unless strictly needed, delete framework-injected bindings
  before they're queryable, or use a browser engine specifically patched to suppress the serialization
  side-effect and hide bindings at the C++ level (what `patchright` — the fork
  `stickerdaniel/linkedin-mcp-server` actually ships — does). **The dominant, most-resourced, most-active
  LinkedIn agent tool in this entire space chose the third option over vanilla Playwright/Puppeteer**,
  which is the strongest circumstantial signal in this whole report that plain CDP automation is not
  safely invisible against LinkedIn specifically — someone with real usage volume decided it needed active
  patching, not just attach-not-launch discipline.
- **LinkedIn is confirmed to run anti-automation JS on its own pages** (Castle.io analysis, §1 above),
  meaning B genuinely is exposed to a real, live, LinkedIn-specific detection layer that A structurally
  cannot trip — this is the strongest point *against* B relative to A, not for it, and cuts directly
  against the "strictly better" framing.
- **Writes may need a real, non-headless browser regardless of the safety question.** `mguttmann`'s own
  documentation (R1 §3) states LinkedIn's post/comment/edit modals on the newer SDUI surface "don't render
  reliably headless" — a functional constraint, not a detection one. If true, a visible Chrome window is
  needed for at least some write actions under *either* philosophy, which narrows the real design choice
  to "visible CDP-attached Chrome, stealth-patched" vs. "visible CDP-attached Chrome, vanilla" — not
  really A vs. B as originally framed for the write surface specifically. This reframes the practical
  question W1 (raw Voyager writes) needs to answer directly: can `share`/`comment`/`react` be done at all
  as plain Voyager REST.li POSTs, or do they already require SDUI's rendered-modal path?

**Confidence on the B-safer claim: low-moderate**, contingent entirely on using the attach-not-launch +
stealth-patched configuration. A naive `puppeteer.launch({headless:false})` against LinkedIn is plausibly
**worse** than raw HTTP, not better, because it both runs the JS-based checks LinkedIn is confirmed to run
*and* leaves the cheapest automation-flag tells (`navigator.webdriver=true`, `cdc_*` properties) exposed —
the worst of both worlds.

---

## 4. Write-specific thresholds

**No corroborated numeric ceiling exists for `share`/`comment`/`react` specifically, from any source
consulted across R2 or this pass.** What's in circulation:

- `[vendor, discount heavily]` 2026 automation-vendor blogs (PhantomBuster, LinkBoost, LinkedHelper,
  Commentify) claim figures like "100-150 likes/day," "80-100 comments/day" as "safe," while — in the same
  search results — a *different* PhantomBuster post explicitly warns that **copying daily limits from
  Reddit/blogs is itself dangerous advice**, because LinkedIn evaluates pattern over time (velocity
  changes, session-timing consistency, acceptance-rate trends), not one-off daily totals. The category is
  self-contradicting: vendors sell specific numbers while other vendor content in the same space says the
  numbers don't actually determine outcome. Treat every specific number here as marketing copy with no
  cited methodology.
- `[report, single source, R2 §2]` "MCP works for reading LinkedIn but not for writing (connections,
  messages)" — this data point is about connect/message specifically (the two actions this project
  deliberately excludes), not share/comment/react, and is one unverified claim.
- **This project's own existing design posture** (R5/DESIGN.md, for the connect-style writes it later cut)
  used `10/day, 1 per 90s` as a deliberately conservative guess, explicitly *below* the weakest lore number
  found (~20/day). No equivalent number was ever derived for share/comment/react because those writes were
  slated to go over OAuth, which has its own (undocumented in this pass) rate posture separate from
  Voyager/CDP entirely.
- **Recommendation for this lane, stated as a recommendation not a finding**: given the near-total absence
  of write-specific data, default to the same order of conservatism already adopted for connects — single
  digits to low tens per day, jittered, one write in flight, no burst — rather than the 80-150/day vendor
  figures, which have every incentive to be generous and zero cited methodology.

---

## 5. What restriction actually looks like, and recoverability

| Stage | What it is | Typical duration (as reported) | Recoverable? |
|---|---|---|---|
| **HTTP 999** | Pre-auth, network-layer block for bot-shaped traffic (non-browser UA, datacenter IP, high velocity, robots.txt violations) | Self-resolving once traffic normalizes | `[doc-adjacent, R3 §5]` Yes, automatically — LinkedIn's own framing is that this lifts on its own. This is a transport-layer signal, distinct from account restriction. |
| **CAPTCHA / login challenge** | Pre- or mid-session verification prompt | Immediate if solved | `[report, R3 §5]` Generally yes if solvable in the moment. **Open question, unresolved**: whether CAPTCHA is even still active in LinkedIn's current flow — a direct question in R2's corpus (`@2BitSalute`) went unanswered. |
| **Temporary/automated-flag restriction** | Reduced functionality (search capped, profile-view throttled, can't send certain actions) | Reported range is wide and inconsistent: R3/R4's practitioner/vendor sources say **1-3 weeks**; newer (2026) vendor blogs in this pass say **hours to 24h** for automated flags, **1-3 days** if identity verification is required | `[vendor + report, wide spread]` Usually yes, by waiting or verifying identity. The spread itself (hours vs. weeks, across sources from the same general period) is the honest finding — nobody has a reliable number. |
| **Identity-verification lock (vendor "Persona")** | Appeal routes through third-party photo/ID verification | **Verified stuck 30+ days** in R2's corpus — 5 independent posters, same week, same vendor name, "couldn't verify photos," rejected ID types | `[verified, R2 §1]` The strongest single data point in the whole evidence base on recoverability: this is not a clean binary, it's a purgatory state that a meaningful fraction of restricted users report getting stuck in. |
| **Permanent ban** | Full account removal | N/A | `[vendor, mutually contradictory across sources — do not trust either number]` R4 cites "under 15%" appeal success as an unsourced vendor figure; a 2026 vendor blog in this pass claims wildly different, category-specific figures (92% for excessive connection requests, 65% content violations, ~12% multi-account) with no cited methodology. **The spread from 12% to 92% across vendor sources, for what should be the same underlying phenomenon, is itself evidence that no one publishing these numbers has real data.** Report the range as unreliable, not as a citable statistic. |

**The asymmetry that matters most regardless of which restriction tier fires** (already established in
R4 §3, restated because it governs how much risk either A or B is worth taking): a LinkedIn account is not
a burner. A permanent ban destroys a professional identity — connections, endorsements, posting history,
often the primary channel recruiters/clients use — with no clean re-registration path, unlike an X account.
This asymmetry argues for conservatism on cadence and scope far more than it argues for picking A over B
or vice versa.

---

## 6. Legal/ToS dimension (brief, factual — already covered in depth by R3 §5 / R4)

- §8.2, item 13 of the User Agreement bans bots/automated methods to "comment on, like, share, or
  re-share posts" — the exact three actions in scope here — **without regard to transport**. A CDP-driven
  browser executing LinkedIn's own JS is still "software... used to access the Services" under §8.2, item
  2. **A vs. B changes nothing about contract exposure.**
- The one litigated case most relevant to a single-account, non-resold, own-session write pattern is
  *LinkedIn/Microsoft v. Nubela (Proxycurl)* (R3 §5, R4 §1) — but that case, and every other litigated
  case in the record, targeted commercial resale or bulk multi-account operations. **No verified case found
  (across R4's dedicated search or this pass) of LinkedIn suing a single individual for personal-scale,
  non-resold write automation on their own account.** Absence of a lawsuit is not the same as the conduct
  being permitted (R4 §2 makes this point at length) — enforcement so far appears ROI-driven against
  operations large enough to matter to LinkedIn's legal budget, not evidence of a personal-use safe harbor.
- Proxycurl's founder's own stated conclusion, already surfaced in R3 §5 and worth repeating because it's
  the single most directly on-point first-person account in the whole record: **"Legal does not mean
  safe."** The inverse holds too for this lane's question — *detection-safe* (if B genuinely is, at low
  confidence) does not make either option *legal*.

---

## 7. What nobody actually knows

Stated explicitly, per the brief, rather than blurred into false confidence:

- **Whether LinkedIn's server-side risk engine weighs client-side JS execution (or its absence) as a
  signal at all**, independent of the specific JS checks it's confirmed to run. No source found either
  confirms or rules this out. Everything in §2's "positive survivorship" is inferred from two small,
  low-traffic, short-lived repos — not measured.
- **Whether LinkedIn probes CDP-domain leaks (`Runtime.enable`, synthetic-input trust) specifically.**
  The mechanism is real and generically documented across the anti-bot industry; no source in this pass or
  R1-R4 names LinkedIn as confirmed to deploy it. The strongest available evidence is circumstantial (the
  dominant OSS tool pays for stealth patching), not direct observation.
- **TLS/JA3, HTTP/2 fingerprint, and header-ordering relevance to LinkedIn specifically** — genuinely
  unaddressed by any source found across all research lanes to date. This is a real gap, not a settled
  "no."
- **Real numeric thresholds for `share`/`comment`/`react`.** Every number in circulation is vendor
  marketing with no cited methodology, and the vendor sources contradict each other on whether numbers
  even matter versus pattern-over-time.
- **Whether attach-to-existing-Chrome-via-CDP meaningfully changes ban outcomes versus full
  `launch()`-based automation.** No field report distinguishing these two sub-approaches specifically
  against LinkedIn was found; the distinction is drawn here from general CDP/automation-flag mechanics,
  not from a LinkedIn-specific test.
- **Whether write-action restriction risk compounds faster than read-action risk.** The one data point in
  the whole corpus (R2 §3, single source: "MCP works for reading... not for writing") is unverified and in
  tension with the equally-unverified "read velocity alone triggers restriction" finding. Both could be
  simultaneously true at different volumes; the evidence does not resolve this.
- **Real appeal-success rates at any restriction tier.** The available numbers span 12% to 92% across
  sources describing overlapping categories, with zero cited methodology on either end. Treat this as
  unknown, not as "somewhere in that range."

**If a single header claim from this report has to be trusted least, it's any specific percentage or
daily-cap number — every one traces to vendor marketing, not measurement. If a single claim has to be
trusted most, it's that fast, un-automated manual browsing alone has triggered restrictions (R2, multiple
independent corroborating accounts) — that's the closest thing to solid ground in the entire evidence
base, and it argues for spending the design's actual risk budget on cadence discipline, not on the A-vs-B
transport question this lane was asked to resolve.**
