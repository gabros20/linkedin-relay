# CODEX (GPT-5.6-Sol) proposal: linkedin-relay

## Decision

Build `linkedin-relay` as a conservative, CLI-first research relay whose hot path is direct HTTP to Voyager, but only after a phase-one live replay proves that path still works at human pace. Use a visible browser solely to establish the user's session and capture current operations; do not ship stealth automation, CAPTCHA solving, proxy rotation, or a DOM-scraping fallback. Use LinkedIn's self-serve `w_member_social` OAuth product for the narrow write surface it officially supports. Do **not** automate connection requests, withdrawals, follows, or messaging in v1.

This is deliberately narrower than the context's intended surface. LinkedIn can destroy a professional identity, practitioners report restrictions from fast reading alone, and there are no credible Voyager rate ceilings (R2, §§1–2; R4, §3). “Technically possible” is not an adequate inclusion test.

The package remains unmistakably in the relay family: Bun/TypeScript, `tsup`, Biome, `bun test`, Conventional Commits and semantic-release; binaries `lnrelay` and `linkedin-relay-mcp`; cache under `~/.lnrelay` (override `LNRELAY_CACHE_DIR`); one command registry; JSON-only stdout; network quarantined in `src/engine/`; thin read-only MCP; captured real-response fixtures; and a generated Claude Code skill (R5, §§0–4, 7–8).

## 1. Command surface

Every command emits exactly one `{ok, command, data}` or `{ok:false, command, error:{code,message,hint?,status?,retryAfterMs?}}` envelope. Exit codes are 0/1/2 for success/command failure/unknown command. List commands accept `--compact` or `--fields`, never both; MCP defaults to compact. Progress and risk notices go to stderr; `--quiet` suppresses progress but **not** a write confirmation or account-risk stop.

### Read and local commands

| Command | Arguments | Result and reason | MCP |
|---|---|---|---|
| `doctor` | `[--offline]` | `{healthy, checks[], riskCircuit, budgets}`. Always envelope-level `ok:true`; checks are isolated, time-boxed, and reveal cookie presence/length, never values. It is the only sensible first support command (R5, §8). | `doctor` (offline by default) |
| `login` | `[--chrome-profile path]` | Opens visible Chromium for manual login, navigates to `/feed/` so `JSESSIONID` is set, imports `li_at` and `JSESSIONID` into OS credential storage, and locks the store to the `/me` member URN. R1 documents this exact CDP bootstrap. No password automation. | No |
| `me` | none | Minimal owner profile plus session/budget state. It validates account binding cheaply and prevents accidental session switching. | `me` |
| `search` | `<query> --type people\|companies\|jobs\|posts [--limit 1..25] [--filters json] [--compact\|--fields ...]` | `{items, page, fetch}`. One operation prevents four near-duplicate commands. `posts` is registered only after a current capture verifies it; R3 explicitly marks its path unverified. Filters are locally schema-validated and type-specific. | `search` |
| `profile` | `<public-id\|URN\|URL> [--sections core,experience,education,skills]` | Normalized profile with section-level completeness. Expensive sections are opt-in; no contact-info command because collecting email/phone is unnecessary personal-data expansion. | `profile` |
| `company` | `<slug\|URN\|URL> [--posts 0..10]` | Company and a small, explicitly bounded update sample. | `company` |
| `job` | `<id\|URL>` | Normalized job detail; this is a high-sensitivity read charged to the strict detail budget. | `job` |
| `post` | `<activity-URN\|URL> [--comments 0..100] [--sort relevance\|recent]` | `{post, comments, returnedCount, claimedCount?, truncated, fetch, warnings}`. It follows `paginationToken` until the limit/exhaustion and never calls one page a thread (R3, §2; R5, §9). | `post` |
| `reactions` | `<post> [--kind ...] [--limit 1..100]` | Reaction aggregates and, only when requested, bounded reactors. Kept separate because enumerating people costs more and processes more personal data. | `reactions` with aggregate-only default |
| `feed` | `[--limit 1..20]` | Chronological owner feed. The parser orders by `data["*elements"]`, not unordered `included[]`, matching the verified R3 §4 shape. | `feed` |
| `sync` | `<authored\|saved\|connections> [--full] [--limit N]` | Incrementally updates the local cache and reports `{added,updated,expired,checkpoint,completeness}`. CLI-only because it writes disk and can consume substantial request budget. A source is enabled only after its endpoint and ordering are captured; saved items is currently unverified (R3, §3). | No |
| `local` | `<query> [--source authored,saved,connections] [--since date] [--limit N]` | Offline full-text search with `{items, cacheAge, sourceCompleteness}`. This is the default research path after sync and spends zero platform calls. | `local` |
| `cache` | `status` or `purge [--source ...] [--before date\|--all]` | Status exposes age/retention/counts; purge is a local deletion with preview plus interactive confirmation for `--all`. It never contacts LinkedIn. | `cache_status` only |

