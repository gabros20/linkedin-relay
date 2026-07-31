# C3 — FABLE cross-critique

## 1. Write surface

**I move to CODEX's position, and I should have been there already.** Ship OAuth
`share`/`comment`/`react` (+`unreact` only if the scope actually covers it). Cut `connect`, `follow`,
`invitations`, and `message` from v1.

My own P3-fable §7 put Voyager writes at the very end of P6, gated on "everything above stable" —
and then listed them in the v1 command table anyway. That is incoherent: a thing gated behind weeks
of clean read behavior is not v1, it is a later phase I was smuggling into the launch surface to
avoid looking like I had cut the brief in half. CODEX's inclusion test is the right one — the read
half has no substitute (R3 §6: no self-serve read scope, partner programs closed to individuals per
R4 §5), so it earns the ToS and ban risk; `follow` is a four-second UI action and earns nothing.

Against GROK: "deferred to phase 3+" is a roadmap promise, and roadmap promises get built. `connect`
and `follow` should be *cut with a written rationale*, with one named door — reconsider only after a
quarter of clean read operation, and never `message` or invitation-accept at all. Auto-accept is
squarely inside GROK's own artificial-engagement exclusion (their §1.2) and should not have survived
in mine.

## 2. Confirmation mechanism

**CODEX is right and this is the strongest single argument in the round. I change position.**

`--confirm` is not a human confirmation. In this family's actual deployment the agent *is* the
process invoking the CLI — Claude Code shells out. So `--confirm` is a flag the acting party writes
about its own action. It documents intent; it does not obtain consent from anyone. FABLE and GROK
both inherited it from x-relay without noticing that x-relay's blast radius made the weakness
tolerable and LinkedIn's does not.

Two corrections to CODEX's design before it ships. First, **do not claim the TTY check is a
capability boundary** — an agent can allocate a pty (`script`, `expect`, node-pty) and drive the
prompt. The mechanism's real value is that it moves circumvention from *accidental* (append a flag)
to *deliberate and legible* (construct a pty, echo a plan-specific phrase). Say that in the docs;
overclaiming unforgeability is how the guard stops being maintained. Second, keep the phrase short
and derived from the plan id (last six chars) so it defeats `yes | lnrelay confirm` without becoming
the friction that motivates a `--yes` patch. Everything else in CODEX §1's plan — payload hash,
10-minute expiry, single use, owner-URN binding, unexported `ConfirmedWrite<T>` as the only engine
input, zero network calls on the unconfirmed path — ships as written.

## 3. Cache substrate

**SQLite. I change position**, though not for CODEX's stated reasons.

Volume does not decide it: a 5k-connection graph is a few MB of JSON and loads fine per invocation,
and `bun:sqlite` is built in so the dependency cost is ~zero either way. What decides it is
disagreement #4. In a single JSON blob, "corrupt" is a whole-store, all-or-nothing condition that
tells you nothing about which records survived. In SQLite, `PRAGMA integrity_check` gives a
detectable, per-source, quarantinable state, and TTL expiry is a transactional delete rather than a
rewrite of the entire file. Having conceded that corrupt-cache must be loud and isolable, I have to
concede the substrate that makes it implementable at record granularity.

Constraint on the concession: keep it behind the same narrow `load/save/upsert/query` interface the
family's JSON store exposes, no ORM, and migrations as plain numbered SQL. The family similarity that
matters is the *interface*, not the file format.

## 4. Corrupt cache

**CODEX is right; I was wrong, and my proposal contains the exact failure he describes.** P3-fable §4
ports load-never-throws (corrupt degrades to empty) and *also* says connections sync is the single
most expensive read in the tool. Compose them: corrupt file → empty cache → `connections --sync`
finds no prior set → full enumeration of the entire graph against the most hostile platform in the
corpus, triggered by a disk error. I wrote both halves and did not put them next to each other.

The precise repair: **never-throw is not never-fail.** The family rule survives on the read path — a
corrupt store must not crash the process. What dies is degrading to an empty *success*. Corrupt store
→ quarantine to `~/.lnrelay/quarantine/<ts>/`, return `CACHE_CORRUPT` (`ok:false`), and refuse all
sync paths until the user purges or acknowledges. An empty result and a lost result must be
distinguishable on disk for the same reason they must be distinguishable in a parse.

## 5. `batch`

**Keep it, CLI-only, tighter than either GROK or I specified.** CODEX's "velocity incident" framing
is right about unattended volume and wrong about rate. With a durable ledger and a cross-process
cooldown both in place, `batch` cannot exceed what the same queries typed by hand would spend — the
permit type and the breaker are the volume control, not the absence of a convenience command. A
challenge on query 3 stops queries 4–12 in every process.

