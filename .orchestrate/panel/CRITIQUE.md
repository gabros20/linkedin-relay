# Round 2 — cross-critique

All three proposals are now on disk. Read the two that are not yours, in full:

- `.orchestrate/panel/P1-codex.md` — CODEX (GPT-5.6-Sol)
- `.orchestrate/panel/P2-grok.md` — GROK (grok-4.5)
- `.orchestrate/panel/P3-fable.md` — FABLE (Fable 5)

You already know the research; do not re-read it unless a specific claim needs checking. The
controller will synthesise one design from all three, so the purpose of this round is to **resolve
disagreements, not to restate your proposal**.

## The panel converged on (do not re-argue these)

HTTP-first Voyager with CDP cookie bootstrap and no stealth-browser hot path; a phase-0/1 live
viability spike as the gate on the entire architecture; zero automatic retry on 429/999/challenge
with a **cross-process, file-based** circuit breaker; exclusion-only parsing with unknown types
surfaced rather than dropped; URN index built in one pass, then resolve; `fs_*`/`fsd_*` namespace
collapse; no snowflake-watermark for connections; pacing reads as conservatively as writes; rate
numbers carried with explicit provenance rather than asserted; single-account by construction; writes
absent from the MCP registry entirely; ToS breach stated plainly, never claimed compliance.

## The six live disagreements — rule on each

Answer each one directly. Say which position you now hold, **including where you are changing your
own**, and give the reason in one or two sentences. Changing your mind under a better argument is the
point of this round, not a loss.

1. **Write surface.** CODEX ships only OAuth `share`/`comment`/`react`/`unreact` and cuts connect,
   follow, message, and invitations entirely. FABLE ships the same OAuth three, plus Voyager
   `connect`/`follow`/`invitations`, and cuts messaging entirely. GROK keeps a broader Voyager write
   set with connect/message deferred to a later phase. Which write surface ships in v1?

2. **Confirmation mechanism.** CODEX argues a `--confirm` flag is insufficient because an agent can
   simply write the flag, and replaces it with a typed `WritePlan` on disk plus a separate `confirm
   <plan-id>` command that requires an interactive TTY, rejects piped input, expires in 10 minutes,
   and is the only producer of an unexported `ConfirmedWrite<T>` capability. FABLE and GROK both use
   the family's `--confirm` flag. Is CODEX's two-step plan/confirm worth the ergonomic cost, or is it
   over-engineering that will push the user toward a `--yes` escape hatch?

3. **Cache substrate.** CODEX chooses SQLite with WAL and transactional migrations, arguing that
   TTL expiry, FTS, and sync checkpoints need relational integrity. FABLE and GROK both port the
   family's JSON-file store. Which ships?

4. **Corrupt cache.** The family rule is load-never-throws: a corrupt file degrades to empty. CODEX
   dissents that on this platform an empty cache triggers the largest possible sync against the most
   hostile platform, and demands quarantine plus a loud `CACHE_CORRUPT`. FABLE explicitly ports the
   family rule. Who is right?

5. **`batch`.** GROK and FABLE keep it (reads-only, flush per query). CODEX cuts it, arguing it
   "exists chiefly to turn a personal tool into a velocity incident." Ship it or cut it?

6. **If the phase-0 spike fails.** FABLE says abandon outright — a Patchright hot path is a
   permanently rotting dependency and a different, worse project. GROK says rescope to a
   browser-backed engine and re-evaluate. CODEX says stop the HTTP design and narrow or kill rather
   than escalate to evasion. What is the actual correct branch?

## Then: attack

Two more sections, and be specific — name the file, section, and claim.

- **"Strongest idea I did not have."** One or two things from another proposal that you think should
  survive into the final design, and why. Be honest even where it undercuts your own.
- **"Where another proposal is wrong or dangerous."** The specific decisions in the other two you
  think would cause real harm — to the user's account, to correctness, or to maintainability. If you
  believe a proposal's core bet is unsound, say so plainly. Do not manufacture disagreement where you
  actually agree; a short, sharp critique beats a padded one.

## Output

Write to the path in your task line. Markdown, **1,200–2,000 words** — this round is short and
decisive, not another full design. No preamble.
