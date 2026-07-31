# Rulings on the six disagreements

## 1. Write surface

I hold the CODEX position: v1 ships only the official OAuth surface—`share`, `comment`, and `react`, with `unreact` included only if live verification proves the same sanctioned transport supports it. Voyager `connect`, `follow`, invitation handling, and messaging do not ship: these actions add little irreplaceable value, while connection and outreach automation concentrate both account-enforcement risk and socially irreversible failure modes.

FABLE is right to cut messaging, but stopping one step short of the same reasoning for connection requests and invitations is inconsistent. A confirmation makes the user's intent legible; it does not make the resulting traffic less detectable, prevent a bad target resolution, or undo the reputational effect of an accidental invitation.

## 2. Confirmation mechanism

I retain CODEX's two-step `WritePlan`/`confirm` design. In an agent-driven CLI, `--confirm` is merely another token the agent can place in its own command, so it does not establish a meaningful human boundary; a short-lived, owner-bound, payload-hashed plan followed by a separate interactive TTY action is proportionate when v1 has only three or four writes.

The ergonomic objection is real but not decisive. There must be no `--yes`, environment-variable, piped-input, or config escape hatch; if users find the deliberate confirmation intolerable, the right conclusion is that this tool should not perform writes for them, not that the safety boundary should become optional. I would document plainly that TTY presence is an accident-prevention barrier rather than proof of human identity—an agent with unrestricted terminal control may still emulate a TTY—but it is materially stronger than a same-invocation boolean.

## 3. Cache substrate

SQLite ships. The cache is not just a serialized response bag: source membership, canonical URN identity, TTL deletion, FTS, completeness metadata, and compound sync checkpoints must change atomically, and SQLite gives those invariants one transactional boundary with a much smaller custom recovery surface than several mutually dependent JSON files.

WAL is not a reason to cache more data. I accept FABLE's minimization argument below: third-party research results should be ephemeral unless explicitly retained, while the records the user elects to retain can still live in SQLite with enforced TTLs. JSON remains appropriate for small, replaceable files such as the circuit-breaker state, not for the relational research store.

## 4. Corrupt cache

CODEX is right: corruption must quarantine the store and return a loud `CACHE_CORRUPT`, never impersonate an empty cache. “Load never throws” is still a useful API property if it means callers receive a typed failure rather than an uncaught exception; it must not mean silently converting unknown data loss into a valid empty state.

On this platform, empty is operationally active: it invites the largest possible network sync. FABLE's port of the family rule therefore converts a local integrity failure into account risk and can also erase the distinction between “the user has no records” and “we lost the user's records.” Recovery should preserve the corrupt database for inspection, require an explicit rebuild decision, and perform no LinkedIn request automatically.

## 5. `batch`

Cut `batch` from v1. Serialized execution, per-query flushing, and a global ledger make it less reckless, but they do not restore the human decision point between searches; a malformed or overbroad input file still turns one invocation into an unattended sequence against a platform with no credible safe rate envelope.

This is not a permanent architectural ban. After the live gate and a period of healthy single-query use, a later CLI-only bounded workflow could be reconsidered with a small hard item cap, dry-run cost preview, and no MCP registration. GROK's and FABLE's proposed MCP exposure is especially wrong because it makes multi-query expansion an attractive primitive for autonomous agents.

## 6. If the phase-0 spike fails

Stop the HTTP relay design; do not promote Patchright into the hot path. The correct branch is to determine whether a genuinely narrower product remains useful—offline search over a LinkedIn user-data export, or a browser-assisted *manual* workflow that performs no autonomous navigation or writes—and otherwise kill the project.

This agrees with FABLE's rejection of a browser automation pivot and sharpens my own “narrow or kill” language. GROK's suggestion to rescope to a browser-backed engine and re-evaluate leaves the most tempting and maintenance-heavy path open after the load-bearing safety hypothesis has already failed. Failure of direct, human-paced replay is evidence that the project cannot model the platform's detection boundary, not an invitation to add fingerprint and DOM-state complexity.

# Strongest idea I did not have

The strongest addition is the unexported spend `Permit` in [P3-fable.md, §5, “The permit type”]. My proposal centralized requests behind a scheduler and durable ledger, but FABLE makes the relationship structural: no Voyager call can compile unless the ledger has already issued a permit for its spend class. The final design should combine that capability with atomic, cross-process ledger updates and ensure redirects, pagination, and any contract-discovery calls also consume permits; otherwise the most easily forgotten traffic escapes accounting.

FABLE's [§4, “Third-party research reads are ephemeral by default”] also improves my cache policy. A 30-day TTL limits persistence but still creates a third-party corpus automatically from ordinary browsing. Default non-persistence, with explicit `--retain` for selected results and automatic TTL enforcement for those retained projections, better matches data minimization and reduces the damage of a copied cache without weakening the local-first value of owner posts and explicitly synchronized connections. This changes my own position: SQLite should ship, but automatic storage of every viewed third-party entity should not.

# Where another proposal is wrong or dangerous

In [P2-grok.md, §2.3, `client.ts` policy], GROK permits “at most 1 polite sleep-retry” on a 429. That is the wrong loss function for LinkedIn and contradicts GROK's own later hard-lockout posture: the first throttle is the evidence that traffic must cease, and a server delay is information to surface to the human, not authorization for the process to make another request. Zero automatic retry must include 429 without exceptions.

GROK's [P2-grok.md, §2.2, “Auth”] preference for `LNRELAY_COOKIES` or `~/.lnrelay/cookies.json` is also unsafe. `li_at` is effectively a session bearer credential; environment variables leak through process launch configuration and debugging, while an ordinary JSON file is too easy to copy, back up, or attach to a support report. The login flow should place secrets in OS credential storage, bind them to the observed owner URN, and keep only non-secret metadata in the cache directory.

The broader deferred write set in [P2-grok.md, §1.1 and §7] is not made safe by placing it in phase 5. In particular, a `message` command retains the incumbent's known double-send and wrong-thread class of failures while adding a third-party-visible consequence. Stability of earlier read phases proves neither target resolution nor safe behavioral signaling for outreach; connect and message should be absent from the product boundary, not parked on the roadmap where their eventual inclusion becomes the default expectation.

In [P3-fable.md, §1, “The OAuth/Voyager write fork”], the claim that official OAuth makes the three writes “ToS-legal and drift-proof” is too strong and should not survive. OAuth authorizes particular calls under particular product terms; it does not legalize the surrounding Voyager-based tool, and official endpoints, scopes, review rules, and schemas can still change. The accurate claim is narrower: OAuth is the sanctioned and materially lower-risk transport for those operations, subject to live scope verification.

FABLE's [P3-fable.md, §4, “Store mechanics”] corrupt-file-to-empty behavior is the most immediately dangerous correctness defect in either proposal. Atomic rename reduces torn writes but does not eliminate disk corruption, truncation, schema bugs, or manual edits; silently returning empty both hides loss and primes a full sync. This must become quarantine plus typed failure regardless of whether the final substrate is SQLite or JSON.

Finally, [P3-fable.md, §7, P3 research surface] and [P2-grok.md, §6, MCP surface] both expose `batch` during the initial research product, including over MCP. That decision works against their own permit, pacing, and identity-budget arguments: a global cap limits total damage, but batch makes reaching that cap unattended and routine. The first release should make each live query an explicit decision and direct repeated analysis toward cached or user-supplied data instead.