All successful collection payloads include:

```ts
type FetchMeta = {
  state: "complete" | "partial" | "unknown";
  operation: string;
  contractCapturedAt: string;
  rawCandidateCount: number;
  parsedCount: number;
  unknownCount: number;
  warnings: string[];
};
```

A genuine empty result is `ok:true`, `items:[]`, `fetch.state:"complete"`, with `claimedCount:0` where LinkedIn supplies it. Auth failure, challenge, restriction, contract drift, or an empty result contradicting a nonzero claimed count is `ok:false`, never an empty success. A partially parseable nonempty page may be `ok:true` only with `state:"partial"`, counts, and warnings.

### Writes

Ship only `publish --text|--file`, `comment <post> --text|--file`, `react <post> --kind ...`, and `unreact <post>`, backed by official OAuth where live verification confirms the requested operation. R3 §6 verifies self-serve `w_member_social` for posting, commenting, and liking; it offers no sanctioned research reads. If OAuth cannot perform `unreact`, omit that command rather than silently fall back to Voyager.

Each invocation only creates a typed `WritePlan` in `~/.lnrelay/plans/` and returns `CONFIRMATION_REQUIRED` with a plan ID, exact target, rendered content, transport, reversibility, and risk. `lnrelay confirm <plan-id>` is CLI-only, requires an interactive TTY, shows the plan again, and requires the human to type a target-specific phrase. It rejects piped input, expired plans (10 minutes), changed payload hashes, reused plans, and owner-URN mismatch. Only `confirm` can construct the unexported `ConfirmedWrite<T>` capability accepted by the write engine. Thus an agent cannot append `--confirm`; the no-confirm path performs zero network calls.

Leave out automated `connect`, `withdraw`, `message`, `follow`, invitation acceptance, profile editing, notifications, contact-info extraction, bulk/batch search, bulk writes, nested comment replies, and analytics. Reasons are specific: message/connect automation has the strongest adverse field reports (R2 §§1–3); notifications and saved-item endpoints are unverified (R3 §3); nested replies remain unimplemented across the surveyed ecosystem because the parent binding has not been captured (R1 finalist 3); profile editing has shifted to SDUI and visible modal state (R1); and batch exists chiefly to turn a personal tool into a velocity incident. A command an agent cannot safely or reliably use is a liability.

## 2. Engine and empirical gate

`src/engine/` owns every network primitive and has injectable `fetch`, clock, sleep, credential store, and random source. Its modules are `auth.ts`, `restli.ts`, `contracts.ts`, `scheduler.ts`, `classify.ts`, `client.ts`, `parse/`, and `oauth-write.ts`. Command runners consume an `Engine` interface; MCP shares one lazy instance. Port the family's realpath-safe `entry.ts` rather than rediscovering npm-bin silent exit (R5, §1).

Build now from verified facts: Voyager base URL; `li_at` plus `JSESSIONID`; unquoted `JSESSIONID` as `csrf-token`; `x-restli-protocol-version: 2.0.0`; Rest.li tuple/List variable encoding; offset and `paginationToken` pagination; URN/decorated response mechanics; and the legacy endpoints explicitly verified in R3 §§1–4. Never copy the stale Chrome 83 UA from the 2024 client. The bootstrap records the current visible browser UA and uses a coherent, minimal captured header set.

Before implementing an operation, capture current traffic from the user's visible logged-in Chrome and store a redacted fixture plus a contract record:

```ts
type OperationContract = {
  name: string;
  transport: "voyager-restli" | "voyager-graphql" | "oauth";
  path: string;
  queryId?: string;
  decorationId?: string;
  variablesSchema: JsonSchema;
  responseFingerprints: string[];
  provenance: "verified" | "discovered" | "inferred";
  capturedAt: string;
};
```

Only `verified` contracts compile into the public registry. Query IDs, decoration IDs, feature/header blobs and schema fingerprints live in versioned data under `src/engine/contracts/`, never request logic. A developer-only redaction/import script updates them from a HAR; it is not a user command. This adopts R1's most valuable verified/discovered/inferred discipline and acknowledges that R3's IDs are a November 2024 snapshot.

