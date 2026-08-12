# W3 — Browser control and computer-use tooling for driving the real LinkedIn UI

Question: OAuth writes are blocked (needs a company Page we don't have), so writes may have to go through
the real LinkedIn web UI instead of the Voyager REST.li surface `lnrelay` already speaks. What's the right
2026 tool to drive that UI, given the project must reuse the user's **existing, already-logged-in** browser
session and ship as an unattended Bun/TS CLI?

Claim labels: **tested** (ran it myself, this session), **doc** (official docs), **repo** (source I read),
**social** (blog/forum — plausible and specific, but unverified against a primary source), **inferred** (my
reasoning from the above, not directly stated anywhere).

---

## Recommendation

**Extend the plain-CDP plumbing this project already has** (`src/engine/session.ts`, `scripts/observe.ts`) —
don't adopt Playwright, Puppeteer, agent-browser, cua.ai, or an LLM-in-the-loop agent as the *shipped* write
path. Attach to the same debug Chrome the user already launches and logs into (`--remote-debugging-port=9222
--user-data-dir=$HOME/.lnrelay/chrome`), and add a small, purpose-built "compose and post" routine that:

1. drives the composer with genuine CDP `Input.*` events (trusted, real input pipeline — not
   `Runtime.evaluate` DOM writes, which are not),
2. verifies what actually landed by reading the DOM back before submitting, and by watching for the specific
   Voyager write request LinkedIn's own client fires (the same `observe.ts` pattern, pointed at the write
   instead of the read), and
3. fails loudly and stops rather than guessing, at every step where the DOM or editor internals don't match
   what was last observed.

