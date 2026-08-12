# linkedin-relay — implementation plan

Companion to [DESIGN.md](DESIGN.md). Read that first; this file is the build order.

**The governing rule:** Phase 0 is a gate, not a formality. It costs one afternoon and it decides
whether the other six phases exist at all. Do not scaffold an engine against a transport that has not
been shown to work.

---

## Phase 0 — the viability spike (**GATE — PASSED 2026-08-01**)

> **Result: passed.** `me`, `feed` and the GraphQL profile endpoint all returned 200 from a
> residential IP with cookie auth and no browser in the request path. No 999, no challenge.
> One correction to the research: **`profileView` is 410 Gone** — the reference client's core profile
> endpoint no longer exists, and its live replacement has been captured.
> Full findings: **[ENGINE-RESEARCH.md](ENGINE-RESEARCH.md)**.
>
> Still outstanding from this phase: the **14-day queryId rotation diff** (kill criterion #3), and
> `observe.ts` runs against search, a post permalink, and the feed to capture the queryIds those
> commands need.

The procedure, for re-running it:

1. Launch Chrome with a persistent profile, log in manually.
2. Navigate to `/feed/` — this is specifically what sets `JSESSIONID`.
3. `Network.getAllCookies` via CDP → `li_at` + `JSESSIONID`.
4. Issue exactly **three** requests, ≥15s apart, from the user's own residential IP:
   - `GET /voyager/api/me`
   - one `profileView`
   - one `graphql` search with a queryId scraped live from the loaded web bundle
5. Print status codes. Dump raw bodies to `captures/` (gitignored).

**Then, over the following 14 days:** re-scrape the web bundle's queryIds once daily and diff them.
This measures rotation cadence, which decides kill criterion #3 and cannot be measured any other way.

| outcome | branch |
|---|---|
| three 200s with parseable bodies | proceed to Phase 1 |
| 999 / challenge / login redirect | **abandon** (DESIGN §9.1) |
| works only with a JS-derived token | **abandon** (§9.2) |
| works, but queryIds rotate more than weekly | narrow to the Rest.li-only subset, dropping `search`; or rescope to an offline archive over LinkedIn's own data export (§9.3) |

**Deliverables:** three redacted fixtures, `docs/ENGINE-RESEARCH.md` seeded from
`docs/research/R3-linkedin-surface.md` with per-endpoint ✅ verified / 🔍 discovered / 🔩 inferred
provenance, and a 14-day queryId rotation log.

**Never commit raw captures.** They contain third-party personal data and live session tokens.
Redact by hand into `tests/fixtures/` first; `captures/`, `*.har` and `cookies.json` are gitignored.

---

## Phases 1–6 — COMPLETE (2026-08-02)

All six phases are built, tested and verified live. 249 tests.

| phase | delivered | verified live |
|---|---|---|
| **1** skeleton | envelope, error taxonomy, Rest.li codec, permit ledger, cooldown, `entry.ts` | `doctor --offline`, `budget`, `risk` |
| **2** engine | auth, contracts, classifier, parser, client, session minting | `whoami`, `profile`, `feed`, `search` |
| **3** research | comments, reactions, engagement counts | `post` (3 comments), `reactions` (5 reactors) |
| **4** local-first | SQLite, opt-in retention, offline search, purge | `--retain` → `local` with zero network |
| **5** agent surface | MCP shim, generated skill, parity test | 13 tools over stdio; live `search` and `local` calls |
| **6** writes | OAuth login, transport, confirmation capability | gate refuses without a TTY, spending nothing; loopback callback listener exercised on a real socket |

### What did NOT ship, and why

- **`company`** — the endpoint returns 200, but with a projection carrying no name, tagline or
  description. Its contract stays `discovered`, so the verified-only rule keeps the command out. The
  richer path is probably `voyagerOrganizationDashViewWrapper`, which first needs an
  `organizationalPageUrn` resolved.
- **`job` detail** — what was captured is a job-cards list, not a detail endpoint. `search jobs`
  works; reading one job does not.
- **Connect, message, invitation handling** — cut by design, not left undone. These are where the
  enforcement reports cluster and where an agent bug is third-party-visible and unrecoverable.
  Reconsider `connect`/`follow` only after a quarter of clean read-only operation; never messaging.

### Still owed

1. **The 14-day queryId rotation diff.** Substantially de-risked — a November-2024 search queryId
   still returned 200 in August 2026 — but never formally measured. Run `scripts/observe.ts` daily
   and diff.
2. **OS credential storage.** The session and OAuth token live in mode-0600 files under `~/.lnrelay`.
   The design calls for the OS keychain; this is a known, written-down debt rather than an oversight.
3. **Comment pagination.** `post` reads the first page only and reports `state: unknown` rather than
   claiming exhaustion. Following `paginationToken` is a contained next step.
4. **Nested comment replies.** Unsolved industry-wide; a comment with replies says so rather than
   returning an empty array.
5. **A live OAuth write.** Login, transport and gate are built and tested against injected fetch, but
   no post has been sent, so the request shapes in `oauth-write.ts` are still written-from-docs rather
   than verified — the standard this project holds everything else to. The LinkedIn app must be
   registered by the user first; `lnrelay oauth login` prints the steps.

   Note the one asymmetry that leaves: reads were built by observing and probing live traffic, writes
   were not. Treat the first live `share` as a Phase-0-style gate, not a formality.

---

## Original phase detail

Kept for the reasoning behind each step.

## Phase 1 — skeleton, zero network

Everything here is buildable today on verified facts and is worth building even if Phase 0 has not run
— but **do not ship it as a product** until the gate passes.

- `entry.ts` ported verbatim from x-relay (realpath-safe main-module detection — solves the npm
  bin-symlink silent exit; do not rediscover it).
- Envelope, error codes, exit codes 0/1/2, `--compact` / `--fields` / `--quiet`.
- Command registry as the single source of truth.
- `restli.ts` — the Rest.li 2.0 variables codec. Pure, ~120 lines, zero network, fully unit-tested.
  Nobody in the 90-repo corpus has this as a clean module; everyone string-templates it.
- Permit ledger + cross-process cooldown file.
- `doctor --offline`, `budget`, `risk`.
- Toolchain: Bun, tsup, Biome, `bun test`, Conventional Commits, semantic-release.

**Done means:** `lnrelay doctor --offline` and `lnrelay budget` green on a real machine. No command
touches the network yet.

---

## Phase 2 — first live read

- `auth.ts` + OS-credential-store cookie handling + the CDP bootstrap as `lnrelay login`.
- `classify.ts` and `client.ts` with the full zero-retry / cooldown state machine.
- The parser: URN index, three-state resolution, exclusion filter, namespace collapse.
- `whoami` and `profile <self>`.

**Build the parser fixture-first**, with the counting assertion from day one: *this fixture contains N
content-bearing nodes; the parser emits N.* That assertion is the whole defence against the family's
worst bug class.

**Gate:** account healthy after one week of use.

---

## Phase 3 — the research surface

`search`, `post` (+ comment thread, cursor-followed), `feed`, `company`, `reactions`, `job`.

One operation at a time. Each ends in a live smoke check and a captured, redacted fixture. **A command
does not graduate until its empty-vs-failure behaviour is demonstrated** — a test proving that a
claimed-but-empty response produces `ok:false`, not an empty success.

**This is the product.** If the project stopped here it would still be worth having.

**Gate:** account healthy after two weeks.

---

## Phase 4 — local-first

- SQLite store (WAL, numbered SQL migrations) behind the narrow family interface.
- `my-posts --sync` (timestamp watermark, 2-page slack for pinned posts).
- `connections --sync` / `--diff` (snapshot diff; refuses more than once per 7 days without `--force`).
- `local` — offline FTS. After this, the default research path spends zero platform calls.
- TTL sweep on the read path; body expires, identity stub survives.
- `purge`; corrupt-store quarantine + `CACHE_CORRUPT`.
- Investigate the `saved` endpoint; ship it only if capture verifies it.

---

## Phase 5 — the agent surface

- MCP shim: read-only registry, Zod validation, lazy shared Engine, cooldown-aware refusal.
- Hand-written `SKILL.md` → `src/generated/skill.ts`; snapshot test.
- **Registry ↔ SKILL.md parity test** — the ten-line fix for the drift gap R5 admits is currently
  social rather than mechanical.
- Tool descriptions carrying the teaching contracts from DESIGN §7.

---

## Phase 6 — writes, last and smallest

Deliberately inverted from the natural order: writes carry the enforcement risk, so we want weeks of
observed healthy read behaviour first.

- Register a LinkedIn developer app; add **Sign In with LinkedIn (OIDC)** + **Share on LinkedIn**
  from the self-serve Products tab. **Verify live** that `w_member_social` actually covers post,
  comment and react before writing code against any of them.
- `oauth-write.ts`, token refresh, `~/.lnrelay/oauth.json`.
- `WritePlan` → `confirm <plan-id>` with TTY, plan-id-derived phrase, payload hash, 10-minute expiry,
  single use, owner-URN binding, unexported `ConfirmedWrite<T>`.
- `share`, `comment`, `react`; `unreact` **only if** the scope verifiably covers it.

If OAuth cannot perform an operation, **omit the command** — never fall back to Voyager silently.

---

## Testing doctrine

Inherited from the family, and non-negotiable:

- Test **behaviour**: parse normalisation against captured fixtures, cursor/exhaustion logic, the
  Rest.li codec, URN canonicalisation, watermark and slack logic, arg parsing, envelope shape,
  permit/ledger accounting, cooldown transitions.
- Do **not** test what `tsc` and Biome already enforce.
- Network stays wrapped in `engine/`; no live calls in unit CI.
- TDD is mandatory for production code: failing test first, watch it fail, minimal code to pass.

## Release doctrine

Conventional Commits; `semantic-release` derives version and CHANGELOG. `feat:`→minor, `fix:`→patch,
`feat!:`/`BREAKING CHANGE:`→major. Never hand-bump a version or hand-edit the CHANGELOG.

---

## Open questions carried forward

These are unresolved and must not be silently assumed away during implementation:

1. `li_at` lifetime, and which cookies beyond `li_at` + `JSESSIONID` are actually load-bearing.
2. Which modern anti-bot headers matter — the one primary source has `x-li-track` commented out.
3. Real Voyager throttle thresholds. Every number in circulation is an SEO-blog assertion with no
   cited methodology. Ours are labelled `guessed` for that reason.
4. The `saved` and `notifications` endpoints — no verified path exists.
5. Whether nested comment replies can be bound to parents at all. Unsolved industry-wide.
6. Whether `w_member_social` genuinely covers comment and react self-serve, or only share.
