# Decision record — how this tool writes to LinkedIn

Consolidates `docs/research/W1-W4` and the DESIGN.md §2 revision into one place, because the
reasoning had scattered across four research lanes and three commits.

**Status: `share` VERIFIED LIVE 2026-08-13 — a real post, HTTP 201. `delete` built but not yet
exercised. `comment`/`react` blocked on one capture.**

---

## 1. The problem that forced this

`docs/DESIGN.md` ratified LinkedIn's official `w_member_social` OAuth scope as the *sole* write
transport, on the reasoning that reads have no sanctioned path and therefore accept Voyager risk,
while writes do have one and so don't get to spend the same currency.

That reasoning was sound and remains sound. It had one unexamined premise: that the sanctioned path
is *reachable*. It is not, for everyone.

`w_member_social` needs a registered developer app → which needs an associated LinkedIn **Page** →
which needs a company. The owner of this tool has no company and does not want to create a Page for
one that doesn't exist. So the design's only sanctioned route is closed, and the design's fallback
rule ("omit the command") would mean: **no way to post to your own feed from your own tools.**

That is a real gap, not a hypothetical.

---

## 2. What was evaluated

| Option | Transport | Verdict |
|---|---|---|
| **A** | Raw HTTP to Voyager with the cookies we already hold | **Chosen** |
| **B** | Drive the real composer UI over CDP | Rejected — failure mode |
| **C** | `fetch()` inside the real page's JS context over CDP | Deferred — viable, not needed yet |
| **D** | `browser-use` / `agent-browser` / Claude in Chrome / cua.ai | Rejected — wrong shape |
| **E** | Paid relays (Unipile, PhantomBuster, HeyReach) | Rejected — out of scope, costs money |

### Why A won

1. **Detection.** LinkedIn is *confirmed* (W4, Castle.io reading their live JS) to run client-side
   checks on `navigator.webdriver`, Selenium markers, and ~1,000+ extension IDs. Raw HTTP **never
   executes that JS at all** — structurally immune to the one detection mechanism we have hard
   evidence for. CDP-driven browsing walks directly into it and needs stealth patching to survive.
2. **Legal exposure is identical.** §8.2 item 13 bans automated commenting/liking/sharing *regardless
   of transport*. A browser executing LinkedIn's own JS is still "software used to access the
   Services". B buys zero contract-risk reduction (W4).
3. **Failure mode — the deciding factor.** A raw POST returns a status we can read. A script driving
   the composer can post the wrong text, post twice, or report success on a UI that never submitted
   ("phantom success", W3). LinkedIn's composer migrated ProseMirror → Quill → Lexical within 2026
   alone. For an action that is public under the owner's name and cannot be un-seen, deterministic
   failure beats a speculative detection margin.
4. **Cost.** Zero new dependencies. A already reuses the client, ledger, breaker, pacing and confirm
   gate. B/C add CDP orchestration; D adds a Python runtime and a model API key to an npm package.

### The finding that outranks all of the above

**Cadence swamps transport** (W4, strongest-attested item in the entire evidence base). Fast
*manual, zero-automation* browsing alone has triggered restrictions. That signal is evaluated on the
account's action stream, server-side, and applies identically however the bytes were produced.

One or two confirmed writes a day is a bigger lever than the A-vs-B choice. Spend the risk budget
there.

---

## 3. How the design rule was honoured rather than overturned

DESIGN.md said: *"never fall back to Voyager **silently**."* Every word is load-bearing, and the
fallback is allowed — the silence is not.

- OAuth still wins whenever a live token exists. Voyager is the fallback, not the default.
- An **expired** token does *not* demote to Voyager. The owner chose the sanctioned path; moving them
  onto the private API because a token aged out is the one substitution that would actually betray
  them. They are told to renew, and may pass `--via voyager` if they mean it.
- The confirmation prompt names the transport and carries a **different risk sentence per transport**,
  because the truth differs. Claiming §8.2 on a sanctioned OAuth write was crying wolf, and devalued
  the warning on the transport that has earned it.
- `--via voyger` (misspelled) is **refused**, not ignored — ignoring it would post over whichever
  transport happened to be the default.

---

## 4. What is built, and what that means

| Piece | State |
|---|---|
| `engine/voyager-write.ts` — `share` | ✅ **Verified live 2026-08-13 — 201 Created, real post** |
| `engine/voyager-write.ts` — `delete` | Built, not yet exercised |
| `commands/transport.ts` — transport choice | Built and tested |
| Confirm gate, budget ledger, breaker, pacing | Unchanged, already applied to writes |
| `share` over OAuth | Built, unusable without a Page |
| `comment` / `react` over Voyager | **Deliberately refuse** — see §5 |
| `delete` | Not built |