This is more code than `npm install playwright` — but everything else evaluated either (a) doesn't solve the
reuse-the-logged-in-session requirement any better than what's already built, (b) can't run unattended inside
the shipped `lnrelay` binary at all, or (c) is architecturally the wrong shape (nondeterministic
vision-in-the-loop clicking) for "post this exact text and know for certain it posted." Where a real precedent
exists — `stickerdaniel/linkedin-mcp-server` drives a real Chromium against a persistent logged-in profile
(`repo`, cited in `R3-linkedin-surface.md:50-58`) via **Patchright**, a stealth Playwright fork — it's evidence
that *browser-driven writes* is the right general shape for LinkedIn, just not that Playwright specifically is
required to get there; Patchright's entire value-add is patching out one specific CDP leak (`Runtime.enable`),
which is straightforward to just not trigger in a from-scratch CDP client (see [Detection
surface](#detection-surface) below).

---

## Comparison table

| Option | Session reuse | Determinism | Unattended (from shipped `lnrelay`) | Fragility | Weight (cost/latency) | Detection surface |
|---|---|---|---|---|---|---|
| **Plain CDP** (existing pattern) | **Best.** Attaches to the user's own long-lived debug Chrome; cookies + composer are the exact ones the user is logged into. `tested` (this is the running code) | Full — you write the exact script | **Yes** — it's just a WebSocket client in the binary | DOM/editor-internals coupling (see below); no framework buffers you from LinkedIn's markup changes | Cheap — a handful of WS round-trips, no LLM in the loop | Same as any CDP client; `Runtime.enable` is the one common leak, and it's avoidable (`inferred`) |
| **Playwright / Puppeteer** `connectOverCDP` | Can attach to the *same* debug port as above — no better session reuse than plain CDP, just a nicer API on top of it. Automating the OS-default Chrome profile directly is blocked by Chrome policy; needs a separate profile dir either way (`social`, corroborated by this project's own use of a separate `--user-data-dir`) | Full, if scripted (not agentic) | Yes, if bundled — but it's a real dependency (~400MB of browser binaries typically, though `connectOverCDP` mode doesn't need Playwright's own Chromium download) | Same DOM coupling as plain CDP, plus a framework abstraction layer that can itself lag Chrome/LinkedIn changes | Cheap if scripted | Sends `Runtime.enable` by default → detectable leak that stealth forks (Patchright, rebrowser-playwright) exist specifically to patch (`social`) |
| **agent-browser** (installed CLI) | Good — has `--auto-connect` / `--cdp <port>` to attach to an existing debug Chrome, plus `--profile` for a persistent user-data-dir, plus a state-import flow (`state save` from an `--auto-connect` session) `tested` (ran `--help` and read its skill docs) | Full if scripted via its CLI commands (not its own agent loop) | **No, not as shipped** — it's a separate installed Rust binary + background daemon (dashboard on :4848) the CLI would have to spawn and manage; not a library `lnrelay` can embed | Selector/ref-based (`@eN` accessibility-tree refs), which is more robust to markup churn than raw CSS but still snapshot-then-act; its own docs flag "custom input components intercept key events" as a known failure mode with two documented workarounds (`keyboard inserttext` = CDP `Input.insertText`, `keyboard type` = real per-key `Input.dispatchKeyEvent`) — i.e. it already ran into the exact React/rich-editor problem this research was asked to resolve, `tested`/`repo` | Cheap, scripted mode | Same CDP-based surface as Playwright; no stealth patching mentioned in its docs |
| **Claude in Chrome** (`mcp__claude-in-chrome__*`) | Perfect in the sense that it *is* the user's actual Chrome, actual profile, actual login — no cookie handling at all `doc` | Non-goal — it's a conversational agent driving actions per-turn, not a fixed script | **No — hard no.** Requires a live Claude Code/Desktop session, the Chrome extension, native-messaging host, and `/login` OAuth; explicitly **does not work with API keys or `setup-token`** (`doc`, code.claude.com/docs/en/chrome). A shipped `lnrelay post` command cannot invoke this — there is no programmatic entry point outside an interactive Claude session | Whatever the agent driving it decides at the time; also explicitly pauses on CAPTCHA/login for a human | Very high per action if used — full LLM turn per interaction, screenshots optional but page-reads are still model calls | Real browser, real profile → in principle the least detectable *if* it worked unattended, but it can't be invoked unattended, so this is moot for the CLI |
| **cua.ai** | **Poor for this project.** Primarily a cloud sandbox provider (Pro tier, credit-based pricing) with an OSS self-hosted option; isolated Linux/Windows/macOS environments, "protected sandbox execution" — no documented cookie-injection or local-session-reuse path was found `doc`(fetched llms.txt)/`inferred` (absence of docs ≠ proof it's impossible, but nothing supports it) | Depends on the agent loop it runs (vision-based computer use) — not a fixed script by default | Yes, technically (it's designed to run headless in the cloud) — but with the wrong session (its own sandbox browser, not the user's) | High — vision/coordinate-based clicking in an unfamiliar, isolated browser with no existing cookies means it would have to re-authenticate from scratch, which this project explicitly wants to avoid | Heavy — cloud VM + vision agent loop, priced per credit | New/unknown IP + fresh browser fingerprint in a cloud VM is a *worse* fit for "look like the user's normal browsing" than anything CDP-based |
| **browser-use** | Launches/drives a browser itself (can point at an existing CDP endpoint in principle, but its selling point is autonomous multi-step navigation, not session-preserving scripted actions) `social` | LLM-in-the-loop per step by design (2026 CLI 3.0 rewrote it around raw CDP + a small harness, but still agentic, not a fixed script) `social` | Could run headless from a script, but every action costs an LLM call | Medium-high — DOM/vision hybrid, self-correcting but nondeterministic, so a "wrong" post is a real failure mode, not just a crash | One inference call per step, ~1/3 the tokens of Playwright MCP per a 2026 benchmark (`social`) — still far more than a scripted CDP call | Whatever CDP surface it uses underneath; not evaluated for stealth |
| **Stagehand** (Browserbase) | Built around Browserbase's managed/remote browser sessions by default; can point at local Playwright too, but the product's value is the hosted browser infra, which is a *remote* session, not the user's local one | `act`/`observe` are natural-language → LLM-resolved actions; `extract` can be deterministic-ish for reading, but writes go through the LLM-resolution step | Yes, it's an SDK, but built for remote/managed sessions | Medium — one layer of LLM indirection between your intent and the actual click/type | LLM call per `act`, plus Browserbase session cost if using their infra | Managed browser infra is built to look "normal" to sites, but it's not the *user's* browser/IP — wrong tradeoff here since we already have the user's real session |
| **Chrome DevTools MCP** (official) | Drives a real local Chrome (can attach to an existing instance) — built for **live debugging**, not scripted production writes `social`/`doc`-adjacent | Tool-call-per-action via an MCP client (i.e., whatever agent is driving it decides each action) | Only unattended if some other agent framework drives the MCP tools programmatically — same category problem as Claude in Chrome: needs an agent loop present, not a bare CLI | Good for what it's for (console/network/perf introspection); not designed as a "run this exact script" tool | One MCP round trip (+ often one model turn) per action | Real local Chrome — same profile-policy caveats as any local CDP tool |
| **Playwright MCP** (Microsoft) | Same underlying `connectOverCDP` capability as plain Playwright; MCP wrapper is for agent-driven testing workflows, "the default for anything that needs to run unattended" *within CI-style test suites* per current commentary (`social`) — but that's unattended **test execution**, still requires an agent or fixed script authoring the steps | Can be scripted deterministically if you write the tool calls yourself; commonly used agentically | Yes for CI, but again: it's a testing tool being repurposed, and adds an MCP-server + Playwright dependency for what this project needs as three CDP calls | Standard Playwright selector fragility | One MCP round trip per action, cheaper than vision-based agents since it's accessibility-tree based | Same `Runtime.enable` leak as base Playwright unless patched |
| **OpenAI Operator / CUA** | Own sandboxed browser environment (their computer-use models were built around a hosted/sandboxed browser, not "drive my existing Chrome") `social`/`inferred` | Vision-and-reasoning loop, not scripted | Runs server-side/unattended by design, but again: wrong session (not the user's logged-in Chrome) | High — general-purpose computer-use, not site-tuned; LinkedIn's own anti-automation UX (CAPTCHAs, "phantom success" states — see below) is exactly the kind of thing these general agents get fooled by | Full vision-agent loop per step — most expensive category here | Different infra fingerprint than the user's real browser entirely |
| **Anthropic Computer Use API** | Same category as Operator — a model driving *some* screen (could be pointed at a VNC'd version of a real Chrome window, but that's extra plumbing this project doesn't have, and still isn't "attach to the CDP session already used for reads") | Vision/coordinate-based, nondeterministic by construction — the wrong shape for "type this exact string" | Can run unattended as an API call sequence, but per-action cost is real: computer-use tool adds 735 tokens + screenshot image tokens on top of base model rates, every single action `doc` (Anthropic pricing pages, Aug 2026) | High — clicking by pixel coordinates on a page whose layout LinkedIn changes without notice (see the Quill→Lexical migration below) is fragile in a way DOM/selector tools aren't | 735+ tokens/action plus image tokens plus model latency (seconds) per step — orders of magnitude more expensive than a WS round-trip | Whatever browser it's pointed at; not inherently tied to CDP |

---

## Per-option detail

### 1. Plain CDP — what this project already does, and its real limits

`src/engine/session.ts:mintSessionFromBrowser` and `scripts/observe.ts` are both minimal CDP WebSocket
clients: they open `ws://…/devtools/page/<id>`, and use exactly two things — `Network.getAllCookies` (session
minting) and `Network.requestWillBeSent` + `Page.navigate` + `Runtime.evaluate` (traffic observation).
Neither currently drives *input* — `observe.ts`'s "in-page action" argument is a `Runtime.evaluate` expression
like a `.click()` call, which is JS-level DOM manipulation, not real input. `tested` (read both files this
session).

**The core question — does programmatically-set text stick in a React/rich-editor contenteditable — has a
concrete, sourced answer, and it's more specific than "sometimes":**

- Modern rich-text editors (ProseMirror, Quill, Lexical — LinkedIn has used **all three** across a single year:
  ProseMirror → Quill in early 2026, since migrated toward Lexical) keep an internal state model (a Quill
  "Delta", a Lexical "EditorState", a ProseMirror transaction log) that is the *source of truth*, separate from
  the DOM. Writing to `.innerText`/`.innerHTML` directly desyncs the DOM from that model; the editor's own
  re-render then diffs against a model that doesn't match what's on screen and can throw/crash rather than
  silently accept the write. `social` (two detailed DEV.to write-ups by an author who built exactly this
  against LinkedIn's composer: "LinkedIn Quietly Migrated From ProseMirror to Quill" and "The 3 isTrusted:false
  Bugs" — specific enough to read as a real war story, but it's a blog, not a primary source, so treat the
  *mechanism* as credible and the exact class names (`.ql-editor`, `__quill`) as likely stale by the time this
  is implemented).
- These editors also gate on `event.isTrusted`: a `new ClipboardEvent(...)`, `document.execCommand('insertText',
  …)`, and hand-built `beforeinput` dispatch were all tried and all rejected by the editor with `isTrusted:
  false`, per that same source. `social`
- **But `isTrusted` is not uniformly false for CDP-driven input.** This is the load-bearing technical fact for
  this whole recommendation: `Runtime.evaluate`-based `dispatchEvent()` calls are JS-level and always land as
  `isTrusted: false`, but CDP's own `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` commands go through
  Chrome's **real input pipeline** (the same one real keystrokes go through) and the resulting DOM events come
  out `isTrusted: true`. `doc`-adjacent (Chrome DevTools Protocol `Input` domain semantics, corroborated by
  multiple independent write-ups — treat as well-established, if not literally an Anthropic/Google spec
  sentence). That source's failed workarounds were all *JS-dispatched* synthetic events — none of them were
  actual CDP `Input.dispatchKeyEvent` calls. This is the gap plain CDP can exploit that DOM-manipulation-based
  approaches cannot.
- The same author's *working* fix, though, didn't rely on trusted input events either — it located the live
  editor instance on the DOM node (`.__quill`, or walking the React Fiber `memoizedProps`/`stateNode` chain)
  and called the framework's own content API directly (`quill.setContents([...], 'api')`,
  `pmView.dispatch(tr.insertText(...))`), bypassing the event system (and the `isTrusted` question) entirely.
  `social`

**Practical takeaway for this project:** there are two viable CDP-native paths, in order of preference —
(a) real per-character `Input.dispatchKeyEvent` sequences (trusted, survives the editor being swapped out from
under you since it never touches the framework's internals, but slower — one WS round trip per keystroke and
needs the target element focused first), and (b) reaching into the live editor instance and calling its own
API (fast, atomic, but version-coupled to whichever rich-text library LinkedIn is running that week — must be
detected and failed loudly, not guessed, if the expected instance shape isn't found). Start with (a); treat (b)
as an escalation only if (a) proves unreliable in live observation, and gate it behind an explicit
"editor library fingerprint" check so it fails instead of silently writing into the wrong internal API shape
after the next LinkedIn redesign.

### 2. Playwright / Puppeteer `connectOverCDP`

Both can attach to the exact same `--remote-debugging-port=9222` endpoint this project already opens — so as a
*session-reuse* mechanism they're equivalent to plain CDP, not better. Two real gotchas found:

- Chrome policy blocks automating the **default** profile directory — pointing `userDataDir` at the regular
  `~/Library/Application Support/Google/Chrome` profile can silently fail to load pages or exit. `social`. This
  project already sidesteps this by having the user launch Chrome with a **dedicated**
  `--user-data-dir="$HOME/.lnrelay/chrome"` (`session.ts:36`) — a separate, persistent, real profile the user
  logs into once and Chrome remembers. That pattern is correct and should be kept regardless of which layer
  drives the input.
- Both send CDP's `Runtime.enable` by default as part of normal setup, which is a well-known, specifically
  fingerprinted leak — enough that dedicated stealth forks (Patchright, rebrowser-playwright) exist *solely* to
  patch it out, executing script in isolated contexts instead. `social`. Since this project's own CDP client is
  hand-rolled, it can simply never call `Runtime.enable` in the first place (it's only needed to *subscribe* to
  console/exception events — `Runtime.evaluate` as a bare command doesn't require it), which gets the same
  benefit Patchright ships as its whole reason for existing, for free. `inferred`

Given plain CDP already covers session reuse and the trusted-input mechanism, adding Playwright/Puppeteer here
would mean carrying a large dependency (browser automation framework + its own event/selector abstractions)
to get an ergonomics improvement, not a capability this project doesn't already have.

### 3. agent-browser

Installed and working (`tested`, ran `agent-browser --help` and `agent-browser skills get core --full`). It's
a real, capable, general-purpose CDP-based automation CLI with a daemon/dashboard (port 4848), a session/auth
vault, and `--auto-connect` / `--cdp <port>` flags that mean it **can** attach to the project's existing debug
Chrome and reuse its cookies (there's even a documented recipe for exactly this: `--auto-connect state save
./auth.json`). Its troubleshooting docs independently confirm the contenteditable problem this research was
asked to chase down — "Some custom input components intercept key events," with `keyboard inserttext` (CDP
`Input.insertText`) and `keyboard type` (real per-key events) offered as the two fixes, matching the two CDP
mechanisms above almost exactly.

It is a legitimate tool for **interactively prototyping** the composer flow — snapshot the accessibility tree,
find the "Start a post" button and the editor by role/text instead of guessing CSS, iterate fast. It is a poor
fit for the **shipped write path** in `lnrelay` itself: it's a separate Rust binary with its own background
daemon that the CLI would have to detect, install, and manage as an external dependency, for a task (type text,
click a button, verify) that's a few hundred lines of CDP client code this project already has half of.
Recommendation: use it as a **development tool** while building/debugging the composer routine (much faster
iteration than raw CDP scripting), but don't make the shipped binary depend on it.

### 4. Claude in Chrome

This is the sharpest line in the whole evaluation: it is only ever "the agent can use this in a conversation,"
never "the shipped `lnrelay` binary can use this unattended." Per Anthropic's own docs (`doc`,
code.claude.com/docs/en/chrome, fetched this session): it requires the Claude in Chrome extension, a native
messaging host, an active Claude Code/Desktop session signed in via `/login`, and explicitly **does not work**
with API-key or `setup-token` auth — i.e. there is no service-account/headless credential path for it at all.
It's also architecturally a per-turn tool: "Claude opens new tabs... pauses and asks you to handle it manually"
on login/CAPTCHA. There is no way for a standalone script to invoke `mcp__claude-in-chrome__*` outside a live
Claude session — these tools aren't a library, they're MCP tools exposed to whatever agent is presently
running. Good for me, right now, to interactively drive the browser and inspect LinkedIn's composer DOM as
part of *this research* if needed; disqualified as a dependency of `lnrelay post`.

### 5. cua.ai

`doc` (fetched `https://cua.ai/llms.txt`): primarily a **cloud sandbox provider** for computer-use agents (Pro
tier, credit-based; Enterprise; an OSS self-hosted framework too), offering isolated Linux/Windows/macOS
environments. No documentation was found describing cookie injection or reusing a local browser's session —
its whole design center is *isolated* sandboxes, which is the opposite of what this project needs. Even
self-hosted, it's a vision/computer-use agent loop by design, not a scripted-action tool. Wrong shape on two
axes at once: wrong session (would need to re-authenticate LinkedIn from a fresh sandboxed browser, exactly
what session reuse is meant to avoid) and wrong determinism (agent decides each click).

### 6. The broader 2026 field

Every other tool surveyed (`browser-use`, Stagehand, Chrome DevTools MCP, Playwright MCP, OpenAI
Operator/CUA, Anthropic's Computer Use API) shares one of two disqualifying properties for this project's
*write* path specifically:

- **LLM-in-the-loop per action** (browser-use, Stagehand's `act`, Operator, Computer Use API): nondeterministic
  by construction, and the failure mode is the disqualifying kind — not a crash, but *confidently doing the
  wrong thing* (clicking the wrong button, mistyping, or per the LinkedIn-specific reports below, believing a
  post succeeded when it didn't). Anthropic's Computer Use pricing makes the cost concrete: 735 tokens + image
  tokens **per action**, not per task — a multi-step "open composer, type, verify, submit" sequence is easily
  10+ actions, i.e. thousands of tokens and multiple seconds of latency for something a CDP script does in a
  handful of WebSocket round-trips. `doc`
- **Remote/sandboxed browser by default** (Stagehand/Browserbase, cua.ai, Operator): solves a different
  problem (scalable, disposable browser infra) than the one this project has (reuse *this* logged-in
  session).

Chrome DevTools MCP and Playwright MCP are the two closest in spirit — both can point at a real local Chrome —
but both are **MCP tool servers**, meaning something still has to be the agent choosing which tool to call each
step; there's no "run this exact script unattended" mode that isn't just... writing a Playwright/CDP script
directly, which is option 1/2 again with extra plumbing on top.

---

## LinkedIn-specific risk: "phantom success"

Independent of tooling choice, the same source describes LinkedIn's composer producing **success signals for
actions that didn't happen** — a click accepted, a dialog's DOM materializing, but nothing visually opening, in
automation contexts. `social`. This is the strongest argument in the whole research for building an explicit,
independent success check into the write path (below) rather than trusting any in-page "Posted!" toast.

## Detection surface, concretely

Attaching CDP to a Chrome window the **user launched and is already logged into** (this project's existing
pattern) is a materially different posture than `puppeteer.launch()` spinning up a fresh, disposable,
automation-flagged instance — same real cookies, same real IP, same persistent profile the user's ordinary
browsing lives in. The one concrete leak found (`Runtime.enable`) is avoidable by simply not sending that CDP
command — this project's existing `session.ts`/`observe.ts` code doesn't send it today, and the compose routine
below shouldn't either. What's *not* avoidable: `navigator.webdriver` and general CDP-attachment artifacts are
inherent to the Page/Input/Runtime domains being active on the tab at all, for as long as the WebSocket is
attached — the mitigation isn't "become invisible," it's "keep the CDP session attached for as short a window
as possible" (connect, drive the compose-and-post sequence, disconnect), matching how `session.ts` already
treats CDP as a brief bootstrap step rather than an always-on channel. Whether LinkedIn's own JS actually reads
`navigator.webdriver` around the composer specifically is `inferred`/unknown — no direct evidence either way —
and is exactly the kind of thing to watch for (unexpected CAPTCHA/challenge prompts appearing specifically
during the attached window) once this is built.

---

## Concrete sketch: "post to LinkedIn by driving the real composer over CDP"

1. **Preflight.** Reuse `mintSessionFromBrowser`'s existing discovery (`GET /json/list` against
   `http://127.0.0.1:9222`) to confirm the debug Chrome is up and find a page target. If not running, surface
   the existing `LAUNCH_HINT` — no new UX needed here.
2. **Open a dedicated tab** (`Target.createTarget` or navigate the existing one) to `https://www.linkedin.com/feed/`
   rather than reusing whatever tab the user has open — avoids stomping on something they're doing, and gives a
   known DOM starting point.
3. **Attach `Network.requestWillBeSent` *before* touching the composer** — same listener shape as
   `observe.ts` — filtered to Voyager write endpoints (`/voyager/api/contentcreation/*` or whatever the current
   share-creation call is; capture this once with `observe.ts` pointed at a manual post, the same way it's used
   today for read endpoints). This is the write-side equivalent of the read-side discovery `observe.ts` already
   does — same tool, pointed at a different moment.
4. **Open the composer** by finding the "Start a post" trigger via `Runtime.evaluate` (read-only query — find
   the button by `aria-label`/role/text, don't click via JS) and then clicking it with a **real** CDP
   `Input.dispatchMouseEvent` at its resolved `getBoundingClientRect()` coordinates — trusted input, not a
   scripted `.click()`.
5. **Wait for the modal**, polling (`Runtime.evaluate`, short interval, bounded timeout — not a blind
   `setTimeout`) for the expected editor container to exist and be visible. Fail loudly with a distinct error
   ("composer did not open") rather than proceeding blind if it times out — this is exactly the phantom-success
   failure mode called out above; catching it here means checking the DOM state, not the click's return value.
6. **Type the content** via real per-character `Input.dispatchKeyEvent` sequences into the focused editor
   (focus it first via a trusted click on the editor area). This is the (a) path from the CDP section above:
   slower than an internals API call, but doesn't need to know which rich-text library LinkedIn is running this
   month.
7. **Read back the DOM text** (`Runtime.evaluate`, e.g. `.innerText` of the editor node) and diff it against the
   intended post text **before** submitting. Any mismatch — truncation, autocomplete/mention-popup interference,
   a stray newline — aborts with a specific error instead of posting something wrong. This is the load-bearing
   verification step; it's cheap (one more `Runtime.evaluate` call) and directly defuses the "isn't the actual
   fix, just also correct" failure mode of trusting the editor's internal state without checking what's
   actually rendered.
8. **Click "Post"** the same trusted-coordinate-click way as step 4.
9. **Confirm success two ways, not one:**
   - Wait (bounded timeout) for the specific Voyager write request captured in step 3 to actually fire, and
     inspect its response status/body over the CDP `Network` domain (`Network.getResponseBody` or by pairing
     `requestWillBeSent`/`responseReceived`) — this is the network-truth check, immune to any UI-level phantom
     success.
   - Optionally, since this project already has a **working, verified read path** over plain Voyager HTTP:
     after a short delay, call the existing "my posts" read command and confirm the new post's text and a
     fresh timestamp actually appear. This is the strongest possible confirmation available — it's the same
     ground truth a human checking their own profile would use.
10. **Fail-safe rules, all of which are "stop and report," never "guess and retry":**
    - If the editor-open check (step 5), the text-readback check (step 7), or the network-write check (step 9)
      fails, treat the whole operation as failed and surface exactly which check failed.
    - Never click "Post" a second time on the same content if step 9's confirmation is ambiguous (timeout,
      not a network failure) — that risks a double-post, which is worse than a false "it might not have
      worked." Surface the ambiguity to the user/caller instead.
    - If step 4/6/8's selector or coordinate lookup can't find the expected element at all, that's a signal
      LinkedIn's composer DOM has changed since this was last verified — fail with that specific message (not
      a generic timeout) so it's fast to diagnose, mirroring how this project already treats `(336) features
      cannot be null` in the Voyager engine as a "config is stale" signal rather than a silent retry.
    - Disconnect the CDP WebSocket as soon as the sequence completes (success or failure) — keep the
      automation-visible window as short as possible, per the detection-surface discussion above.

This whole sequence is naturally expressed as a discriminated-result function in the style of this project's
existing `SessionLoad` type (`session.ts:13-16`) — e.g. a `ComposeResult` of `{ state: 'posted', url }
| { state: 'editor-not-found' } | { state: 'text-mismatch', expected, actual } | { state: 'write-not-observed' }
| { state: 'ambiguous' }` — so callers (the CLI command, tests) can handle each failure mode explicitly instead
of catching a generic exception.
