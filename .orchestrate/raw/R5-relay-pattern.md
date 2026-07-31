# R5 — The relay-family pattern, extracted from x-relay / github-relay / youtube-context

This is a normative spec: **MUST** = every sibling in the family does this and a maintainer would
reject a design that drops it without a stated reason; **SHOULD** = strong convention, deviate only
with a documented reason; **MAY** = optional, seen in some but not all siblings. Every claim below is
grounded in a specific file, and quoted where the wording itself is load-bearing. `x-relay` is the
flagship (most mature, v1.5.4, most battle-tested) and is cited hardest; `github-relay` shows how the
pattern generalizes to a very different domain (GraphQL points, offline ranking, no snowflake ids);
`youtube-context` shows the minimal/smallest instance of the same shape.

---

## 0. What "a relay tool" IS, in one paragraph

A relay tool is a **CLI-first, single-account, agent-facing research (and optionally write) tool**
for one hostile-ish platform, built as **Bun + TypeScript**, published to npm as two binaries (a CLI
and a thin MCP shim), plus a Claude Code Skill that is *generated from the same source of truth* as
the CLI help. It talks to the platform's **unofficial/private surface** (not a paid API) using the
user's own session credentials, from a **residential IP, one account, deliberately paced**. It prints
a single **JSON envelope** to stdout and nothing else. Every network call is quarantined in one
`engine/` module so the rest of the codebase is pure and unit-testable without a network. It never
fails silently: a naming/shape drift in the private API is treated as a first-class, loud error
class, not smoothed over. A `doctor` command diagnoses the whole pipeline end to end. The project is
released via semantic-release off Conventional Commits, built with strict TDD, and documents its own
platform risk honestly instead of promising safety.

If a design panel proposes something that violates any MUST below without an explicit, argued
exception, it is not a relay tool — it is a different kind of thing wearing the family's clothes.

---

## 1. Module topology — the boundary and the rule each one enforces

Source: `x-relay/CLAUDE.md` (`x-relay/CLAUDE.md:18-37`), `x-relay/src/*`, mirrored in
`github-relay/src/*` and `youtube-context/src/*` (see tree dumps below).

```
src/cli.ts            CLI entry point (`xrelay`) — parses argv, dispatches, prints ONE envelope.
src/mcp-shim.ts        MCP server entry (`x-relay-mcp`) — thin, read-only tool surface, no business logic.
src/entry.ts           pure main-module detection — used by BOTH entry points.
src/index.ts           library exports.
src/engine/            the ONLY place that talks to the platform's network.
  xctid/                 vendored+ported anti-bot transaction-id algorithm (x-relay specific).
  auth.ts                header/cookie builder.
  ops.ts                 externalized queryId + features/config — see §6, never hardcoded in logic.
  client.ts              request driver: retries, 429/404/336 resilience — see §6.
  parse.ts               deep-search + dual-shape normalize + cursor/end-detection — see §6.
  index.ts               Engine interface + createEngine() factory.
src/cache/             independent local store (~/.xrelay) + incremental sync — see §5.
src/commands/
  registry.ts            SINGLE SOURCE OF TRUTH for command definitions — see §2.
  <runners>.ts            one runner per command / commands grouped in runners.ts.
  doctor.ts               multi-step setup diagnostics — see §4 (as a command) and its own section.
  batch.ts                serialized multi-query sweep + dedupe.
src/format.ts          pure presentation: engagement scoring, --compact rows, --fields projection.
src/progress.ts        stderr progress reporter; --quiet silences it; stdout stays JSON-only.
src/ids.ts             pure reference-extraction (tweet id / handle from any URL shape). No I/O.
src/output.ts          pure envelope constructors (`ok`, `err`, `toJson`). No I/O.
src/types.ts           domain types. No I/O.
scripts/generate-skill.ts   reads .claude/skills/<name>/SKILL.md → emits src/generated/skill.ts.
```

**MUST — network quarantine.** `engine/` is the only module allowed to import `fetch`/network
primitives. Every other file (`commands/`, `format.ts`, `ids.ts`, `cache/`, `output.ts`) is pure
TypeScript operating on already-fetched JSON or already-parsed domain types. This is why the test
suite can cover parsing, cursoring, ranking, and CLI dispatch **without a live network call** — see
`x-relay/CLAUDE.md:44-47`: *"Network is wrapped in `engine/`; keep any live smoke test out of unit
CI."* `github-relay` generalizes this into `src/sources/` (one adapter per external
service — `gh-graphql.ts`, `gh-rest.ts`, `ecosystems.ts`, `depsdev.ts`), each with injectable
`{fetchImpl, sleep, now, maxRetries}` seams (`github-relay/PLAN.md:45-46`) — the *rule* (quarantine +
injectable I/O) survives even though there's no single monolithic "engine" when a domain needs
several distinct data sources.

**MUST — `entry.ts` solves the "npm global install silently does nothing" failure class.**
`x-relay/src/entry.ts:1-9`: *"The naive `fileURLToPath(url) === argv[1]` check breaks under the npm
bin symlink (…/bin/xrelay → …/dist/cli.js): argv1 is the symlink, the module url is the real file —
unequal — so the CLI would silently exit 0."* The fix (`isMainModule`) resolves both paths through
`realpathSync` before comparing, and a second layer (`shouldForceEntry` / `shouldRunAsEntry`) treats
an *ambiguous* runtime signal (`import.meta.main === undefined`) plus a binary-looking argv0 as "run
anyway, but warn to stderr" — **an explicit `false` is authoritative and never overridden**, only
"we don't know" is. This is shared by both `cli.ts` and `mcp-shim.ts` (`x-relay/src/mcp-shim.ts:482-491`
calls the exact same `shouldRunAsEntry`). A new sibling MUST NOT re-derive this from scratch; port
`entry.ts` verbatim (parametrized on its own bin names) — this bug class (silent exit under an npm
bin symlink) is generic, not X-specific, and cost real debugging time once already
(`x-relay CHANGELOG`/git history, `07e364a fix(cli): robust main-module detection via realpath;
never silently exit under npm bin symlink`).

