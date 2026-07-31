# P3 — linkedin-relay design proposal (FABLE / Fable 5)

**Thesis.** The read half of this tool is worth building and has no substitute. The write half mostly
is not, and where it is, it should not go through Voyager. The scarce resource this design spends is
not developer time or context tokens — it is the user's professional identity (R4 §3), and every
decision below is an allocation of that budget. Concretely: fewer commands than x-relay, a hard
structural spend-ledger, zero retries, and writes split by legitimacy rather than by risk label.

Names (family formula, R5 §8): repo `linkedin-relay`, CLI bin `lnrelay`, npm + MCP bin
`linkedin-relay-mcp`, cache `~/.lnrelay`, env `LNRELAY_CACHE_DIR` / `LNRELAY_COOKIES`. Verify free on
npm and date-stamp the check before P1.

---

## 1. Scope and command surface

**Decision: 15 commands, not 29.** x-relay's breadth is safe because an X ban costs a burner account.
Here every command is a distinct traffic signature that must be independently paced and proven not to
trip detection, and R2 §2 gives us *no* numeric envelope to prove it against. Smallness is a safety
property, not a scoping compromise.

### Reads (Voyager; all exposed over MCP unless noted)

| command | usage | cost | grounding |
|---|---|---|---|
| `search` | `lnrelay search people\|companies\|jobs <q> [--filters] [--limit N] [--compact\|--fields]` | 1–3 calls | R3 §3 — `voyagerSearchDashClusters` verified Nov-2024 |
| `profile` | `lnrelay profile <public-id\|urn> [--sections experience,education,...]` | 1 call (+1/section) | R3 §3 — `profileView` verified; dash fan-out via `voyagerIdentityDashProfileComponents` |
| `company` | `lnrelay company <universal-name> [--updates]` | 1–2 calls | R3 §3 verified |
| `post` | `lnrelay post <activity-urn\|url> [--limit N]` — the post **and its comment thread**, cursor-followed | expensive — full read | R3 §3 `/feed/comments` + `paginationToken`; R5 §9.1 |
| `reactions` | `lnrelay reactions <activity-urn> [--limit N]` | medium | R3 §3 `voyagerSocialDashReactions` verified |
| `feed` | `lnrelay feed [--limit N]` | medium | R3 §3 `feed/updatesV2?q=chronFeed` verified |
| `job` | `lnrelay job <job-id>` | 1 call | R3 §3 verified |
| `connections` | `lnrelay connections [-q <query>] [--sync] [--diff]` — cache-backed, see §4 | cheap (local) / expensive (`--sync`) | R3 §3 — connections is a filtered people-search, not a list |
| `my-posts` | `lnrelay my-posts [-q <query>] [--sync]` — cache-backed | cheap / medium | R3 §3 `identity/profileUpdatesV2` |
| `batch` | `lnrelay batch --file queries.txt --out merged.json [--delay-ms] [--quiet]` — **reads only** | N calls, serialized | R5 §9.2 — flush after **every** query |
| `whoami` | `lnrelay whoami` | 1 call | `/voyager/api/me`, verified |
| `budget` | `lnrelay budget [--reset-cooldown --confirm]` | free | §5 |
| `doctor` | `lnrelay doctor [--offline]` | ≤3 calls | R5 §8 |
| `purge` | `lnrelay purge [--third-party\|--all] [--confirm]` | free | R4 hard constraint |

### Writes (CLI-only, never MCP, every one requires `--confirm`)

| command | transport | why |
|---|---|---|
| `share "<text>"` | **Official OAuth, `w_member_social`** | R3 §6 — self-serve, no partner review, no screencast. Legitimate. |
| `comment <urn> "<text>"` | **Official OAuth** | same |
| `react <urn> [--type LIKE\|PRAISE\|...]` | **Official OAuth** | same |
| `connect <urn> [--note "<text>"]` / `withdraw <invite-id>` | Voyager POST | no official path exists (R3 §6) |
| `follow` / `unfollow <urn>` | Voyager POST | no official path; note Rest.li `PATCH $set` semantics (R3 §3) |
| `invitations [--accept <id> \| --reject <id>]` | Voyager POST | no official path |

