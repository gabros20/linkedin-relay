# C2 — GROK cross-critique

**Panelist:** GROK · **Against:** P1-codex, P3-fable · **Own:** P2-grok

---

## The six live disagreements

### 1. Write surface — which ships in v1?

**Position now: CODEX’s OAuth-only surface wins for v1.** Ship `share`/`publish`, `comment`, `react`, and `unreact` only if live OAuth verification covers them; cut `connect`, `follow`/`unfollow`, `message`, and `invitations` from v1 entirely — not deferred, not “phase 3+.”

**Where I change:** My proposal kept Voyager `follow` in phase 4 and parked `connect`/`message` for phase 5 “if risk-state stays clean.” That still treats outreach automation as inevitable product debt. FABLE’s cut of messaging is correct and sharper than my deferral: R1’s double-fire / wrong-thread bugs (#573, #483) plus R2’s “MCP works for reading, not for writing (connections, messages)” make messaging a third-party-visible unrecoverable failure class. FABLE’s inclusion of Voyager `connect`/`follow`/`invitations` is the wrong half of their fork — those are exactly the Professional Community Policies artificial-engagement vectors (R4) with no legitimacy wedge.

**Reason:** R3 §6 already hands us the only self-serve legitimate write path (`w_member_social`). Paying professional-identity risk for Voyager convenience on graph actions is a bad trade (FABLE’s dissent §1, which I under-weighted). Research is the product; self-originated content writes are the defensible boundary CODEX names. My “optional OAuth later” was too soft — FABLE’s **structural** OAuth/Voyager split (Voyager client type has no methods for share/comment/react) should survive into the final design even when the Voyager social-graph writes do not.

---

### 2. Confirmation mechanism — plan/confirm vs `--confirm`?

**Position now: CODEX’s two-step plan/confirm is worth the ergonomic cost.** Adopt typed `WritePlan` on disk + separate `confirm <plan-id>` that requires an interactive TTY, rejects piped input, expires (~10 minutes), and is the only producer of an unexported `ConfirmedWrite<T>` capability.

**Where I change:** I (and FABLE) used family-standard `--confirm`. CODEX’s objection is decisive: an agent that can compose CLI args can simply append the flag; the gate then protects only forgetful humans, not the actual threat model (agent-driven bulk or casual loops).

**Reason:** R4 §3’s blast radius is permanent professional identity, not a burner X account. A slightly annoying confirm ritual is cheaper than one agent loop that posts or, if Voyager writes ever return, connects under a flag the model invented. Do **not** add a `--yes` escape hatch — that is how the gate dies. Ergonomics lose to structural incapability: the write engine never accepts a raw args bag, only a capability only `confirm` can mint. Keep writes off MCP entirely (panel convergence) so the TTY path is the sole live write path.

---

### 3. Cache substrate — SQLite vs JSON files?

**Position now: SQLite (WAL + migrations), with CODEX.** Change from my JSON-file port.

**Where I change:** I ported `~/.lnrelay/{connections,posts,saved,meta}.json` for family shape. That was comfort, not necessity.

**Reason:** The product value of a local graph is offline query after sync (CODEX’s `local` + FTS). TTL expiry on third-party rows, sync checkpoints with overlap membership, and transactional “delete expired then upsert” are awkward and race-prone as multi-file JSON. SQLite makes CODEX’s quarantine story (§4 below) trivial. Family DNA is network quarantine and pure parse modules, not “JSON or die.” Bun’s SQLite story is good enough; the complexity pays for retention integrity on the one platform where a mistaken full resync is itself a safety incident.

---

### 4. Corrupt cache — empty degrade vs quarantine?

**Position now: CODEX is right.** Quarantine the corrupt store and return loud `CACHE_CORRUPT`; never treat corruption as empty.

**Where I change:** I restated R5 load-never-throws. FABLE ports it explicitly. Both are wrong for LinkedIn.

**Reason:** On X, empty-cache recovery is cheap annoyance. Here, empty-looking cache is the trigger for the **largest** possible sync against the **most** hostile host (CODEX §4 / dissent §3). That turns a disk fault into a restriction-shaped traffic spike. Loud failure forces human diagnosis; silent empty invites automation to “helpfully” re-hydrate the world. Keep atomic writes and careful open paths — but corruption is an error class, not an empty map.

---

### 5. `batch` — ship or cut?

**Position now: cut as a productized MCP/agent primitive; keep only a CLI-only, budget-bound archive helper if anything.** Prefer CODEX’s instinct over my MCP-exposed `batch`.

**Where I change:** I shipped `batch` on MCP (with `out` required) and FABLE keeps reads-only batch. The research-archive use case is real; the agent-velocity hazard is larger.

**Reason:** CODEX’s line — batch “exists chiefly to turn a personal tool into a velocity incident” — is only slightly overstated. R2’s actionable finding is that **read velocity alone** restricts accounts. A first-class multi-query command is a ready-made amplifier for agents that already ignore skill prose. Serialized flush-per-query (R5 scar #2) is necessary *if* multi-query exists, but the safer v1 is: no `batch` tool in the registry; humans who need archives compose shell loops under the same cross-process budget and cooldown every single command already checks. If synthesis insists on a command, it must be CLI-only, default long delay, hard-capped N, and absent from skill funnels that say “sweep then rank.”

---

### 6. If the phase-0 spike fails — what branch?

**Position now: stop the HTTP design; narrow or kill; do not escalate to a Patchright/stealth hot path.** Align with CODEX + FABLE against my earlier “rescope to browser-backed engine.”

**Where I change:** P2 §8 kill criterion 1 offered (a) Patchright rescope or (b) abandon. That (a) is the evasion arms race CODEX names and FABLE correctly rejects as “a different and worse project” with a permanently rotting dependency (stealth-plugin category already deprecated; R1 avoid list).

**Reason:** The panel’s HTTP-first bet is falsifiable. Failure at residential own-session paced reads means the thin-relay product is dead, not that we should adopt stickerdaniel’s failure modes (UI-state ambiguity, double-message, Follow vs Accept). Optional separate products CODEX allows — offline archive of user export, or browser-assisted *manual* research with no programmatic writes — only if the user explicitly accepts a different project. Default correct branch: **abandon linkedin-relay as designed**, document the spike failure, do not ship stealth.

---

## Strongest idea I did not have

**1. FABLE’s three-state resolution + `SCHEMA_DRIFT` on empty `included` (P3 §3 rule 4).**  
I had exclusion-list parsing, claimed/returned honesty, and per-item isolation. I did **not** crisply separate (a) field absent = genuine empty, (b) referenced and resolved = data, (c) referenced but missing from `included[]` = failed decoration → `meta.unresolved` + `partial`. Nor did I elevate “`data` references + empty `included`” to a buildable-now drift signal analogous to x-relay’s features-null scar. That is the sharpest LinkedIn-shaped application of R5’s empty-vs-failure lesson in the whole panel, and it needs no live capture to implement. It should ship in the final parser contract verbatim.

**2. CODEX’s `WritePlan` / `ConfirmedWrite<T>` capability (P1 Writes §).**  
I treated confirmation as a boolean flag check. CODEX treats it as a typed, expiring, TTY-gated capability no agent can forge by string concatenation. Combined with sealed owner URN on credentials/plans, that is the right structural answer for this blast radius. Pair it with FABLE’s structural OAuth fork (official writes cannot be sent on the Voyager client type) and the write half becomes both legitimate where possible and agent-resistant where not.

Honorable mention I will not re-expand: FABLE’s branded `Permit` for budget (compile-time no-unaccounted-fetch), FABLE’s 2-page slack for pinned posts on own-posts sync, and CODEX’s compound overlap checkpoint `{lastSuccessfulAt, headIds[], newestCreatedAt?}` instead of a scalar timestamp pretending to be a snowflake.

---

## Where another proposal is wrong or dangerous

### FABLE — Voyager `connect` / `follow` / `invitations` in the write table (P3 §1)

FABLE’s thesis that research reads buy something irreplaceable while most writes do not is excellent — then the table re-introduces the highest-ban graph actions over Voyager because “no official path exists.” Absence of an official path is an argument for **not shipping**, not for routing them through the hostile channel. R2 clusters adverse field reports on connection/message automation; R4 names artificial engagement. Shipping these (even CLI-only, even with `--confirm`) invites the skill and the human to treat lnrelay as Expandi-class outreach. **Cut them from v1.** Messaging cut is correct; follow/connect should follow messaging out the door.

### FABLE — corrupt cache degrades to empty (P3 §4 “load-never-throws”)

Explicit port of R5 is dangerous here. Named above; repeating only for file/section: P3 §4 store mechanics. On this platform empty cache is not graceful degradation — it is a sync bomb.

### FABLE — abandon is right; any soft “thin wrapper around stickerdaniel” as honest fallback (P3 §8.1)

FABLE says abandon rather than pivot to browser automation, then names wrapping stickerdaniel as the “honest fallback.” That wrapper reimports DOM ambiguity and anti-detection gravity. Prefer CODEX’s clearer kill: stop HTTP design; only a *different* product (manual research aid, no programmatic writes) under explicit user acceptance. Do not document stickerdaniel-wrap as the continuity path for “linkedin-relay.”

### CODEX — cutting `batch` is directionally right; cutting all multi-query ergonomics is not the harm

CODEX is not dangerous here; over-cutting research archive affordances is a product sharpness issue, not an account-safety one. Safety-wise CODEX is the floor we should not go below on velocity.

### CODEX — `unreact` only if OAuth covers it (P1 Writes)

Correct discipline. The danger would be silent Voyager fallback for gaps in OAuth — CODEX forbids that; keep the forbid.

### My own P2 — residual dangers others should not adopt

- **Phase 5 `connect`/`message`:** do not keep as roadmap gravity; delete from the registry vision.
- **MCP `batch`:** do not ship; I was wrong.
- **Browser rescope on spike failure:** do not ship; I was wrong.
- **“At most 1 polite sleep-retry on pure 429” (P2 §2.3):** panel convergence is zero automatic retry on 429/999/challenge. My single polite 429 retry was family residue and should die; FABLE/CODEX zero-retry + file cooldown is the bar.

### CODEX vs FABLE on notifications / saved / inbox

Agreement with both: leave unverified endpoints out until capture. FABLE’s refusal to design saved-items fiction is cleaner than my stub-with-`NOT_IMPLEMENTED`. CODEX’s omission of notifications is correct. My CLI-only `inbox`/`conversation` still means holding third-party private messages on disk-capable machines — FABLE’s total cut is safer under R4 §4; I yield.

---

## Synthesis-ready stance (one screen)

| Topic | GROK now |
|---|---|
| Writes v1 | OAuth `share`/`comment`/`react`(+`unreact` if real); no Voyager graph writes; no messaging |
| Confirm | WritePlan + TTY `confirm` → `ConfirmedWrite<T>`; no `--yes` |
| Cache | SQLite WAL; 30d third-party TTL; no third-party lake by default |
| Corrupt cache | Quarantine + `CACHE_CORRUPT`, never empty |
| `batch` | Not on MCP; preferably no command — shell under budget |
| Spike fail | Kill/narrow HTTP product; no Patchright hot path |
| Parser must-take | FABLE three-state unresolved + empty-`included` ⇒ drift |
| Write must-take | FABLE OAuth structural split + CODEX capability confirm |

The controller should not average the three proposals into “OAuth three plus a little connect.” The live disagreement on writes resolves **toward CODEX narrowness**, confirmation and cache integrity **toward CODEX strictness**, parser emptiness honesty **toward FABLE precision**, and spike failure **toward abandon-not-evade**. My original proposal’s best survivors are research-first scope, exclusion-list parsing, set-diff connections, heuristic-labeled budgets, and risk-state lockout — not the deferred outreach surface or the browser contingency.