The client classifies the response before parsing. `429`, HTTP 999, checkpoint/challenge markup or JSON, login redirects, restriction banners, and suspicious 200-with-error responses trip a persistent account-wide circuit breaker. There is **no automatic retry**. The error is `RATE_LIMITED`, `CHALLENGE`, `RESTRICTED`, `AUTH_FAILED`, or `CONTRACT_DRIFT`, carries server wait information when present, and tells the user to use LinkedIn manually before clearing the circuit with a successful interactive `doctor`. Network timeouts may be retried once only when no response was received and only for idempotent reads.

## 3. Parser

The normalizer first recursively discovers every object with an `entityUrn`, URN-valued field, `$type`, or `_type`; builds an O(n) canonical URN index over `included[]`; then resolves `data` references while preserving `data` ordering. A real Rest.li grammar parser handles composite URNs instead of `split("(")` tricks. Aliases such as `fs_miniProfile`, `fs_profile`, and `fsd_profile` map to one canonical member identity without using those namespaces to decide whether an entity is content.

Candidate selection is by structural evidence (URN/reference/content fields) and **exclusion only**. The drop table names promoted modules, UI chrome, recommendation modules, and cursors. Unknown `$type`/`_type` values become `UnknownEntity {urn,type,rawRedacted}` and increment `unknownCount`; they are never silently discarded. Each entity parses in isolation, every field has observed legacy/dash fallbacks, and a fixture test asserts `rawCandidateCount === parsedCount + deliberatelyExcludedCount + unknownCount`. This concretely applies the x-relay bug where an accept-list lost every reply and 34 of 77 feed posts while still returning healthy output (R5, §§6b, 9).

Reference failures are explicit `UnresolvedRef` objects. A requested root that cannot resolve is `CONTRACT_DRIFT`; optional unresolved children make the result partial. Thread/collection parsers follow all cursors to the requested limit and report returned/claimed/truncated. `claimed>0 && returned=0` is a failed fetch, not “no comments.”

## 4. Cache and sync without a fake snowflake

Use SQLite (WAL mode, transactional migrations), not one JSON file per source: normalized URNs, source membership, timestamps, FTS, expiry, and sync checkpoints need relational integrity. Owner-authored content may be retained until explicit purge. Every third-party profile/post projection expires after **30 days**; a sync transaction deletes expired rows first. No permanent pin, export-all, raw-response archive, or transferable corpus exists. `cache purge --all` deletes database, plans, fixtures outside the shipped contract set, and credentials after an explicit interactive confirmation. Files are mode 0600 and cache outputs redact contact fields.

LinkedIn has no snowflake, and one scalar timestamp is not safe. Each source uses a compound checkpoint `{lastSuccessfulAt, headIds[], newestCreatedAt?, endpointRevision}` plus a two-page overlap. For a captured newest-first authored/saved list, sync walks until two consecutive pages contain only known IDs older than the prior newest timestamp; it upserts the overlap so head metrics refresh while old metrics freeze. Cursors never survive a run. Clock ties are resolved by URN membership, not ordering assumptions.

Connections are different: search relevance/order is not a change stream. `sync connections` performs a bounded snapshot/diff only, stores the minimal projection, and is refused if the graph exceeds the user's remaining detail budget. It never claims incremental completeness. If capture does not reveal a stable chronological connection endpoint, its checkpoint state is `snapshot-partial`, not a fabricated watermark. A corrupt database is quarantined and returns `CACHE_CORRUPT`; it must **not** look like an empty cache and trigger a full network resync.

## 5. Safety architecture

One owner URN is sealed into credentials, cache, contracts, and plans. A different `/me` response opens the circuit and requires `cache purge --all` before rebinding. There is no account selector, cookie environment variable, proxy setting, remote server mode, or multi-tenant schema.

All requests pass through a single-concurrency scheduler backed by a durable daily ledger. Defaults are deliberately provisional: 3–15 seconds of cryptographic jitter between calls; at most 30 profile/job-detail reads per rolling 24 hours (the only concrete living-client precedent in R1); at most 10 confirmed writes per 24 hours, stricter than R2's weakly reported ~20 invitations/day; and no bulk primitive. Other reads share a conservative 100-call daily ceiling. These are guardrails, **not claimed safe limits**—R2 explicitly found no corroborated thresholds for most actions. Users may lower them, not raise them without editing and rebuilding the source. Manual browser activity is unknowable, so every command displays remaining tool budget without implying total LinkedIn activity.

Risk becomes visible at the decision point: every live result carries calls spent/remaining and circuit state; every confirmation states “This automation breaches LinkedIn User Agreement §8.2 and can permanently restrict this professional account.” The README repeats that there is no individual sanctioned read API (R3 §6; R4 §5), but never calls the tool compliant. No CAPTCHA solving, restriction bypass, identity-verification automation, proxy/VPN advice, or replacement accounts exist.