**Closed 2026-08-13.** The `share` payload — the convergent shape of four independent OSS clients —
was right first time. It created a real public post and LinkedIn answered **201 Created**. `share`
now meets the same bar as every read in this tool: it returned a success status on this machine.

It also exposed a bug worth recording. The classifier accepted **only** 200, because reads never
return anything else, so that first successful post was reported as `FETCH_FAILED: unexpected status
201` *after the post was already live*. Reporting a success as a failure is the worst direction to
be wrong in for a write: the user re-runs the command and posts twice. `delete` returns 204 and
would have failed identically. Fixed to accept any 2xx, with an empty body treated as a normal write
outcome rather than the "claimed but empty" drift a read would signal.

---

## 5. Why `comment` and `react` refuse

Each has exactly **one** OSS sample, and each contradicts this project's own verified read-side
finding about which urn identifies the target:

- **comment** — the sample sends `updateId: "activity:<id>"`. Our verified reads needed the composite
  `urn:li:fsd_socialDetail:(<postUrn>,<postUrn>,urn:li:highlightedReply:-)`, percent-encoded.
- **react** — the sample sends `threadUrn=urn:li:activity:<id>`. Our verified reads needed a
  **ugcPost** urn, and ENGINE-RESEARCH.md §5b explicitly warns the two cannot be derived from each
  other.

A wrong urn here does not error. It acts on the wrong post. That is the exact class of silent failure
this project was built to refuse, so both return `NOT_IMPLEMENTED` with instructions rather than
guessing.

---

## 6. Build order

### Next — `delete`, before anything else is verified

Non-obvious but correct. Reasons:

- It is the **best-evidenced operation in the whole research** (W1 §4): two independent
  implementations, one of which — Polypost's `cdp-delete-share.mjs` — was demonstrably run against
  production and asserts on a real `204`.
- It makes every subsequent test **reversible**. Right now the only remedy for a bad test post is the
  LinkedIn UI.
- It specifically covers the scariest way `share` could be subtly wrong: `visibleToConnectionsOnly` is
  a **boolean**, inverted from OAuth's `visibility` enum. If that mapping is backwards, a
  connections-only post goes public. Delete is the remedy.

`DELETE /voyager/api/contentcreation/normShares/{url-encoded urn}` — headers: `csrf-token` +
`x-restli-protocol-version` only.

### Then — verify `share` live

One throwaway post whose text is harmless at either visibility. Wrong payload costs a 4xx and posts
nothing. Right payload returns a urn, which `delete` then removes.

### Then — capture, and unblock `comment` + `react`

`bun run scripts/observe-write.ts`, perform each action once by hand in the debug Chrome. The capture
settles both urn contracts from ground truth instead of from a single contradicted sample. Credentials
are redacted before anything touches disk.

### Optional, later — transport C (in-page `fetch` over CDP)

The genuinely novel option, and the only one with no mature reference implementation (W2 found only
0–3★ hobby repos). Issue the request *from inside the logged-in page*: real cookies, real Origin,
real TLS fingerprint — because it really is the browser making the call — while the payload stays
ours, so it keeps A's determinism and loses none of it to DOM coupling.

Worth building if evidence ever emerges that raw HTTP is fingerprinted at the TLS layer. Not worth
building on speculation.

---

## 7. Closed — not building, and why

- **UI driving (B).** Phantom success. Disqualifying for a public, irreversible action.
- **`browser-use`.** Excellent library, wrong job. Python-only (the npm SDK is the *cloud* client; the
  TS port is archived), LLM-agent loop with no first-class scripted mode, built to navigate unfamiliar
  sites when we already know the exact request. Right tool for open-ended feed work; wrong dependency
  for a deterministic POST.
- **Claude in Chrome.** Cannot run unattended — needs a live signed-in Claude session, explicitly not
  API keys.
- **cua.ai.** Cloud sandbox with its own browser and no session-reuse path. Wrong session, wrong
  determinism, new IP.
- **`unreact`.** No source anywhere implements it. A symmetric `DELETE` is a guess, and guessing is
  what §5 exists to prevent.
- **Connect / message / invitations.** Cut by design, permanently. This is where the enforcement
  reports cluster and where a bug is third-party-visible and unrecoverable.

---

## 8. Standing rules, unchanged

- Every write asks a human at a TTY, shows exactly what it will send and over which surface, and
  requires a token derived from the payload. **There is no `--yes`, and there will not be one.**
- No TTY → no write, and no network call on that path.
- Writes are never exposed over MCP. Not disabled — not registered.
- Zero automatic retry. A 429 or 999 opens a cross-process cooldown file.
- Single account, residential IP, jittered pacing.
- The write budget is 10/day and is `guessed`, not measured — as §2 established, cadence is the real
  lever.
