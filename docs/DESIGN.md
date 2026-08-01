# linkedin-relay — design

**Status:** converged design, pre-implementation. Ratified 2026-08-01 by a three-model panel
(GPT-5.6-Sol, Grok-4.5, Fable 5) over five research lanes. Nothing here is built yet, and by design
nothing may be built until the Phase 0 gate passes.

> A CLI (`lnrelay`) + thin read-only MCP shim (`linkedin-relay-mcp`) + generated Claude Code skill,
> for **one person doing deep research from their own LinkedIn account.** Bun/TypeScript, in the shape
> of `x-relay` / `github-relay` / `youtube-context`.

---

## 0. The one-paragraph thesis

The **read** half of this tool has no legitimate substitute and therefore earns its risk: LinkedIn
offers an individual developer *zero* sanctioned read access — no search, no profile, no thread, no
feed — and its partner programs are structurally closed to people who are not incorporated companies
(R3 §6, R4 §5). The **write** half mostly does have a substitute, so it should not be paid for in the
same currency: `share`, `comment` and `react` go over LinkedIn's own self-serve OAuth scope, and every
other write is cut. The scarce resource this design spends is not developer time — it is the user's
professional identity, which unlike an X account cannot be re-registered. Every decision below is an
allocation of that budget.

## 1. Naming

Per the family formula (R5 §8): repo `linkedin-relay` · CLI bin `lnrelay` · npm package + MCP bin
`linkedin-relay-mcp` · cache `~/.lnrelay` · env `LNRELAY_CACHE_DIR`. Verify the npm name is free and
date-stamp the check before first publish.

---

## 2. Command surface

**Fifteen commands, not twenty-nine.** Smallness is a safety property here, not a scoping compromise:
every command is a distinct traffic signature that must be independently paced, and R2 §2 established
that we have *no* corroborated numeric envelope to pace it against. A command an agent cannot use
safely is a liability.

### Reads — Voyager, all exposed over MCP

| command | usage | cost | grounding |
|---|---|---|---|
| `whoami` | `lnrelay whoami` | 1 call | `/voyager/api/me`, verified |
| `search` | `search people\|companies\|jobs <q> [--filters] [--limit]` | 1–3 | `voyagerSearchDashClusters` (R3 §3) |
| `profile` | `profile <public-id\|urn> [--sections ...]` | 1 (+1/section) | `profileView` verified; dash fan-out via `voyagerIdentityDashProfileComponents` |
| `company` | `company <universal-name> [--updates]` | 1–2 | R3 §3 |
| `post` | `post <activity-urn\|url> [--limit]` — the post **and** its comment thread, cursor-followed | expensive | `/feed/comments` + `paginationToken` |
| `reactions` | `reactions <activity-urn> [--limit]` | medium | `voyagerSocialDashReactions`; aggregate-only by default |
| `feed` | `feed [--limit]` | medium | `feed/updatesV2?q=chronFeed` |
| `job` | `job <job-id>` | 1 | R3 §3 |
| `connections` | `connections [-q] [--sync] [--diff]` — cache-backed | cheap / expensive on `--sync` | connections is a *filtered people-search*, not a list |
| `my-posts` | `my-posts [-q] [--sync]` — cache-backed | cheap / medium | `identity/profileUpdatesV2` |
| `local` | `local <query> [--source ...] [--since]` | free | offline FTS over the cache; the default research path after sync |

### Local / meta

| command | purpose |
|---|---|
| `doctor` | `[--offline]` — setup diagnosis. Always `ok:true` at envelope level; checks isolated and time-boxed; reports cookie **presence and length, never values**; surfaces cooldown state, cookie age, UA age, cache size and third-party record count. |
| `budget` | Current spend ledger per class, with each cap's `provenance`. `--reset-cooldown --confirm` is the only way to clear a challenge lock. |
| `risk` | Pre-flight breaker/risk state. Exposed over MCP so an agent can check *before* spending. |
| `purge` | `[--third-party\|--all] --confirm` — local deletion, never touches LinkedIn. |