**MUST — `format.ts` / `ids.ts` / `output.ts` / `types.ts` are pure, I/O-free, unit-tested directly.**
No filesystem, no network, no environment reads. This is what lets `bun test` run in milliseconds
with zero mocking for the majority of the surface.

---

## 2. The registry → CLI → SKILL generation pipeline (the family's best idea)

Source: `x-relay/src/commands/registry.ts` (full read), `x-relay/scripts/generate-skill.ts`.

`registry.ts` defines **one array**, `COMMANDS: CommandDef[]`, each entry:

```ts
export interface CommandDef {
  name: string;
  cost: string;      // funnel-cost hint, e.g. "cheap — the net", "expensive — full read"
  summary: string;
  usage: string;
}
```

29 command defs live here for x-relay, from `search` (`cost: 'cheap — the net'`) through `thread`
(`cost: 'expensive — full read'`) to write commands like `delete` (`cost: '1 call — write'`). This
array drives:

1. **CLI dispatch surface** — `commandNames = COMMANDS.map(c => c.name)` is the authoritative list
   `cli.ts` matches argv against; an unmatched name is `UNKNOWN_COMMAND` (exit code 2).
2. **CLI help text** — `usage` and `summary` are what a bare `xrelay <cmd> --help`-style call prints.
3. **The generated skill** (indirectly) — but note the actual mechanism is the *inverse* of what you'd
   expect: **the hand-written `SKILL.md` is the source of truth for agent-facing prose**, and
   `scripts/generate-skill.ts` (`x-relay/scripts/generate-skill.ts:1-19`, 19 lines total) does something
   almost trivial: it reads the *hand-written Markdown file* at `.claude/skills/x-relay/SKILL.md` and
   emits `src/generated/skill.ts` as a single exported string constant:
   ```ts
   // Auto-generated by scripts/generate-skill.ts — do not edit manually.
   export const xRelaySkill = "...(JSON.stringify of the whole SKILL.md contents)...";
   ```
   The **actual drift-prevention mechanism** is social/process, not mechanical codegen from
   `registry.ts` into `SKILL.md`: `registry.ts` is consulted by whoever hand-edits `SKILL.md` (and is
   asserted against in tests — `github-relay` has `tests/generated-skill.test.ts` verifying the
   generated constant matches the on-disk Markdown), and `SKILL.md` documents every command's cost,
   usage, output shape, and composition advice in prose an agent can actually reason from. The
   generation step's real job is narrower than "generate the skill from the registry" — it is **"bake
   the skill's Markdown into the npm-published bundle as a string constant"**, so a global npm install
   ships the skill file without needing a separate file-copy step, and the CLI package can expose it
   (e.g. for a `--help`-style dump or bootstrapping a project's `.claude/skills/` on first run).

**What is generated vs. hand-written, precisely:**
- Hand-written: `.claude/skills/x-relay/SKILL.md` (the prose — funnel workflow, command reference,
  error codes, setup, troubleshooting) AND `src/commands/registry.ts` (structured metadata: name,
  cost, summary, one-line usage).
- Generated: `src/generated/skill.ts` (SKILL.md's contents frozen into a JS string constant, emitted
  by `scripts/generate-skill.ts`, run via `bun run dev` / `bun run build` before CLI run / build).

**MUST — a single command registry is the dispatch source of truth.** A new command is added to
`registry.ts` first; `commandNames` (derived, not hand-copied) is what argument parsing validates
against, so a typo'd command name in one file can't silently diverge from another. **SHOULD** — a
generated-skill snapshot test (`github-relay/tests/generated-skill.test.ts`) asserts the generated
constant matches the on-disk `SKILL.md` byte-for-byte, catching the case where someone edits one and
forgets to regenerate (`bun run build`/`bun run dev` regenerate automatically, so this is really a
CI/pre-commit safety net for anyone who runs `tsc`/`bun test` directly).

**Why this is "the family's best idea":** the alternative most agent-tool authors reach for is a
hand-maintained skill file that quietly drifts from what the code actually does (the tool grows a
flag, nobody updates the doc, the agent hallucinates a flag that no longer exists or misses one that
now exists). Here the registry's `cost`/`usage`/`summary` fields are the *machine-checkable spine*
that the hand-written prose is built around and periodically diffed against, and the generation step
guarantees the *published artifact* (the npm package) always carries whatever Markdown is currently
on disk — no separate "don't forget to copy the skill file into the build" step to forget.

---

## 3. The envelope + error contract

Source: `x-relay/src/output.ts` (full file, 25 lines), `x-relay/.claude/skills/x-relay/SKILL.md:74-99,346-361`.

```ts
export function ok<T>(command: string, data: T): Ok<T> {
  return { ok: true, command, data };
}
export function err(command, code, message, hint?, status?, retryAfterMs?): Err {
  const error: Err['error'] = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (status !== undefined) error.status = status;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return { ok: false, command, error };
}
export function toJson(envelope: unknown): string {
  return JSON.stringify(envelope, null, 2);
}
```

**MUST — every command prints exactly one JSON envelope to stdout, nothing else.**
`{ ok: true, command, data }` on success; `{ ok: false, command, error: { code, message, hint?,
status?, retryAfterMs? } }` on failure. `hint`/`status`/`retryAfterMs` are add-only — omitted when
undefined, never emitted as `null`, so a consumer can `if ('hint' in error)` reliably.

**MUST — fixed exit codes:** 0 = command ok, 1 = command error, 2 = unknown command
(`x-relay SKILL.md:78`).

**MUST — stdout is JSON-only; all human/progress chatter goes to stderr.** `src/progress.ts`'s own
comment states the invariant directly: *"The hard invariant: stdout carries ONLY the final JSON
envelope. Progress is human-facing chatter, so it goes to STDERR (never stdout) and is silenced by
`--quiet`."* (`x-relay/src/progress.ts:3-4`). This is what lets an agent (or a shell pipeline) treat
stdout as always-parseable JSON regardless of `--quiet`/verbosity flags.

**Error code taxonomy (x-relay's concrete set, generalize the *shape* not the literal codes):**
- `INVALID_INPUT` — bad input caught before any network call (empty query, malformed id/URL, bad flag
  combo). **No network call is made** — this is a critical sub-rule: local validation errors must
  short-circuit before spending any budget/rate-limit.
- `AUTH_FAILED` — session credentials expired/invalid.
- `RATE_LIMITED` — carries `retryAfterMs`; callers MUST back off by that value, not guess.
- `FEATURE_DRIFT` (x-relay-specific name; the *general* class is "the private API's shape/contract
  changed under us") — see §6, this MUST fail loud, never silently degrade to empty data.
- `NOT_FOUND` — target unavailable or a transient hiccup.
- `CONFIRMATION_REQUIRED` — a destructive write attempted without an explicit confirm flag; **no
  network call performed** when this fires (`x-relay SKILL.md:333-334`: *"Without `--confirm`,
  returns a `CONFIRMATION_REQUIRED` error and performs NO network call. This is a safety guard — a
  destructive action never fires by accident."*).
- `UNKNOWN_COMMAND`.

**Output-mode flags (context economy — SHOULD, strongly, for any list-returning command):**
- `--compact` — flatten nested result rows to a slim shape (drop nested author objects, cap long
  text fields, e.g. 280 chars with a trailing ellipsis) and mark the envelope `compact: true`.
- `--fields a,b,c` — project down to named columns only; mutually exclusive with `--compact`; an
  empty/unknown field name is a loud `INVALID_INPUT`, never a silent no-op.
- `--sort engagement` (or domain equivalent) — rank before returning, using a documented, pure,
  testable scoring formula (x-relay: `likes + replies*3 + bookmarks*2`, `src/format.ts:11-14`).
- **Over MCP, compact-style output is the DEFAULT** (agents want slim output by default); the CLI
  defaults to full output and opt-in `--compact` (humans/pipelines default to the fuller shape). See
  `x-relay/src/mcp-shim.ts:124` tool description: *"By DEFAULT (compact=true) returns slim, flat
  tweet rows... far cheaper on context."*

---

## 4. The MCP shim contract

Source: `x-relay/src/mcp-shim.ts` (full file).

**MUST — the MCP shim is read-only and contains no business logic.** File header states it directly:
*"Thin @modelcontextprotocol/sdk stdio server exposing the same commands as MCP tools. No business
logic — delegates to the command runners over one lazily created Engine."* Every `server.registerTool`
call does argument coercion (zod schema → the runner's option type) and then calls the exact same
`run*` function the CLI dispatch table calls. Destructive/mutating commands (`delete`, `post`,
`follow`, etc. in x-relay) are **never registered as MCP tools** — write access is CLI-only, gated by
the human directly invoking the binary, not by an agent operating over MCP.

**MUST — lazy, single, shared Engine instance.** `let engine: Engine | undefined;` + a `getEngine()`
that constructs once on first use (`mcp-shim.ts:44-48`) — avoids paying cookie-resolution/auth-bootstrap
cost until a tool is actually invoked, and avoids re-creating it per call.

**MUST — tool descriptions actively teach the agent how to interpret the result shape**, not just
what the tool does. This is the pattern worth naming explicitly: the `thread` tool's description is
not "fetch a tweet and replies" — it is an operating manual embedded in the tool metadata itself:

> "A tweet plus its reply conversation — the full read. Use only on finalists. Follows X's
> conversation cursor across pages up to `limit` replies (default 40). Always check the returned
> `returnedCount` / `claimedCount` / `truncated`: `truncated: true` means more replies remain (raise
> `limit`), and a `warning` field means X handed back no replies despite the root claiming some —
> treat that as a failed fetch, not as 'no replies', and try `quoters` instead."
> — `x-relay/src/mcp-shim.ts:189-190` (verbatim)

This is deliberate because the result shape itself is ambiguous without narration: an empty
`replies[]` array is **indistinguishable on the wire** between "this tweet genuinely has no replies"
and "the fetch silently failed" (see §6/§9 — this was a real, shipped bug). The fix isn't just in the
parser (paginate + report counts); it is *also* in the tool description, so an agent reading the tool
metadata **before ever seeing a response** already knows the failure mode to check for. Any relay tool
whose platform can return a technically-well-formed-but-empty result for a "the fetch actually failed"
reason MUST encode the same three-part contract: `returnedCount` (what came back) / `claimedCount`
(what the source itself says should exist) / a `warning` field reserved for the specific
claimed>0-returned=0 state — and MUST say so in the tool description, not just in a docs file an
agent may never read.

**MUST — MCP-specific defaults differ from CLI defaults where the two audiences want different
things.** E.g. `search`'s `compact` defaults `true` over MCP vs `false` on the CLI; `batch` forces
`quiet: true` over MCP because there is no stderr channel a stdio MCP client should see chatter on
(`mcp-shim.ts:422`); commands that write to disk (`archive`, `batch`) make `out` a **required** MCP
argument since MCP has no meaningful "stream to my terminal's stdout" concept
(`mcp-shim.ts:430-431,400`: *"`out` is REQUIRED over MCP (the archive is written to disk, not streamed
back)"*).

---

## 5. The cache/sync design — generalized

Source: `x-relay/src/cache/store.ts`, `x-relay/src/cache/sync.ts` (full files),
`docs/ENGINE-RESEARCH.md §6`.

**Layout:** one JSON file per source under a dotfile home directory (`~/.xrelay/bookmarks.json`,
`~/.xrelay/posts.json`), overridable via an env var (`XRELAY_CACHE_DIR`). Shape:
```ts
interface CacheFile {
  source: 'bookmarks' | 'posts';
  handle?: string;
  syncedAt?: string;
  watermark?: string;         // the highest (newest) id cached
  tweets: Record<string, Tweet>;   // keyed by canonical id — dedupe is structural, not a Set check
}
```
**MUST — load-never-throws.** `loadCache` catches any read/parse failure and returns a fresh empty
shape (`store.ts:33-40`) — a corrupted or missing cache file degrades to "empty cache", never a crash.
**MUST — atomic writes.** `saveCache` writes to a `${target}.${pid}.tmp` file then `renameSync`s over
the real path (`store.ts:43-49`) — no reader ever observes a half-written JSON file.

**The watermark pattern (the generalizable core, independent of X's snowflake ids):**
1. The platform's list ordering for "my own content" (bookmarks, own posts) must be, or be coercible
   to, **monotonic by recency** — newest-first.
2. Cache the **highest id/timestamp seen so far** as a single scalar watermark per source.
3. On sync: fetch newest-first, and **stop the very first page in which every item is ≤ the stored
   watermark** — `docs/ENGINE-RESEARCH.md:190-198`:
   ```
   newestSeen = loadWatermark(source)
   for await (const tw of stream(Latest/newest-first)):
       if (tw.id <= newestSeen) break     # everything older already cached — stop early
       store(tw)
   saveWatermark(source, max(ids))
   ```
4. This makes an incremental sync **O(new items)**, not O(total items) — critical when "total items"
   could be years of history and the API is rate-limited and hostile.
5. Cursors from the API are explicitly **NOT** trusted across runs (`ENGINE-RESEARCH.md:203`:
   *"Cursors are NOT reliable across runs (opaque/short-lived, walk backward) — use the id-watermark,
   not cursors, for cross-run freshness."*) — the watermark is the durable state; the cursor is only
   used to walk *within* one run's pagination.
6. `--repair`/`--full` escape hatch: ignore the watermark, refetch everything up to a cap, and
   **overwrite** (not append) cached records — for backfilling corrupted/incomplete entries.
7. Mutable-metrics policy is an explicit decision, not an accident: cached records' engagement counts
   (likes/views) go stale between syncs; the family's default is "refresh metrics on re-sync of the
   head [the newest window], freeze the body [older, already-settled records]" — a considered
   trade-off between staleness and re-fetch cost, and it MUST be a stated decision in a new sibling's
   design, not silently either freeze-everything or refetch-everything.

**Generalizing beyond snowflake ids — what a sibling with NO monotonic id needs to do:** the whole
scheme depends on ordering being *both* (a) what the API naturally returns and (b) usable as a
cross-run freshness key. If the platform's ids are opaque (e.g. no snowflake structure) but the
platform still returns lists **newest-first**, substitute a captured **timestamp** as the watermark
(store the newest item's `createdAt`/`updatedAt` instead of an id, compare by parsed timestamp instead
of `BigInt` comparison — `store.ts:52-59`'s `isHigherId` is exactly this abstraction point: it already
falls back to string/length comparison when `BigInt(id)` throws, i.e. the family already anticipated
non-numeric ids). If the platform does **not** reliably return newest-first, the watermark pattern
does not apply cleanly and the design MUST say so explicitly and pick an alternative (e.g. full
periodic re-sync with a change-detection diff, or an explicit "last synced at wall-clock time T, only
this connection graph changed" invalidation) rather than silently forcing a false monotonic
assumption onto data that isn't ordered that way. **This is exactly the kind of "confront it, don't
paper over it" moment the CONTEXT.md's honest-hard-part section calls for.**

---

## 6. The resilience doctrine

Source: `x-relay/src/engine/client.ts` (full file), `x-relay/src/engine/parse.ts` (full file, esp.
lines 391-422), `docs/ENGINE-RESEARCH.md §4`.

### 6a. Transport-level resilience (`client.ts`)

A single `run()` loop drives both GET (reads) and POST (writes) through one classify→retry state
machine, tracked with per-call retry budgets (`{ rateLimit, notFound }`, default `maxRetries: 3`):

- **HTTP 200** but body carries `errors[].code === 336` (or a message matching
  `/features cannot be null/i`) → **treated as a failure despite the 200**, mapped to `FEATURE_DRIFT`,
  never silently returned as an empty/partial success (`client.ts:39-51,53-61,160-163`).
- **429** → read `x-rate-limit-reset`, sleep until that instant (or a fixed 1000ms default fallback if
  the header is absent/unparseable), retry up to `maxRetries`; on exhaustion, surface
  `RATE_LIMITED` **with the computed `retryAfterMs`** so the caller can honor it instead of guessing
  (`client.ts:71-78,165-181`).
- **404** → X 404s a *stale transaction-id specifically* (not necessarily "not found"), so the policy
  is: regenerate the anti-bot token and retry, up to `maxRetries`; only after exhaustion does it become
  a terminal `NOT_FOUND` (`client.ts:183-198`). **This is a platform-specific lesson generalized to a
  rule: know which of your transient-looking HTTP codes actually mean "your request-signing artifact
  went stale," and retry-with-regeneration on those, rather than treating every non-200 as the same
  bucket.**
- **400** → inspect body for the feature-drift signature first (still a 400 can BE feature drift);
  otherwise a generic `BAD_REQUEST`.
- **401/403** → `AUTH_FAILED` (session cookies expired/invalid) — terminal, no retry.
- Network/transport exceptions (DNS, timeout, etc.) → `FETCH_FAILED`, message forwarded, no retry loop
  (the `try/catch` around `fetchOnce()` is a hard stop, not folded into the retry budget).

**MUST — the request driver never imports the anti-bot token generator directly.** It receives it
through an injected `TransactionProvider` function (`method, path) => Promise<string>`), which is why
"regenerate token and retry" is exercisable in tests with a fake counter instead of a real crypto
routine (`client.ts:5-8,14-15`).

**MUST — query-ids / feature flags / any other rotating platform-contract constants live in one
externalized config module (`ops.ts`), never inline in request-building logic**, and detecting that
the platform rejected the config (the 336-style signal) MUST produce a distinctly-named, loud error
(`FEATURE_DRIFT`) whose message tells the operator exactly what to refresh — never let a rotated
contract silently degrade to `NOT_FOUND` or an empty page.

### 6b. Parsing-level resilience (`parse.ts`) — the hard-won lesson, quoted in full

`findDict` (`parse.ts:55-76`) is a recursive deep-search — port of twikit's `find_dict` — that hunts
for a named key (`instructions`, `entries`, `tweet_results`, ...) **anywhere** in a nested
object/array tree, rather than hardcoding the exact JSON path to it. This is what survives the private
API's routine internal reshuffling: as long as the key still exists *somewhere* in the tree, the
parser finds it.

**The single most important quote in this entire research file — reproduce it verbatim to any panel
member, because it is the lesson that must carry over to LinkedIn's Voyager surface without dilution:**

> ```
> /**
>  * Entries are filtered by EXCLUSION, not by an accept-list.
>  *
>  * We used to name the entry-id prefixes that carry tweets. X renames and adds entry
>  * types routinely, and every one we hadn't named became silent data loss that still
>  * looked healthy — `ok: true`, a live cursor, an empty array. It cost us every reply
>  * in every conversation (`conversationthread-*`, issue #4) and 34 of 77 tweets per
>  * page of the following feed (`home-conversation-*`). Both were invisible until
>  * someone counted. Excluding known noise fails the safe way instead: a new entry type
>  * arrives as data, and the worst case is junk we can name here later.
>  *
>  * `tweetdetailrelatedtweets` earns its place: those are X's recommendations, which
>  * would otherwise be served up as replies to the conversation. Prompt/composer
>  * entries carry no tweets today and are listed to keep them that way.
>  */
> const DROP_ENTRY_PREFIXES = [
>   'cursor-', 'promoted', 'who-to-follow', 'module-',
>   'tweetdetailrelatedtweets', 'messageprompt', 'relevanceprompt', 'tweetcomposer',
> ];
> ```
> — `x-relay/src/engine/parse.ts:394-419`, landed in commit `5827398` ("fix(parse): filter timeline
> entries by exclusion, not by an accept-list", 2026-07-27). Before this fix, an accept-list
> (`TWEET_ENTRY_PREFIXES = ['tweet', 'search-grid', 'profile-conversation', 'profile-grid',
> 'conversationthread']`) silently dropped `home-conversation-*` entries — **34 of 77 tweets on a
> single page of the following feed** — with the response still reporting `ok: true` and a valid
> cursor. The commit's measured before/after: `HomeLatestTimeline` went from **43/77** correct to
> **84/87** (the remaining 3 are deliberately-excluded promoted tweets).

**MUST — timeline/list parsers filter candidate entries by an explicit, named EXCLUSION list (ads,
cursors, known-noise module types), never by an accept-list of "entry types we currently know carry
real content."** An accept-list means every future rename or addition of a content-bearing entry type
by the platform becomes **silent, healthy-looking data loss** — the response still says `ok: true`,
still carries a plausible-looking (just wrong) count, and nothing in the envelope signals anything is
missing. An exclusion list means an unrecognized entry type is *included by default*, and the failure
mode becomes "some junk got through, go add it to the drop list" — visible, low-severity, and
self-correcting, instead of invisible and silently destructive. **This is the single most important
rule to carry into linkedin-relay's Voyager parser without dilution**, because LinkedIn's feed/comment
APIs are exactly the kind of deeply-nested, frequently-reshuffled JSON where this failure mode
recurs — a `linkedin-relay` parser walking a feed's `elements[]`/`*Component` union types MUST default
to "include and flag as unrecognized `__typename`-equivalent" rather than "only include the types I
already enumerated."

**Supporting rules from the same file:**
- **Per-item fault isolation:** `try { parseTweetResult(...) } catch { /* one bad tweet never kills
  the page */ }` (`parse.ts:486-494`) — one malformed record must never abort an entire page/list.
- **Per-page dedupe by canonical id** (a `Set<string>`), independent of the cross-run cache dedupe.
- **Dual-shape field reads with graceful fallback**: the platform migrated fields out of a `legacy`
  sub-object into new hoisted locations (`core`, `avatar`, `verification`, ...) — the parser reads
  `newLocation?.field ?? legacy?.field` everywhere (`dualString`, `parseUserResult`,
  `applyUserOptionals`, `tweetMetrics`, etc.), so it works whichever shape a given response actually
  uses, rather than assuming the platform is internally consistent about where a field lives.
- **Cursor/end-detection tolerance:** treat up to N consecutive empty pages as "promoted-content gap,
  keep going" before concluding the timeline is actually exhausted, rather than stopping at the first
  empty page (`docs/ENGINE-RESEARCH.md:183`).
- **The claimed-vs-returned reporting contract** (§9 below and §4 above): any paginated "full read"
  command (x-relay's `thread`) MUST report `returnedCount`, `claimedCount` (what the source itself
  says should exist), and `truncated`, and MUST set a distinct `warning` when `claimedCount > 0` but
  `returnedCount === 0` — this is a **failed fetch**, not "this item has no children," and conflating
  the two is exactly the class of bug this whole section is about.

---

## 7. Testing + release doctrine

Source: `x-relay/CLAUDE.md:42-56`, mirrored near-verbatim in `youtube-context/CLAUDE.md:43-73`.

**Test WHAT (behavior only):**
- Parse normalization against **captured, real GraphQL/API response fixtures** (not hand-invented
  minimal JSON that happens to satisfy the code — actual response shapes, including the "legacy vs.
  hoisted" dual shapes).
- Cursor / end-detection logic.
- Any deterministic crypto/anti-bot math, given a fixed clock + fixed key (x-relay's transaction-id).
- Reference extraction (tweet-id / handle-from-URL parsing) across every real-world URL shape.
- Arg parsing and envelope shape (success/error, exit codes).
- Watermark early-break sync logic.

**Do NOT test:**
- What `tsc`/Biome (the type checker / linter) already enforces — field presence, types.
  `youtube-context/CLAUDE.md:54-56` states the negative examples directly: *"'function returns an
  object with an `id` field', 'property is a string', 'exported function exists'"* are **bad** tests —
  they test the type system, not behavior.
- Live network paths in unit CI — network is fully wrapped in `engine/`/`sources/`, so unit tests
  inject fakes; any real-call smoke test is kept in a separate script (`scripts/smoke.ts`,
  `scripts/mcp-smoke.ts`, `scripts/node-smoke.mjs` in the sibling repos) run manually, never in CI.

**MUST — TDD is mandatory for production code**: failing test first, watch it fail, minimal code to
pass (per the family's shared `test-driven-development` skill reference).

**MUST — Conventional Commits, semantic-release owns versioning.** `feat:` → minor, `fix:` → patch,
`feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:`/`ci:`/`test:`/`refactor:` release nothing.
Version/CHANGELOG are **never hand-edited** — every sibling's CLAUDE.md repeats this verbatim.
Releases run from `main` (prereleases from a `beta` branch) via GitHub Actions.

**MUST — small, single-purpose commits**, promptly made, so any change is cleanly revertible — this
is precisely why the git-log forensics in §9 below were legible at all (each bug fix is one isolated,
well-described commit with a measured before/after).

**Fixture capture practice (inferred from git history, not directly documented — flag as
"reasonably inferred"):** the resilience/parse fixtures are captured from **live response dumps**
during development (the `5827398` commit message cites literal measured counts per named GraphQL
operation, e.g. "SearchTimeline 22/22"), then frozen into `tests/*.test.ts` as the input JSON — i.e.
fixtures are grounded in real observed shapes, not synthesized from documentation the platform doesn't
reliably publish.

---

## 8. Naming / ergonomics conventions

| axis | x-relay | github-relay | youtube-context |
|---|---|---|---|
| repo name | `x-relay` | `github-relay` | `youtube-context` (predates the `-relay` naming; its own README calls the *package* `youtube-relay-mcp`) |
| CLI binary | `xrelay` | `ghrelay` | `ytrelay` |
| npm package (CLI+shim bundle) | `x-relay-mcp` | `github-relay-mcp` | `youtube-relay-mcp` |
| cache dir | `~/.xrelay` (`XRELAY_CACHE_DIR` override) | `~/.ghrelay` (implied `GHRELAY_CACHE_DIR`) | n/a (no local cache in this sibling) |
| MCP tool surface | read-only subset | read-only subset (write ops, if any, CLI-only) | read-only (no writes exist) |

**Naming formula, stated explicitly by `github-relay`'s own PLAN.md decision log** (`PLAN.md:101-105`):
> "**Name**: `github-relay`, following the x-relay convention — repo `github-relay`, npm
> `github-relay-mcp`, bins `ghrelay` (CLI) + `github-relay-mcp` (shim), cache `~/.ghrelay`
> (`GHRELAY_CACHE_DIR`). Verified free on npm ... Register with the first semantic-release publish;
> no pre-squat needed for a personal tool."

**MUST — derive names mechanically from the platform, not creatively:**
- Repo/product name: `<platform>-relay` (drop vowels/shorten only if the platform name itself is long
  and an obvious short form exists, e.g. `github` → `gh`).
- CLI binary: a short, typeable contraction, conventionally `<shortplatform>relay` (`xrelay`,
  `ghrelay`) — no dash, all lowercase, fast to type repeatedly in a shell.
- MCP package/binary: `<platform>-relay-mcp` — the `-mcp` suffix signals "this is the MCP-hostable
  package," and by convention it is the **same npm package** as the CLI (one package, two bin entries)
  rather than two separately published packages.
- Cache directory: `~/.<binaryname>` (drop the trailing "relay" redundancy in the dotfile — `~/.xrelay`
  not `~/.x-relay-cache`), with an env var override named `<BINARYNAME_UPPERCASE>_CACHE_DIR`.
- Verify the intended names are actually free on npm before committing to them, and note the
  verification date — names age.

**Command naming conventions (from `registry.ts` + SKILL.md across siblings):**
- Read commands are bare nouns/verbs describing the *result*, not the mechanism: `search`, `user`,
  `thread`, `feed`, `likes`, `followers` — never `getUser`, `fetchThread`.
- Local-cache commands are visually paired with their live equivalent by pluralization/qualifier:
  `bookmarks` (cache, plural) vs. `bookmark` (write, singular action) — explicitly called out as a
  common confusion point in x-relay's own SKILL.md (`SKILL.md:319-320`: *"`bookmark` saves a tweet...
  To *search* saved bookmarks, use `xrelay bookmarks` (plural, the read/cache command)"*) — **a new
  sibling should actively avoid this singular/plural collision if it can, or if it can't, document it
  as loudly as x-relay does.**
- Reversible write commands come in explicit pairs: `like`/`unlike`, `bookmark`/`unbookmark`,
  `retweet`/`unretweet`, `follow`/`unfollow` — the SKILL.md explicitly flags which writes are
  "immediately reversible" vs. destructive.
- The one destructive write (`delete`) requires an explicit `--confirm` flag and performs **zero**
  network calls without it.
- Flag naming: `--limit`, `--out`, `--since`/`--until` (dates), `--compact`, `--fields`, `--sort`,
  `--quiet`, `--full`, `--prune`, `--stdout`, `--repair`, `--live`, `--sync` are reused verbatim across
  commands wherever the same concept recurs — a flag name is never repurposed to mean something
  different on a different command.

**`doctor`'s shape (MUST — every sibling needs an equivalent):** a multi-check diagnostic command that
**always returns `ok:true`** at the envelope level — a failing individual check is data in the payload
(`{ healthy, checks: [{name, ok, detail}], summary }`), not a thrown error — because *the whole point
of doctor is to be usable when everything else is failing*, so it must not itself be fragile. Checks
run cheap-to-expensive / local-to-network in a fixed order (entry/environment → credential
presence-only, never values → a live bootstrap/reachability probe → a live authenticated call → a
minimal live functional call → static usage guidance), each individually wrapped so **no single check
may throw** (`x-relay/src/commands/doctor.ts:264-272`'s own doc comment states this design rule
directly), and live checks are **individually time-boxed** (`withTimeout`, default 15s) so a hung
network call can't hang the whole diagnostic. `--offline` skips only the checks that need network,
still resolving credentials so install/config problems are diagnosable with zero network calls.
**Never print credential values** — presence/length only (`checkCookies`: *"NEVER prints cookie
values — booleans + lengths only"*).

**`batch`'s shape (MUST for any sibling with a rate-limited multi-query workflow):** many queries from
a newline-delimited file (comments/blank lines skipped), run **strictly serialized** with a
configurable inter-query delay, **continue-on-error** (one failed query is recorded and the sweep
proceeds — a rate-limited query waits its own `retryAfterMs` before continuing), deduped by canonical
id across all queries into one output artifact, with **stderr progress** silenced by `--quiet`. See
§9 for why the persistence semantics specifically (flush-per-query, not flush-at-the-end) are a MUST,
not a nice-to-have.

**Progress reporting (`progress.ts`, ~20 lines, identical shape in every sibling):** a factory
function taking `quiet: boolean` (and an injectable write-sink for testability) that either writes
`msg + '\n'` to stderr or silently drops it — nothing more elaborate. Progress is for a human/log
watching stderr, or for an agent polling an output file's growth (see `batch`); it is never
structured, never parsed by the tool itself.

---

## 9. The known scars — and the general lesson each teaches a new sibling

Grounded in `git -C x-relay log --oneline -50` plus the full commit bodies of the four most relevant
fixes (all landed 2026-07-27, in the run-up to the 1.5.1–1.5.3 releases).

1. **`7c9cbd0` "fix(thread): follow the conversation cursor instead of reading page 1 only."**
   `engine.thread()` made exactly one API call and handed that single page to the parser — replies
   sitting behind the platform's own pagination cursor were **never fetched at all**. The result still
   looked completely healthy: `ok: true`, a non-null `nextCursor`, an empty `replies` array — "from the
   caller's side, indistinguishable... from a tweet that genuinely has no replies." A root claiming
   248 replies returned 0.
   **General lesson:** *any command whose payoff is "the full conversation/collection behind a single
   item" MUST paginate to exhaustion (or an explicit limit) by design from day one — never ship a
   single-page fetch under a name that promises completeness, even as a placeholder, because "a tweet
   the agent believes has no replies" and "a fetch that silently only grabbed page 1" are catastrophically
   different failure severities that look byte-identical on the wire.* The fix's structural answer —
   report `returnedCount`/`claimedCount`/`truncated`, and a `warning` reserved for the specific
   claimed>0/returned=0 state — is the reusable pattern (also documented in §4/§6b above); apply it to
   any linkedin-relay command that reads a comment thread, a connection list, or a message thread.

2. **`4cd6732` "fix(batch): persist the archive after every query, not once at the end."**
   `--out` was written exactly once, after the *entire* multi-query sweep finished. A 30-query sweep
   against a rate-limited API runs ~15 minutes, so — as the commit message puts it — "it is most
   likely to die exactly when the most work is at stake: a failure on query 30/32 discarded every
   earlier query with nothing on disk to resume from." It also gave a long run **zero observable
   signal** under `--quiet` (no stderr, no partial file). The fix introduces an `ArchiveSink` that
   merges and flushes to disk after **every single query**, seeded from whatever archive already
   exists at that path, with provenance (`source`, `queries[]`) stamped on every flush — so even a
   file from an interrupted run says accurately what produced it.
   **General lesson:** *any long-running, multi-step, rate-limited sweep MUST persist incrementally,
   not batch its output for a single write at the end — because the step most likely to fail is
   exactly the one furthest into the run, where discarding everything is most expensive.* This applies
   directly to any linkedin-relay bulk operation over a rate-limited surface (bulk connection-request
   sends, a multi-page profile-search sweep, a bulk archive of saved posts): design the persistence
   layer so `Ctrl-C` or a rate-limit ban at item 90/100 leaves 89 items safely on disk and the same
   command re-run resumes rather than restarts.

3. **`5827398` + `2c61283` — the entry-filtering accept-list/exclusion-list bug pair.**
   Already quoted in full in §6b. The two-commit sequence is itself instructive: `2c61283` (drop
   `tweetdetailrelatedtweets` from the accept-list survivors) was a **narrow, reactive patch** —
   naming one more bad entry type after finding it, still within the accept-list paradigm. `5827398`,
   landed the same day, is the **structural fix**: invert the whole filtering strategy from
   accept-list to exclusion-list, because the narrow patch was already the second time the same root
   cause had bitten (issue #4, then the `home-conversation-*` feed loss found only by "dumping raw
   responses and counting").
   **General lesson:** *when the second bug in a short span shares a root cause with the first, do not
   ship the second narrow patch as the final answer — invert the underlying strategy so the entire bug
   CLASS becomes structurally impossible, not just the two instances found so far.* For
   linkedin-relay, this means: the very first version of any feed/timeline/comment-tree parser over
   LinkedIn's Voyager JSON must default to an exclusion list (ads, "People You May Know" modules,
   promoted content, known UI chrome) and pass through anything unrecognized, rather than an
   accept-list of currently-known content types — do not wait to be bitten twice before adopting this;
   adopt it as the v1 default given the lesson is already paid for.

4. **`9127816` "fix(parse): collect thread replies from conversationthread entries" (issue #4, the
   original incident this whole line of fixes traces back to)** — the earliest of the four, and the
   one whose cost ("every reply in every thread") is quoted by both later commits as the canonical
   example. **General lesson, stated once for all four:** *a private, unversioned API surface will
   rename and restructure its response shape without notice, and the only sustainable defense is (a)
   deep-search-by-key instead of hardcoded paths (`findDict`), (b) exclusion-based filtering instead of
   accept-based filtering, and (c) counting — literally instrumenting "how many tweet_results actually
   exist in this raw response vs. how many did I parse out" — during development, because a shape
   mismatch that still returns `ok: true` is otherwise invisible until someone manually counts.* Bake
   (c) into linkedin-relay's own development process: whenever a new Voyager response type is
   supported, capture a live fixture and assert the parser extracts every content-bearing node in it,
   the same way the `5827398` commit message reports exact measured ratios per operation.

---

## Summary checklist for the design panel

A linkedin-relay design is "family" only if it commits, explicitly, to all of:

- [ ] Bun + TypeScript, `tsup`, Biome, `bun test`, semantic-release + Conventional Commits.
- [ ] CLI is the product; MCP shim is thin, read-only, zero business logic, shares runners with CLI.
- [ ] One command registry drives CLI dispatch + is the reference `SKILL.md` is hand-maintained
      against; a generated-skill snapshot test catches drift.
- [ ] All network access quarantined in an `engine/`-equivalent (or `sources/`-equivalent per adapter);
      everything else pure + unit-testable without network.
- [ ] `{ok,command,data}` / `{ok:false,command,error:{code,message,hint,status?,retryAfterMs?}}`
      envelope; stdout JSON-only; stderr progress; fixed exit codes 0/1/2.
- [ ] Parsers filter by EXCLUSION, never by accept-list, for any nested/reshuffling response surface.
- [ ] Deep-search-by-key (`findDict`-equivalent) instead of hardcoded JSON paths.
- [ ] Rotating platform-contract constants (query ids, feature flags, API version headers) live in one
      externalized config module; a rejected-config response is a distinctly named, loud error.
- [ ] Any "full conversation/collection" read paginates to exhaustion/limit and reports
      returned/claimed/truncated + a distinct warning for the claimed>0/returned=0 state.
- [ ] Any multi-step rate-limited sweep persists incrementally, not once at the end.
- [ ] Local cache (if any) uses a recency watermark for incremental sync, with an explicit, stated
      answer for what plays snowflake-id's role if the platform has no monotonic id.
  - [ ] `doctor` command: always `ok:true` envelope, per-check isolation, timeout-boxed live checks,
        `--offline` mode, never prints credential values.
- [ ] Destructive writes require an explicit confirm flag and perform zero network calls without it;
      writes are CLI-only, never exposed over MCP.
- [ ] Naming: `<platform>-relay` repo, `<shortplatform>relay` CLI bin, `<platform>-relay-mcp` npm
      package/MCP bin, `~/.<binaryname>` cache dir + matching env var override.
- [ ] Honest, undiluted risk documentation for a platform that can ban a real professional identity —
      no promises of safety, explicit statement of what is refused vs. merely possible.