**The OAuth/Voyager write fork is a decision, not an option.** R3 §6 hands the panel this fork and I
take it in its strongest form: `share`/`comment`/`react` are **structurally incapable** of being sent
over Voyager — the Voyager client type has no method for them. It costs a second auth system
(`~/.lnrelay/oauth.json`, token refresh) and buys: the three highest-frequency writes become ToS-legal
and drift-proof, and the three actions LinkedIn's Professional Community Policies name most explicitly
as artificial-engagement vectors (R4) travel over a channel LinkedIn itself sanctions.

### Explicitly left out, and why

- **`message` / `inbox` — cut entirely.** The incumbent's own tracker shows `send_message` double-firing
  and replying into the wrong thread (R1 #573, #483) — an agent bug here is unrecoverable and visible to
  a third party; R2 §3 is the corpus's clearest asymmetry ("MCP works for reading LinkedIn but not for
  writing (connections, messages)"); and an inbox read means holding other people's private messages,
  the worst possible shape under R4 §4.
- **Notifications** — R3 §3 marks the endpoint `[unverified]`, and its research value is low.
- **Nested comment replies** — R1 open question #5: unsolved industry-wide; mguttmann's own backlog
  diagnoses it as blocked on a missing capture. We do not fake it. A comment with children returns
  `{ hasReplies: true, replies: null, warning: 'nested-replies-unsupported' }` — never an empty array
  that reads as "no replies" (R5 §9.1's exact failure class).
- **Anything SDUI** (profile edit, comment delete) — R1 #4: needs a visible, non-headless Chrome.
  Cutting it is what keeps this project browserless in the hot path.
- **Saved items** — R3 §3: no endpoint found, `[unverified]`. Designing against it now would be
  fiction. It is a P0 discovery task; if the capture lands, it becomes a third cache source.
- **Bulk writes of any kind.** `batch` is reads-only, and no flag will make it otherwise.

**Output/envelope.** Family standard (R5 §3): one JSON envelope on stdout, progress to stderr,
`--quiet`, exit 0/1/2, `--compact` (default on over MCP) and `--fields`. Reads add a `meta` block:

```ts
meta: {
  budget: { class, spentInWindow, cap, remaining, capProvenance: 'guessed' | 'measured' },
  returnedCount?, claimedCount?, truncated?, warning?,   // paginated reads
  unknownTypes?: { type: string; count: number }[],       // §3
  unresolved?:   { urn: string; referencedBy: string }[], // §3
  partial?: boolean,
}
```

Error codes: `INVALID_INPUT`, `AUTH_FAILED`, `CSRF_MISSING`, `RATE_LIMITED`, `REQUEST_DENIED` (HTTP
999), `CHALLENGE_DETECTED`, `COOLDOWN_ACTIVE`, `BUDGET_EXHAUSTED`, `SCHEMA_DRIFT`, `NOT_FOUND`,
`CONFIRMATION_REQUIRED`, `NOT_IMPLEMENTED`, `UNKNOWN_COMMAND`. The first four and the last four are
raised **before any network call**.

---

## 2. The engine

**Transport decision: browserless raw HTTP, one request in flight, CDP only to mint cookies.**

R3 unknown #2 calls this the panel's highest-leverage question and correctly notes that
stickerdaniel's abandonment of raw HTTP is a *stated legal posture* ("doesn't exploit undocumented
APIs"), not a demonstrated technical wall. Against that one signal I weigh two independent 2026 repos
still doing browserless Voyager successfully — `mguttmann/linkedin-internal-api` (pushed 2026-07-31,
130 endpoints, reads via plain `requests`) and `jjuanrivvera/linkedin-cli` (Go, pushed 2026-07-30) —
plus mguttmann's dated finding that a suspected fingerprint block was in fact just expired cookies
(R1 §3). Two implementations beat one abstention. **This is the riskiest bet in the design and P0
exists to falsify it (§7).**

Cookie bootstrap: steal mguttmann's CDP flow verbatim (R1 "what to steal" #2) — launch Chrome with a
persistent profile, navigate to `/feed/` *specifically because that is what sets `JSESSIONID`*, pull
via `Network.getAllCookies`. Auth surface is exactly two cookies: `li_at` + `JSESSIONID`, with
`csrf-token: JSESSIONID.replace(/"/g,'')` — a derivation, not a secret (R3 §1, verified).

`engine/ops.ts` holds every rotating constant — queryIds (`<OperationName>.<32-hex>`), `decorationId`
strings, the `x-restli-protocol-version`/`accept` header set, and the User-Agent. **The UA is
config with a `capturedAt` date**, because R3 §5 has direct evidence that a stale UA measurably
raises challenge rate (`nsandman/linkedin-api#8`). `doctor` warns when the UA is >90 days old.
Everything R3 §1 tags `[unverified — cargo-cult candidates]` (`x-li-track`, `x-li-page-instance`,
`x-li-deviceId`, `li_rm`, `bcookie`) is **not sent** in v1; the one primary source we have has
`x-li-track` commented out. Send nothing you cannot justify — an unexplained header is as likely to
be a fingerprint mismatch as a fix.

`engine/restli.ts` is a real, tested, pure encoder/decoder for Rest.li 2.0's variables grammar —
`(key:value,list:List(a,b),nested:(x:1))`, `a | b` OR-groups, arbitrary nesting (R3 §2, verified).
Nobody in the 90-repo corpus has this as a clean module; everyone string-templates it. ~120 lines,
zero network, and the difference between adding a filter safely and guessing at parentheses.

**Resilience — and here I deliberately break with the family.** x-relay's `client.ts` retries 429 up
to three times (`src/engine/client.ts:165-181`). That is correct for X and wrong here.

| response | policy |
|---|---|
| 429 | **zero retries.** Return `RATE_LIMITED` + write a 60-minute cooldown. |
| 999 "Request Denied" | Return `REQUEST_DENIED` + write a **6-hour** cooldown. R3 §5: a network-layer bot block that lifts as traffic normalizes — so the only correct response is to stop generating traffic. |
| challenge redirect / `login_result != PASS` shape | `CHALLENGE_DETECTED` + an **indefinite** cooldown, cleared only by `lnrelay budget --reset-cooldown --confirm` after the user has logged in through a real browser. |
| 401/403, or a 302 loop to login | `AUTH_FAILED`, terminal. R1 §3: the 302-loop-on-`/me` signature means expired cookies, not detection — the hint says exactly that, so the user doesn't panic-diagnose fingerprinting. |
| 200 with `data` referencing URNs but `included: []` | `SCHEMA_DRIFT`. See §3 — this is our `(336) features cannot be null` analogue and it is buildable **now**. |
| 400 with a Rest.li error body naming an unknown queryId | `SCHEMA_DRIFT`, message: "refresh `src/engine/ops.ts` queryIds." |

The cooldown is a **file** (`~/.lnrelay/cooldown.json`), not process state, because a CLI is a swarm
of short-lived processes and an in-memory breaker protects nothing. Every entry point — CLI dispatch
and the MCP shim's `getEngine()` — checks it first and returns `COOLDOWN_ACTIVE` without touching the
network. R4's constraint says "fail loudly rather than retry-hammer"; I am making it stricter: fail
loudly *and refuse to try again for hours, across every process*.

**What must be discovered empirically before any engine code (R3 "biggest unknowns"):** current 2026
queryIds and their rotation cadence (#1); whether raw HTTP works at all (#2); `li_at` lifetime and
the minimal required cookie set (#4); which modern anti-bot headers are load-bearing (#5); real
Voyager throttle thresholds (#6). All of it is P0. **What we can build now on documented facts:** the
envelope, the budget ledger, the Rest.li codec, the URN graph resolver, `entry.ts` (ported verbatim
per R5 §1), `doctor --offline`, and the whole cache layer.

`docs/ENGINE-RESEARCH.md` adopts mguttmann's ✅ verified / 🔍 discovered / 🔩 inferred provenance
markers per endpoint from day one (R1 "what to steal" #1), and **a 🔩-tagged endpoint may not back a
shipped command.**

---

## 3. The parser

LinkedIn's `{data, included[]}` model (R3 §4) is not X's `instructions[]→entries[]` — it is a graph
with a side-table, and the failure modes differ. Four rules:

**1. Index first, resolve second.** Build `Map<entityUrn, node>` from `included[]` in one pass, then
walk `data`'s `*`-prefixed reference keys against it. R3 §4 explicitly flags that the reference
implementation does an O(n·m) substring scan (`urn in post["url"]`) and tells us not to re-derive the
lesson the hard way.

**2. Filter by EXCLUSION, and *report* the unknowns.** R5 §6b carries over undiluted, strengthened.
x-relay's exclusion list includes unrecognized entries silently — right, but it leaves drift
discoverable only by someone counting. Here:

```ts
// Drop known chrome/noise. EVERYTHING ELSE PASSES THROUGH — a $type we have never
// seen arrives as data, not as silence. Unrecognised types are ALSO counted into
// meta.unknownTypes so drift is visible in the envelope, not just to whoever counts.
const DROP_TYPE_FRAGMENTS = [
  'Promoted', 'AdUnit', 'Sponsored',
  'PeopleYouMayKnow', 'RecommendedEntity', 'DiscoveryEntity',
  'FeedDiscoveryModule', 'PromptComponent', 'CarouselComponent',
];
```

`meta.unknownTypes` makes R5 §9.4's "instrument the counting" lesson a permanent production feature
rather than a dev-time ritual. An agent seeing `unknownTypes: [{type:'FeedUpdateV3', count:41}]` knows
the parser is behind LinkedIn, on the first response after their deploy.

**3. Namespace-collapse `fs_*` / `fsd_*` / `fs_miniProfile`.** R3 §4 documents three coexisting
profile URN forms mid-migration and the reference implementation string-replacing between them. This
is exactly X's `core`/`legacy` split that cost x-relay real data (R5 §6b). A single
`canonicalUrn(urn)` collapses namespace variants to one identity, and every field read is
`dash?.field ?? legacy?.field`. Composite URNs (`urn:li:fs_updateV2:(<inner>,GROUP_FEED,EMPTY,...)`)
get a real paren-aware tuple parser, not `split("(")[1].split(",")[0]` — the reference impl's version
breaks on nested parens, which R3 §4 shows do occur.

**4. Three-state resolution — the sharpest idea here.** R3 §4 documents that LinkedIn's official API
returns `owner!` with an embedded error when a sub-expansion independently 429s while the parent
returns 200. Voyager's analogue is silent: a URN referenced from `data` that is simply absent from
`included[]`. Those cases must never collapse:

| state | meaning | representation |
|---|---|---|
| field not referenced at all | genuinely no such data | field absent |
| referenced **and** resolved | real data | field populated |
| referenced but **unresolvable** | the decoration failed — a **failed fetch** | `meta.unresolved[]` entry + `partial: true` |

At the whole-response level: `data` carries references but `included` is empty ⇒ **not an empty
result** ⇒ `SCHEMA_DRIFT`. This is R5's "an empty array is indistinguishable from a failed fetch"
lesson in LinkedIn's specific shape, and unlike the queryId question it needs no live capture to build.

Plus the family's supporting rules unchanged: per-item fault isolation, per-page dedupe by canonical
URN, `findDict`-style deep-search by key rather than hardcoded paths, and tolerance of a few
consecutive empty pages before declaring exhaustion.

---

## 4. Cache and incremental sync

**The watermark pattern does not transfer, and I will not force it.** R5 §5 invites exactly this
answer. LinkedIn has no snowflake ids; pagination is either `start`/`count` offsets or an opaque
`paginationToken` (R3 §2); and the connections "list" is a *search query*, not a chronological feed
(R3 §3). Per source:

| source | ordering reality | sync design |
|---|---|---|
| **own posts** | `profileUpdatesV2`, newest-first — but **pinned posts sort to position 0** | timestamp watermark on `postedAt`, with a **2-page slack**: do not break on the first fully-stale page, break on the second consecutive one. A naive first-page break terminates instantly against a pinned 2019 post. |
| **connections** | a filtered people-search — **no monotonic ordering at all** | **snapshot diff.** Full enumeration, stored as a set of `{urn, name, headline, firstSeenAt}`. Each run emits `{added[], removed[]}`. Refuses to run more than once per 7 days without `--force` — this is the single most expensive read in the tool and its data changes slowly. |
| **saved items** | endpoint `[unverified]` (R3 §3) | not designed. P0 discovery. |
| **everything else** (profiles, threads, reactors) | n/a | **not cached by default at all.** |

That last row matters most. **Third-party research reads are ephemeral by default** — returned to the
agent, never written to disk unless the user passes `--cache`. R4 §6.5 asks for minimization and
time-boxing; non-persistence-by-default is stronger than either.

When third-party data *is* cached it lands in `~/.lnrelay/third-party/` with `firstSeenAt` and a
**30-day TTL**, and **the TTL sweep runs on the read path, not on a schedule.** Every `loadCache()`
deletes expired records before returning — no cron to forget, no purge command to remember; retention
is enforced by the only code path that can observe the data. `lnrelay purge --third-party --confirm`
is the explicit escape hatch; `--all` nukes own-content too. `~/.lnrelay/own/` has no TTL.

Mutable-metrics policy, as R5 §5.7 demands it be stated: **refresh the head, freeze the body.**
Reaction/comment counts on cached own-posts refresh for the newest 30 days each sync; older records
keep their captured counts and carry `metricsAsOf`.

Store mechanics port from `x-relay/src/cache/store.ts`: load-never-throws, atomic `.tmp`+`rename`
writes, keyed by canonical URN so dedupe is structural.

---

## 5. Safety architecture — constraints as types

R4's constraints go into the type system and control flow. Six mechanisms:

**1. The permit type.** The Voyager client cannot be called without a spent budget permit:

```ts
type Permit = { readonly __brand: 'Permit'; class: SpendClass; issuedAt: number };
function spend(ledger: Ledger, c: SpendClass): Permit | BudgetError;  // the ONLY producer
client.get(op: OpName, req: BuiltRequest, permit: Permit): Promise<ClientResult>;
```

`Permit` has no public constructor. "Make a network call without accounting for it" is a compile
error, not a review norm. The ledger is `~/.lnrelay/budget.json` — **on disk, shared across
processes**, rolling per-class windows.

**2. Numbers with provenance, and honest ones.** R2 §2 is explicit that the corpus contains no
corroborated ceilings and warns against encoding invented precision. Every cap carries
`provenance: 'guessed' | 'vendor-lore' | 'measured'`, and `lnrelay budget` prints it. Starting values
adopt R1's concrete defaults from `jjuanrivvera/linkedin-cli` rather than inventing our own:

| class | default cap | provenance |
|---|---|---|
| profile fetch | 30 / day | vendor-lore (R1: jjuanrivvera's job-detail cap, transplanted) |
| search query | 25 / day | guessed |
| thread/feed page | 60 / day | guessed |
| connection request | **15 / day** | vendor-lore (R2 §2: ~20/day cited, we sit under it) |
| any write | 20 / day, 1 / 90s | guessed |
| global | 250 requests / day, 3–15s jittered gap, 1 in flight | R1 |

**Reads are paced as conservatively as writes.** R2 §2 calls this "the single most actionable
qualitative finding": multiple restriction reports involve *zero automation and zero writes* — fast
manual browsing alone (`@tekbog`, 2026-05-28). A design that paces only writes is designing against
the wrong threat model.

**3. Cross-process circuit breaker** (§2). Cooldown file checked before anything.

**4. Confirmation on every write, not just destructive ones.** R4's constraint says every write, and a
connection request is socially irreversible even where technically withdrawable. `--confirm` absent ⇒
`CONFIRMATION_REQUIRED`, **zero network calls** (R5 §3). Writes are absent from the MCP tool registry
entirely — not disabled, not gated: not registered.

**5. Risk legible at the moment of risk.** Every read envelope carries `meta.budget`; when
`remaining/cap < 0.25` a `budget.warning` appears and the MCP tool descriptions instruct the agent to
surface it and stop. `doctor` prints cooldown state, cookie age, UA age, and third-party record count.
The first write of any kind requires a one-time `lnrelay acknowledge-risk --confirm` that prints the
ToS §8.2 breach statement.

**6. Single-session by construction.** No account parameter exists anywhere — not in config, not in
the cache path, not in the engine factory. Multi-account is not disallowed; it is unrepresentable.
Docs state plainly that this **breaches LinkedIn User Agreement §8.2(2) and §8.2(13)** (R4, verbatim
clauses) and never claim compliance.

---

## 6. MCP surface and skill

Read-only subset, thin shim, shared runners, lazy single Engine, compact-by-default (R5 §4). Writes
and cache-writes absent. The shim refuses to serve any tool while a cooldown is active, returning one
explanatory error. Tool descriptions carry three teaching contracts:

> **`post`** — "A LinkedIn post plus its full comment thread. Expensive: follows LinkedIn's
> `paginationToken` across pages up to `limit` (default 40) and spends ~1 thread-page unit per page
> from your daily budget. **Always check three things.** (1) `returnedCount` vs `claimedCount`: if
> `claimedCount > 0` and `returnedCount === 0`, LinkedIn handed back nothing despite the post
> claiming comments — that is a **failed fetch, not an empty thread**; report it as a failure, do not
> tell the user the post has no comments. (2) `meta.partial`/`meta.unresolved`: some referenced
> objects did not resolve — the record you got is incomplete, not complete-and-small. (3)
> `meta.budget.remaining`: if it is low, stop and tell the user rather than continuing to research.
> Comments with `hasReplies: true, replies: null` have nested replies this tool cannot read — say so
> rather than treating the comment as childless."

The general rule (R5 §4): any tool whose platform can return well-formed-but-empty on failure states
the distinguishing check in its own description, because the agent reads tool metadata before it ever
sees a response.

`SKILL.md` is hand-written prose baked into `src/generated/skill.ts` by the family's trivial
generator. **I add the mechanical check R5 §2 admits is missing**: a test asserting every name in
`COMMANDS` appears in `SKILL.md` and every command-shaped heading in `SKILL.md` appears in `COMMANDS`.
R5 is candid that drift prevention today is "social/process, not mechanical" — that gap is a ten-line
test.

---

## 7. Build order

**Riskiest assumption in the whole design: raw HTTP + cookies still reaches Voyager in mid-2026**
(R3 unknown #2). Cheapest test, in phase 0, before one line of repo code:

> A ~50-line throwaway script. CDP-mint cookies from a real Chrome profile → issue exactly three
> requests, ≥15s apart: `GET /voyager/api/me`; one `profileView`; one `graphql` search with a queryId
> scraped live from the loaded web bundle. Print status codes; dump raw bodies to `fixtures/`.
> **One day, three requests, the entire architecture standing or falling on it.**

| phase | ends in something working | gates |
|---|---|---|
| **P0 — capture spike** | 3 raw fixtures + `ENGINE-RESEARCH.md` with ✅/🔍/🔩 tags; queryIds re-scraped daily for 14 days to measure rotation cadence | **kill gate** (§8) |
| **P1 — skeleton** | `lnrelay doctor --offline` and `lnrelay budget` green on a real machine. Envelope, exit codes, ledger, cooldown, `entry.ts` ported verbatim, Rest.li codec with tests. Zero network commands. | — |
| **P2 — first read** | `lnrelay whoami` + `lnrelay profile <me>` against live LinkedIn. Parser built fixture-first, with the counting assertion: *"this fixture contains N content-bearing nodes; the parser emits N"* (R5 §9.4). | account healthy after 1 week |
| **P3 — research surface** | `search`, `post`, `feed`, `company`, `reactions`, `job`, `batch`. This is the product. | account healthy after 2 weeks |
| **P4 — cache** | `my-posts --sync`, `connections --sync/--diff`, TTL sweep, `purge`. | — |
| **P5 — agent surface** | MCP shim + `SKILL.md` + generated-skill snapshot + registry↔skill parity test. | — |
| **P6 — writes** | OAuth app + `share`/`comment`/`react`; then Voyager `connect`/`follow`/`invitations`. | everything above stable |

**Writes come last, deliberately** — inverting the natural order. Writes carry the enforcement risk
(R2 §3), so we want weeks of observed read behavior on a healthy account before adding a second,
riskier traffic class.

---

## 8. Kill criteria

1. **P0 spike returns 999 or a challenge from the user's own residential IP with fresh cookies.**
   Raw HTTP is dead; the honest fallback is a thin wrapper around `stickerdaniel/linkedin-mcp-server`,
   which is a different and worse project. **Abandon rather than pivot to browser automation** — a
   Patchright hot path is a permanently rotting dependency (R1 §avoid #3: the stealth-plugin category
   was deprecated Feb 2025 and detection has moved on since).
2. **queryIds rotate faster than weekly** (measured in P0's 14-day diff). A tool needing a manual
   ops-config refresh every few days is unmaintainable by one person → rescope hard to the REST.li-only
   subset (`profileView`, `/feed/comments`, `/feed/updatesV2`, reactions all have non-GraphQL paths per
   R3 §3), dropping `search` entirely.
3. **Any challenge, restriction, or force-logout on the user's account during P0–P3 at our stated
   pacing.** Stop. Do **not** halve the caps and try again. One challenge at deliberately conservative
   pacing means detection is behavioral in a way we cannot model (R2 §3), and R4 §3's blast radius —
   years of connections, endorsements, and the primary channel recruiters use — does not justify a
   second attempt on a hypothesis we have no way to test safely.
4. **LinkedIn ships any self-serve read scope.** Delete the Voyager engine that afternoon.
5. **The honest one.** If the user's LinkedIn account is materially load-bearing for their income
   *right now*, the correct answer is not to run this at all. R4 §3's asymmetry is the strongest fact
   in the entire research set, and it argues against the project on its own terms. This belongs in the
   README's first paragraph, not in a footnote.

---

## Where I dissent

**1. Against the brief: "account management" mostly does not belong in this tool.** CONTEXT.md lists
post/comment/react/connect/message/follow as intended surface. I cut messaging entirely and think
`connect`/`follow` are marginal. R3 §6 establishes that the read half has **zero** legitimate
alternative — no self-serve scope, partner programs structurally closed to individuals (R4 §5) — so
its ToS and ban risk buys something irreplaceable. The write half is either officially available
(`w_member_social`) or is a four-second UI action. **Paying professional-identity risk for
convenience on writes is a bad trade**, and it is the one place where "x-relay has it, so
linkedin-relay should" is the wrong instinct.

**2. Against the family pattern: retry budgets are wrong here.** x-relay retries 429 three times
(`client.ts:165-181`) — correct on a platform where the worst case is a temporary block. LinkedIn's
escalation ladder (R2 §1, R4 §3) means retrying into a throttle is the mechanism by which a warning
becomes a restriction. Zero retries plus a cross-process file-based breaker. The family's transport
doctrine is optimized against the wrong loss function for this platform, and this is a MUST I am
consciously breaking with a stated reason.

**3. Against R5 §5: "substitute a timestamp watermark" is not enough.** Right instinct, insufficient
in two ways R5 does not anticipate: LinkedIn **pins posts to position 0**, so a first-stale-page break
terminates a sync instantly against a pinned old post (hence the 2-page slack); and for connections
the ordering does not exist at all, so only a snapshot-diff works. R5 asks for this to be confronted
rather than papered over — I confront it by saying the pattern transfers to one of three sources.

**4. Against R4's framing: "single-account personal use" reduces *legal* risk far less than implied.**
R4 §2 is correct that no individual has been sued, but R3 §5 carries the Proxycurl founder's own
primary-source lesson: merely holding an account was the contractual hook, and *"legal does not mean
safe."* Our actual protection is that we are not economically worth suing — an economics fact, not a
design property. **The design should not take credit for it.** What the design genuinely controls is
account-ban risk, a different and more tractable objective. The docs should say so rather than letting
"personal use" do rhetorical work it cannot support.

**5. Against R5 §2: the generated-skill mechanism is not actually drift-proof, and R5 says so.**
The generator bakes Markdown into a string; drift prevention is social. On a tool where an agent
hallucinating a flag can cost an account, that gap deserves the ten-line registry↔SKILL.md parity
test in §6.

---

## Falsifiable assumptions

| # | assumption | what would disprove it |
|---|---|---|
| 1 | Raw HTTP + cookies reaches Voyager in 2026 | P0's `GET /voyager/api/me` returns 999, a login redirect, or a challenge page from a residential IP with fresh cookies |
| 2 | queryIds are stable enough for a solo maintainer | the 14-day daily bundle diff shows any needed queryId changing more than once a week |
| 3 | Conservative pacing (250 req/day, 3–15s jitter) is below the detection floor | any challenge, force-logout, or restriction on the account during P0–P3 |
| 4 | `w_member_social` can post, comment, and react without partner review | the self-serve Products tab rejects the grant, or the scope's write calls 403 for comment/react specifically |
| 5 | `included[]`-empty-while-`data`-references is a reliable drift signal | a P0 fixture shows a *legitimately* empty result that also carries dangling `data` references |
| 6 | Own-posts ordering is recency-monotonic modulo pinning | a P0 capture of `profileUpdatesV2` shows non-pinned posts out of chronological order |
| 7 | Reads carry materially lower ban risk than writes | a restriction arrives during P2–P3, i.e. before any write command exists |
| 8 | The 30-day third-party TTL is not user-hostile | the user routinely re-fetches the same profiles and hits the budget cap because of expiry |

Assumptions 1 and 3 are the load-bearing ones. Both are tested in the first two weeks, and both have
"stop the project" as their documented failure branch.