### Writes — OAuth only, CLI only, never MCP

| command | transport |
|---|---|
| `share "<text>"` | official OAuth `w_member_social` |
| `comment <urn> "<text>"` | official OAuth |
| `react <urn> [--type LIKE\|PRAISE\|...]` / `unreact` | official OAuth — `unreact` ships **only** if live verification confirms the scope covers it |

`w_member_social` is self-serve: no partner review, no company verification, no screencast (R3 §6,
verified against LinkedIn's own docs). These three writes are **structurally incapable** of travelling
over Voyager — the Voyager client type exposes no method for them. If OAuth cannot perform an
operation, that command is omitted rather than silently falling back.

**Caveat that must survive into the docs:** OAuth makes these writes *sanctioned and materially lower
risk*. It does **not** make the surrounding tool ToS-compliant, and scopes, review rules and schemas
can still change.

### Cut from v1 — with reasons, not deferrals

| cut | why |
|---|---|
| `connect` / `withdraw` / `follow` / `invitations` | No official path exists — which is an argument for **not shipping**, not for routing through the hostile channel. These are the actions R4's Professional Community Policies name as artificial-engagement vectors and where R2's adverse reports cluster. `follow` is a four-second UI action; it earns nothing. |
| `message` / `inbox` / `conversation` | The incumbent's own tracker shows `send_message` double-firing and replying into the wrong thread (R1 #573, #483) — an agent bug here is unrecoverable and visible to a third party. Reading an inbox means holding **other people's private messages** on disk, the worst-shaped data under R4 §4. "CLI-only" is not a protection in this family: the agent has Bash. |
| `notifications`, `saved` | Endpoints `[unverified]` (R3 §3). Designing against them now would be fiction. P0 discovery tasks. |
| Nested comment replies | Unsolved industry-wide (R1 open question). We do not fake it: a comment returns `{hasReplies: true, replies: null, warning: 'nested-replies-unsupported'}` — **never an empty array that reads as "no replies."** |
| Anything SDUI (profile edit, comment delete) | Needs a visible non-headless Chrome (R1). Cutting it is what keeps the hot path browserless. |
| `batch` | See §8. Cut from v1; re-openable post-gate under stated constraints. |
| Contact-info extraction | Unnecessary personal-data expansion. |

**Roadmap discipline:** a cut is a cut. "Deferred to phase 3+" is a roadmap promise, and roadmap
promises get built. The only named door is `connect`/`follow`, reconsiderable after a full quarter of
clean read-only operation. `message` and invitation-accept are never reconsidered.

---

## 3. Engine

**Transport: browserless raw HTTP to Voyager. A real browser is used only to mint cookies, never in
the hot path.**

R3 called this the highest-leverage open question. The evidence: two independent repos still doing
browserless Voyager successfully in 2026 (`mguttmann/linkedin-internal-api`, pushed 2026-07-31, 130
endpoints, pure `requests`; `jjuanrivvera/linkedin-cli`, 2026-07-30), against one prominent
abstention — `stickerdaniel/linkedin-mcp-server`, whose README gives a **stated legal posture**
("doesn't exploit undocumented APIs"), not a demonstrated technical wall. Two implementations beat one
abstention. **This is the riskiest bet in the design and Phase 0 exists to falsify it.**

```
src/engine/
  auth.ts        cookies → headers
  restli.ts      Rest.li 2.0 variables grammar — pure codec, unit-tested, zero network
  contracts/     versioned OperationContract data: queryIds, decorationIds, header set, UA
  scheduler.ts   permits, jitter, single-flight
  classify.ts    response → outcome, before parsing
  client.ts      request driver
  parse/         included[] index, URN resolution, exclusion filters
  oauth-write.ts the only write transport
  index.ts       Engine interface + createEngine()
```

### Auth

Cookie bootstrap steals mguttmann's CDP flow: launch Chrome with a persistent profile, navigate to
`/feed/` **specifically because that is what sets `JSESSIONID`**, pull via `Network.getAllCookies`.
The auth surface is exactly two cookies — `li_at` + `JSESSIONID` — with
`csrf-token: JSESSIONID.replace(/"/g, '')`, a derivation rather than a separate secret (R3 §1,
verified).

`li_at` is effectively a session bearer credential. It goes into **OS credential storage**, bound to
the observed owner URN — not an env var (leaks through process launch config and debugging) and not a
plain JSON file (too easy to copy, back up, or attach to a support report). Only non-secret metadata
lives in the cache directory.

Everything R3 tagged `[unverified — cargo-cult candidates]` (`x-li-track`, `x-li-page-instance`,
`x-li-deviceId`, `li_rm`, `bcookie`) is **not sent** in v1. The one primary source we have has
`x-li-track` commented out. Send nothing you cannot justify: an unexplained header is as likely to be
a fingerprint mismatch as a fix.

The User-Agent is **config with a `capturedAt` date**, never a hardcoded literal — R3 §5 has direct
evidence that a stale UA measurably raises challenge rate. Never copy the Chrome 83 string from the
2024 reference client. `doctor` warns when the UA is over 90 days old.

### Operation contracts — provenance that compiles

Query IDs rotate with LinkedIn's web-client build, structurally like X's query hashes. They live in
versioned data, never in request logic:

```ts
type OperationContract = {
  name: string;
  transport: 'voyager-restli' | 'voyager-graphql' | 'oauth';
  path: string;
  queryId?: string;
  decorationId?: string;
  variablesSchema: JsonSchema;
  responseFingerprints: string[];
  provenance: 'verified' | 'discovered' | 'inferred';
  capturedAt: string;
};
```

**Only `verified` contracts compile into the public registry.** A `discovered` or `inferred` endpoint
may not back a shipped command — enforced as a build artifact, not a documentation convention that
depends on whoever remembers. A developer-only redaction/import script updates contracts from a HAR;
it is not a user command.

### Resilience — zero automatic retry, and a breaker that outlives the process

**This is a deliberate, reasoned break with the family.** `x-relay` retries 429 up to three times
(`client.ts:165-181`). That is correct on X, where the worst case is a temporary block. On LinkedIn
the 429 is the warning shot on a documented escalation ladder, and retrying into a throttle is the
mechanism by which a warning becomes a restriction.

| response | policy |
|---|---|
| `429` | **zero retries.** `RATE_LIMITED` + 1-hour cooldown. `retryAfterMs` is information printed for a human, never permission for the process. |
| HTTP `999` Request Denied | `REQUEST_DENIED` + **6-hour** cooldown. A network-layer bot block that lifts as traffic normalises — so the only correct response is to stop generating traffic. |
| challenge / checkpoint / login redirect | `CHALLENGE_DETECTED` + **indefinite** cooldown, cleared only by `lnrelay budget --reset-cooldown --confirm` after the user has logged in through a real browser. |
| `401`/`403`, or a 302 loop to login | `AUTH_FAILED`, terminal. The 302-loop-on-`/me` signature means **expired cookies, not detection** — the hint says exactly that, so the user does not panic-diagnose fingerprinting. |
| `200` + `data` referencing URNs but `included: []` | `SCHEMA_DRIFT` — see §4. |
| `400` naming an unknown queryId | `SCHEMA_DRIFT`, hint: "re-capture contracts from a logged-in browser." |
| network timeout, no response received | one retry, idempotent reads only. |

The cooldown is a **file** (`~/.lnrelay/cooldown.json`), not process state, because a CLI is a swarm
of short-lived processes and an in-memory breaker protects nothing. Both entry points — CLI dispatch
and the MCP shim's `getEngine()` — check it first and return `COOLDOWN_ACTIVE` without touching the
network. A transport that sleeps and retries would consume the signal before the breaker ever saw it.

### Build now vs. discover first

| Buildable now, on verified facts | Must be captured before engine code freezes |
|---|---|
| Envelope, error codes, exit codes | 2026 queryIds and their rotation cadence |
| Rest.li codec + tests | Whether raw HTTP still reaches Voyager at all |
| URN graph resolver and exclusion parser | `li_at` lifetime; the minimal required cookie set |
| Permit ledger, cooldown file, `doctor --offline` | Which modern anti-bot headers are load-bearing |
| Whole cache layer | Real Voyager throttle thresholds |
| `entry.ts`, ported verbatim (R5 §1) | `saved` / `notifications` endpoints |

---

## 4. Parser

LinkedIn's `{data, included[]}` is a **graph with a side-table**, not X's `instructions[]→entries[]`.
Four rules.

**1. Index first, resolve second.** Build `Map<entityUrn, node>` from `included[]` in one pass, then
walk `data`'s `*`-prefixed reference keys against it, preserving `data`'s ordering. The reference
implementation does an O(n·m) substring scan; R3 §4 tells us not to re-derive that lesson.

**2. Filter by exclusion, and *report* the unknowns.** The family's hardest-won rule (R5 §6b) carries
over undiluted — an accept-list cost x-relay every reply in every thread and 34 of 77 posts per feed
page, both invisible behind `ok:true` — but strengthened:

```ts
// Drop known chrome/noise. EVERYTHING ELSE PASSES THROUGH — a $type we have never seen
// arrives as data, not as silence. Unrecognised types are ALSO counted into
// meta.unknownTypes so drift is visible in the envelope, not only to whoever counts.
const DROP_TYPE_FRAGMENTS = [
  'Promoted', 'AdUnit', 'Sponsored',
  'PeopleYouMayKnow', 'RecommendedEntity', 'DiscoveryEntity',
  'FeedDiscoveryModule', 'PromptComponent', 'CarouselComponent',
];
```

An agent seeing `unknownTypes: [{type: 'FeedUpdateV3', count: 41}]` knows the parser is behind
LinkedIn on the first response after a deploy — instead of six months later when someone counts.

**3. Collapse the namespace migration.** `fs_miniProfile` / `fs_profile` / `fsd_profile` coexist
mid-migration (R3 §4) — exactly the `core`/`legacy` split that cost x-relay real data. A single
`canonicalUrn()` collapses variants to one identity; every field read is `dash?.f ?? legacy?.f`.
Composite URNs (`urn:li:fs_updateV2:(<inner>,GROUP_FEED,...)`) get a real paren-aware tuple parser —
the reference implementation's `split("(")[1].split(",")[0]` breaks on nested parens, which do occur.

**4. Three-state resolution.** A URN referenced from `data` but absent from `included[]` is a **failed
decoration**, not "no data". These must never collapse:

| state | meaning | representation |
|---|---|---|
| not referenced at all | genuinely no such data | field absent |
| referenced and resolved | real data | field populated |
| referenced but unresolvable | **failed fetch** | `meta.unresolved[]` + `partial: true` |

And at whole-response level: `data` carries references while `included` is empty ⇒ **not an empty
result** ⇒ `SCHEMA_DRIFT`. This is our analogue of x-relay's `(336) features cannot be null`, and
unlike the queryId question it is buildable now with no live capture.

Plus: per-item fault isolation, per-page dedupe by canonical URN, `findDict`-style deep search rather
than hardcoded paths, and a fixture test asserting
`rawCandidateCount === parsedCount + deliberatelyExcluded + unknownCount`.

### Every collection payload carries

```ts
type FetchMeta = {
  state: 'complete' | 'partial' | 'unknown';   // required — never an optional boolean
  operation: string;
  contractCapturedAt: string;
  rawCandidateCount: number;
  parsedCount: number;
  unknownCount: number;
  returnedCount?: number;
  claimedCount?: number;
  truncated?: boolean;
  unresolved?: { urn: string; referencedBy: string }[];
  unknownTypes?: { type: string; count: number }[];
  budget: { class: string; spentInWindow: number; cap: number; remaining: number;
            capProvenance: 'guessed' | 'vendor-lore' | 'measured' };
  warnings: string[];
};
```

`state: 'unknown'` is a real and common condition — we followed cursors and cannot prove exhaustion.
An *optional* boolean would silently default to the reassuring answer when absent, which is the same
class of bug as the accept-list.

A genuine empty result is `ok:true`, `items:[]`, `state:'complete'`. Auth failure, challenge,
restriction, drift, or `claimedCount > 0 && returnedCount === 0` is `ok:false` — **never an empty
success.**

---

## 5. Cache and sync

**SQLite** (`bun:sqlite`, WAL, plain numbered SQL migrations, no ORM), behind the same narrow
`load/save/upsert/query` interface the family's JSON store exposes. The family similarity that matters
is the interface, not the file format. What decides it is §5.2: SQLite makes "corrupt" a detectable,
per-source, quarantinable state rather than an all-or-nothing blob, and makes TTL expiry a
transactional delete rather than a rewrite of the whole file. JSON remains right for small replaceable
files like the cooldown.

### 5.1 What is cached

| source | cached? |
|---|---|
| the user's own posts | yes, no TTL — it is their data |
| direct connections | yes — the user's own graph |
| **third-party research reads** (profiles, threads, reactors) | **no, by default** |

Non-persistence by default is stronger than either minimisation or time-boxing. Third-party data is
returned to the agent and never written to disk unless the user passes `--retain`. When retained, it
lands with a `firstSeenAt` and a **30-day TTL**, and the sweep runs **on the read path** — every
`load()` deletes expired rows before returning. No cron to forget, no purge command to remember.

On expiry, the **body** dies but an identity stub survives (`urn`, `publicId`, `capturedAt`,
`expiredAt`). No personal data persists, and re-fetching becomes a *visible choice* — the budget can
say "14 of these 20 profiles are re-fetches of expired records" instead of quietly charging for them.

### 5.2 Corrupt cache — never-throw is not never-fail

The family rule survives on the read path: a corrupt store must not crash the process. What dies is
**degrading to an empty success.** On this platform an empty cache is operationally active — it is
precisely what triggers the largest possible sync against the most hostile host. A disk error must not
become a restriction-shaped traffic spike.

Corrupt store → quarantine to `~/.lnrelay/quarantine/<ts>/`, return `CACHE_CORRUPT` (`ok:false`),
refuse all sync paths until the user purges or acknowledges, and make **zero** network requests
automatically. An empty result and a lost result must be distinguishable on disk for exactly the same
reason they must be distinguishable in a parse.

### 5.3 Watermarks — the pattern transfers to one source of three

| source | ordering reality | sync design |
|---|---|---|
| own posts | newest-first — **but pinned posts sort to position 0** | timestamp watermark on `postedAt` with a **2-page slack**: break on the second consecutive fully-stale page, never the first. A naive break terminates instantly against a pinned 2019 post. |
| connections | a filtered people-search — **no monotonic ordering at all** | **snapshot diff.** Full enumeration stored as `{urn, name, headline, firstSeenAt}`; each run emits `{added[], removed[]}`. Refuses to run more than once per 7 days without `--force`. |
| saved items | endpoint unverified | not designed. P0 discovery. |

Checkpoints are compound — `{lastSuccessfulAt, headIds[], newestCreatedAt?, endpointRevision}` — not a
scalar timestamp pretending to be a snowflake. Cursors never survive a run. Where ordering cannot be
established, the checkpoint state is honestly `snapshot-partial`, never a fabricated watermark.

**Mutable metrics: refresh the head, freeze the body.** Reaction/comment counts refresh for the newest
30 days on each sync; older records keep their captured values and carry `metricsAsOf`.

---

## 6. Safety architecture — constraints as types

**1. The permit type.** The Voyager client cannot be called without a spent budget permit:

```ts
type Permit = { readonly __brand: 'Permit'; class: SpendClass; issuedAt: number };
function spend(ledger: Ledger, c: SpendClass): Permit | BudgetError;   // the ONLY producer
client.get(op: OpName, req: BuiltRequest, permit: Permit): Promise<ClientResult>;
```

`Permit` has no public constructor: "make a network call without accounting for it" is a compile
error, not a code-review norm. The ledger is on disk and updated atomically, shared across processes.
**Redirects, pagination continuations and contract-discovery calls all consume permits** — otherwise
the most easily forgotten traffic escapes accounting entirely.

**2. Honest numbers.** R2 found no corroborated ceilings and warned explicitly against inventing
precision, so every cap carries its provenance and `lnrelay budget` prints it:

| class | default cap | provenance |
|---|---|---|
| profile detail | 30 / day | vendor-lore (R1: `jjuanrivvera`'s cap, transplanted) |
| search query | 25 / day | guessed |
| thread / feed page | 60 / day | guessed |
| any write | 10 / day, 1 per 90s | guessed, deliberately below R2's weak ~20/day lore |
| global | 250 req/day · 3–15s jittered gap · 1 in flight | R1 |

Users may lower these; raising them requires editing and rebuilding the source. Manual browser
activity is unknowable, so every command reports **tool** budget without implying total LinkedIn
activity.

**Reads are paced as conservatively as writes.** This is R2's single most actionable finding:
multiple restriction reports involve *zero automation and zero writes* — fast manual browsing alone
(@tekbog, 2026-05-28). A design that paces only writes is designing against the wrong threat model.

**3. Writes require a capability an agent cannot forge by string concatenation.** `--confirm` is not
human confirmation: in this family the agent *is* the process invoking the CLI, so `--confirm` is a
flag the acting party writes about its own action. It documents intent and obtains consent from
nobody.

Instead, **every write stops and asks the human, at the moment of the write, having first shown
exactly what it is about to do and what it risks.** Concretely:

```
$ lnrelay share "shipping something new today"

  ABOUT TO POST TO YOUR LINKEDIN FEED
  ───────────────────────────────────────────────────────────
  as       Tamás Gábor (urn:li:person:…)
  via      official OAuth (w_member_social)
  content  "shipping something new today"
  undo     deletable from the LinkedIn UI; the post may be seen first

  This automation breaches LinkedIn User Agreement §8.2 and can
  permanently restrict this account. 7 of 10 writes left today.

  Type 4f2a to confirm, anything else to abort:
```

The properties that make this a real boundary, not a formality:

- **No TTY, no write.** Run non-interactively — which is how an agent invokes the CLI — and it
  returns `CONFIRMATION_REQUIRED` having made **zero** network calls. This is the load-bearing
  property: an agent cannot complete a write, whatever arguments it composes.
- **A short token derived from the payload hash**, so `yes | lnrelay share …` fails. Four characters
  is enough to defeat a blind pipe without becoming friction that motivates an escape hatch.
- **Only the confirmation path can construct the unexported `ConfirmedWrite<T>`** the write engine
  accepts, so the guarantee lives in the type system rather than in a forgettable `if`.
- **No `--yes`, no env var, no config setting.** If the ritual ever proves intolerable, the right
  conclusion is that this tool should not write for that user — not that the boundary becomes
  optional.

*Stated honestly in the docs:* a TTY check is an **accident-prevention barrier, not proof of human
identity** — an agent with terminal control can allocate a pty. Its real value is moving circumvention
from *accidental* (append a flag) to *deliberate* (construct a pty and echo a payload-specific token).
Overclaiming unforgeability is how a guard stops being maintained.

*(The panel originally specified a heavier two-step form — a `WritePlan` written to disk, confirmed
later by a separate `lnrelay confirm <plan-id>` command with a 10-minute expiry. That was calibrated
for an irreplaceable account. Collapsed to one interactive step at the owner's direction; the
plan-file form is kept in `.orchestrate/panel/P1-codex.md` should the stakes ever change.)*

There is **no** `--yes`, env-var, or config escape hatch. If the ritual proves intolerable, the right
conclusion is that this tool should not perform writes for that user — not that the boundary becomes
optional.

*State this honestly in the docs:* a TTY check is an **accident-prevention barrier, not proof of human
identity** — an agent with terminal control can allocate a pty. Its real value is moving circumvention
from *accidental* (append a flag) to *deliberate and legible* (construct a pty, echo a plan-specific
phrase). Overclaiming unforgeability is how a guard stops being maintained.

**4. Single-account by construction.** No account parameter exists anywhere — not in config, not in
the cache path, not in the engine factory. Multi-account is not disallowed; it is *unrepresentable*.
The owner URN is sealed into credentials, cache, contracts and plans; a different `/me` opens the
circuit and requires `purge --all` before rebinding.

**5. Risk legible at the moment of risk.** Every read envelope carries `meta.budget`; below 25%
remaining a `budget.warning` appears and the MCP descriptions instruct the agent to surface it and
stop. First run of any write prints the ToS breach statement and requires a one-time
`lnrelay acknowledge-risk --confirm`. No CAPTCHA solving, restriction bypass, identity-verification
automation, proxy/VPN advice, or replacement-account guidance exists anywhere in the product.

---

## 7. MCP surface and skill

Read-only subset: `doctor`, `risk`, `whoami`, `search`, `profile`, `company`, `job`, `post`,
`reactions`, `feed`, `connections`, `my-posts`, `local`, `cache_status`. Writes and cache-writes are
**absent from the registry entirely** — not disabled, not gated: not registered. The shim validates
Zod args, calls shared runners, holds one lazy Engine, and refuses to serve any tool while a cooldown
is active. Compact by default.

Tool descriptions carry teaching contracts, because the agent reads metadata before it ever sees a
response:

> **`post`** — A LinkedIn post plus its full comment thread. Expensive: follows `paginationToken`
> across pages and spends ~1 thread-page unit per page. **Always check three things.** (1)
> `returnedCount` vs `claimedCount` — if `claimedCount > 0` and `returnedCount === 0`, LinkedIn
> returned nothing despite the post claiming comments: that is a **failed fetch, not an empty
> thread**. Report it as a failure; do not tell the user the post has no comments. (2)
> `meta.state`/`meta.unresolved` — `partial` means the record is incomplete, not
> complete-and-small. (3) `meta.budget.remaining` — if low, stop and tell the user. Comments with
> `hasReplies: true, replies: null` have nested replies this tool cannot read; say so rather than
> treating the comment as childless.

The general rule: any tool whose platform can return well-formed-but-empty on failure states the
distinguishing check in its own description.

`SKILL.md` stays hand-written prose baked into `src/generated/skill.ts`. R5 candidly notes the
family's drift prevention is *social* rather than mechanical — so we add the ten-line fix: a test
asserting every name in the command registry appears in `SKILL.md` and every command-shaped heading in
`SKILL.md` appears in the registry.

---

## 8. `batch`

**Cut from v1.** The panel split, and the resolution is deliberate rather than a compromise. The
argument for keeping it is sound — the permit ledger and cross-process breaker are the volume control,
so `batch` cannot exceed what the same queries typed by hand would spend, and a challenge on query 3
stops queries 4–12 in every process. The argument against is that it removes the human decision point
between searches on a platform where R2 found **read velocity alone** restricts accounts, and it makes
reaching the cap unattended and routine rather than deliberate.

For a v1 whose entire architecture rests on an unproven viability bet, we take the conservative branch.
This is not a permanent ban. After the live gate and a period of healthy single-query use, `batch`
returns **CLI-only, never on MCP**, capped at 10 queries per invocation, aborting on the *first*
non-200 classification, with a dry-run cost preview and flush-per-query persistence (R5 scar #2).
Over MCP it would be a one-call amplifier handed to the party we have already decided cannot be
trusted with a confirmation flag.

---

## 9. Kill criteria

Named honestly, because a tool that cannot be abandoned is a tool that will be run past its evidence.

1. **Detection failure at Phase 0** — 999, challenge, or login redirect on three human-paced requests
   from a residential IP with fresh cookies. **Abandon.** The only remaining path is a browser, and
   the thing that blocked you is precisely what a browser would be evading. Reading a detection result
   as a transport-selection problem is the error to avoid.
2. **Token failure** — requests succeed only with a value that cannot be reproduced without executing
   LinkedIn's JS. **Abandon**, same reasoning.
3. **Maintenance failure** — requests succeed, but queryIds rotate faster than weekly (measured by
   Phase 0's 14-day diff) or responses go SDUI-opaque. *Not* a detection result, and abandoning is an
   overreaction: narrow to the Rest.li-only subset (`profileView`, `/feed/comments`,
   `/feed/updatesV2`, reactions all have non-GraphQL paths), dropping `search`. If that is too thin,
   rescope to an offline archive and search over **LinkedIn's own user-data export** — legitimate,
   durable, and covering a real fraction of the research use case.
4. **Any challenge, restriction, or force-logout on the account during P0–P3 at our stated pacing.**
   Stop. Do **not** halve the caps and try again. One challenge at deliberately conservative pacing
   means detection is behavioural in a way we cannot model, and the blast radius does not justify a
   second attempt on an untestable hypothesis.
5. **LinkedIn ships any self-serve read scope.** Delete the Voyager engine that afternoon.
6. **The honest one.** This design assumes an account whose loss the owner would genuinely shrug at.
   That assumption is recorded, not incidental: the owner has confirmed it holds (a fresh account,
   no accumulated network). **If it ever stops holding, criteria 4 and 5 tighten rather than
   relax** — a restriction on an account that has since become load-bearing is a reason to stop, not
   to appeal and continue.

**A browser hot path is not a branch in any of these.** It inherits SDUI opacity and drift, adds DOM
churn, and per R1 its bug cluster is ambiguous UI state (double-fired messages, Follow-vs-Accept
misclicks) — worse than a transport bug, because it is a *write* bug visible to third parties. The
stealth-plugin category that made this viable was deprecated in February 2025.

---

## 10. What this design does not claim

- **Not ToS-compliant.** Voyager reads breach LinkedIn User Agreement §8.2. The docs state this
  plainly and never claim otherwise.
- **Not legally safe.** Our real protection from litigation is that a single-account, non-reselling
  personal tool is not economically worth suing — an *economics* fact, not a design property, and the
  design should not take credit for it. The Proxycurl founder's own primary-source lesson is that
  merely holding an account was the contractual hook, and **"legal does not mean safe."** What the
  design genuinely controls is *account-ban* risk, which is a different and more tractable objective.
- **Not safe from a ban.** Any account used can be restricted or permanently banned. The rate numbers
  in §6 are labelled `guessed` and `vendor-lore` because that is what they are.

---

## Appendix — panel provenance

| decision | round 1 | after critique |
|---|---|---|
| write surface | Codex OAuth-only · Fable OAuth+Voyager graph · Grok broad-deferred | **unanimous: OAuth-only** |
| confirmation | Codex WritePlan · Fable/Grok `--confirm` | **unanimous: WritePlan** (Fable: "strongest single argument in the round") |
| cache substrate | Codex SQLite · Fable/Grok JSON | **unanimous: SQLite** |
| corrupt cache | Codex quarantine · Fable/Grok family rule | **unanimous: quarantine** |
| `batch` | Grok MCP · Fable CLI-only · Codex cut | **cut from v1**, re-openable |
| spike failure | Fable abandon · Grok browser rescope · Codex narrow-or-kill | **unanimous: no browser hot path**; Fable's three-way split adopted |

Full proposals and critiques: `.orchestrate/panel/`. Research: `docs/research/`.