But three tightenings. Cap queries per invocation (10). Abort on the *first* non-200 classification
rather than continuing to the next query. And **drop it from the MCP surface** — a change from my own
proposal and against GROK's `batch` with `--out` required. Over MCP, `batch` is a single-call
amplifier available to the party whose judgment we have already decided not to trust with a
`--confirm` flag. A human typing `lnrelay batch --file queries.txt` has made a deliberate decision;
an agent emitting one tool call has not.

## 6. If the phase-0 spike fails

**I refine rather than reverse, and the refinement is that "the spike failed" is three different
events with three different correct branches.** None of the three proposals separated them.

- **Detection failure** — 999, challenge, or login redirect at three human-paced requests from a
  residential IP with fresh cookies. *Abandon.* The only remaining path is a browser, and the thing
  that blocked you is precisely the thing a browser would be evading. GROK's "rescope to a
  browser-backed engine and re-evaluate" is wrong here: it reads the result of a detection experiment
  as a transport-selection problem.
- **Token failure** — requests work only with a value that cannot be reproduced without executing
  LinkedIn's JS. Same branch: abandon.
- **Maintenance failure** — requests succeed, but queryIds rotate daily or the response is SDUI-opaque.
  This is not a detection result and abandoning is an overreaction. Narrow to the Rest.li-only subset
  (my kill criterion #2), and if that is too thin, take **CODEX's rescope to an offline archive over
  LinkedIn's own user data export** — a product I did not consider and which is legitimate, durable,
  and covers a real fraction of the research use case.

A browser hot path is not a branch in any of the three. It inherits SDUI opacity and drift, adds DOM
churn, and — per R1 — its bug cluster is ambiguous UI state (double-fired messages, Follow-vs-Accept),
which is worse than a transport bug because it is a *write* bug visible to third parties.

## Strongest idea I did not have

**CODEX's `OperationContract` with compiled provenance** (P1-codex §2): only `verified` contracts
compile into the public registry; `discovered`/`inferred` cannot back a shipped command. I had the
same rule — P3-fable §2, "a 🔩-tagged endpoint may not back a shipped command" — as a *documentation
convention* enforced by whoever remembers. CODEX makes it a build artifact. This stings, because one
section later (§6) I attacked R5 for exactly this: leaving drift prevention social when a ten-line
test would mechanize it. I applied my own standard to the family's skill generator and not to my own
endpoint discipline. CODEX's version ships.

Second, **CODEX's `fetch.state: "complete" | "partial" | "unknown"` as a required field on every
collection payload**. Mine was `meta.partial?: boolean` — optional, and two-valued. Both are wrong.
"Unknown" is a real and common state (we followed cursors and cannot prove exhaustion), and an
optional boolean silently defaults to the reassuring answer when the field is absent, which is the
same class of bug as the accept-list.

Third, small but free: **GROK's `risk` as an MCP-exposed read tool**. I put budget state in every read
envelope, which is after the spend. A pre-flight tool lets the agent check the breaker before it
decides to research, and costs one registration.

## Where another proposal is wrong or dangerous

**GROK §2.3, the 429 row: "at most 1 polite sleep-retry on pure 429 with header; then terminal."**
This is the most dangerous line in the three documents, and it contradicts GROK's own architecture two
sections later — §5.2 builds a durable risk-state lockout, and dissent #5 says "the real safety is
fail-loud + risk-state lockout, not a magic 20." The transport table then hands back a free retry. On
LinkedIn the 429 is the warning shot on R2 §1's escalation ladder; retrying into it is the documented
mechanism by which a throttle becomes a restriction. It is also structurally incompatible with the
cross-process breaker the panel already converged on — the breaker's premise is that it opens on the
*first* signal, and a transport that sleeps and retries has consumed the signal before the breaker
sees it. Worse, the sleep happens in an unattended process with the human gone. Zero retries, and the
`retryAfterMs` is information printed for a person, not permission for the process.

**GROK §1.1, `inbox` and `conversation` as "CLI-only" reads.** CLI-only is not a protection in this
family — the agent has Bash. This is the same defect as `--confirm`, which we just agreed is
insufficient for writes because the agent can type the flag; the agent can equally type `lnrelay
inbox`. And the payload is the worst-shaped data in the design: other people's private messages,
pulled into an agent's context, under R4 §4. If a write needs an unforgeable capability, a DM read
needs more than a table column. Cut, as I cut it in P3-fable.

**CODEX §4, unconditional 30-day expiry on every third-party projection.** Combined with 30
profile-detail reads per day, a two-month research project silently re-fetches its own corpus and
spends its budget on data it already had — my falsifiable assumption #8, which CODEX's design makes
certain rather than merely possible. Fix without weakening retention: expire the *body* and keep an
identity stub (`urn`, `publicId`, `capturedAt`, `expiredAt`). No personal data survives, re-fetch
becomes a visible choice, and the budget accounting can say "14 of these 20 profiles are re-fetches
of expired records" instead of quietly charging for them.