## 6. MCP and generated skill

MCP exposes only `doctor`, `me`, `search`, `profile`, `company`, `job`, `post`, `reactions`, `feed`, `local`, and `cache_status`. The shim validates Zod arguments and calls shared runners; it has no parser, transport, pacing, cache, or write logic. Live tool descriptions label cost (`offline`, `cheap`, `detail-budget`, `thread-budget`) and teach the fetch contract. In particular: “Empty plus `state=complete` means no data; `partial` means do not infer absence; a tool error or claimed>0/returned=0 means failed fetch. Always inspect returnedCount/claimedCount/truncated/warnings.”

`CommandDef` contains names, audience (`cli|mcp`), risk class, cost, args schema, output schema, and summary. Generate the CLI dispatcher metadata, MCP registrations, help command table, and the command-reference section of `SKILL.md` from it. Keep only workflow prose hand-written, then bake the composed Markdown into `src/generated/skill.ts`; snapshot tests compare all artifacts. This improves on R5 §2, which candidly reveals that the current family's “single source” is partly social rather than mechanical.

## 7. Build order and falsifiable bets

1. **Viability spike.** Visible manual login; redacted capture of `/me`, one search, one profile, and one post; replay one captured idempotent GET through Bun, then a five-call human-paced session. Deliver `doctor`, `me`, contract fixtures, and classifier. The riskiest assumption is that direct HTTP with fresh own-session cookies remains viable in 2026. It is disproved by a challenge/999/restriction at this tiny rate, or by a load-bearing browser-only token that cannot be reproduced without evasion. Then stop the HTTP design rather than escalating stealth.
2. **Research vertical slice.** Rest.li encoder, contract loader, URN index/parser, scheduler/circuit, envelopes; deliver `search people`, `profile core`, and fixture-count parity. Drift is disproved as manageable if required query IDs rotate faster than a practical capture/import/release cycle.
3. **Deep reads.** Add company/job/post/reactions/feed one operation at a time, each ending in a live smoke script and captured fixture. A command does not graduate until empty-vs-failure behavior is demonstrated.
4. **Local-first.** SQLite, retention, authored sync, local FTS, purge; add saved/connections only after endpoint/order experiments. The newest-first bet is disproved by any older item appearing ahead of an unseen newer item across repeated captures; that source falls back to bounded snapshots or is omitted.
5. **Agent surface and official writes.** Generate skill/MCP from registry; verify OAuth scopes live; add typed plans and TTY confirmation. If `w_member_social` access is not genuinely self-serve or does not cover an operation, omit that write.

## 8. Kill criteria

Abandon or radically rescope if: low-volume direct HTTP triggers a challenge/restriction; safe operation requires stealth patches, CAPTCHA solving, proxy rotation, or fingerprint forgery; current response shapes cannot distinguish empty data from failed resolution; contracts rotate so often maintenance dominates use; the account sees any automation warning under the default budget; a cease-and-desist or materially adverse legal change targets personal own-session tools; or meaningful research requires bulk retention beyond the 30-day/local-only model. Rescope to an offline archive/search tool if LinkedIn offers a user data export adequate for the owner's own data. Rescope to browser-assisted *manual* research, with no programmatic writes, only if the user explicitly accepts that separate product.

## Where I dissent

First, the brief's aspirational write list is wrong for v1. Confirming a message or connection does not erase the behavioral signal, and R2 contains adverse reports precisely around outreach automation. Official self-originated content writes are the defensible boundary; Voyager messaging/connect/follow are not.

Second, x-relay's automatic 429 retry policy must not transfer. R4 requires loud failure, R1's newest conservative CLI uses zero retry on throttle/challenge, and the LinkedIn identity blast radius is higher. A server hint is information for the human, not permission for the process to resume.

Third, R5's “load-never-throws means corrupt cache becomes empty” is unsafe here. Empty-cache recovery can launch the largest possible sync against the most hostile platform. Quarantine and loud failure are safer than availability.

Fourth, the snowflake watermark analogy does not apply to connections and may not apply to saved items. Pretending that an opaque URN or wall clock is monotonic would recreate the family's worst sin: healthy-looking silent loss. Compound overlap checkpoints and honest partial snapshots are less elegant and more correct.

Finally, a full browser/Patchright engine is not automatically safer because it resembles a person. R1 shows its bugs cluster around ambiguous UI state, including double-fired messages and Follow-versus-Accept mistakes. Browser automation also moves this project toward explicit anti-detection tooling. The cheapest raw-HTTP viability test should decide the architecture; failure should narrow or kill the project, not trigger an evasion arms race.
