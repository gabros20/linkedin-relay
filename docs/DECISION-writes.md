# Decision record — how this tool writes to LinkedIn

Consolidates `docs/research/W1-W4` and the DESIGN.md §2 revision into one place, because the
reasoning had scattered across four research lanes and three commits.

**Status: `share`, `delete` and `react`/un-react ALL VERIFIED LIVE 2026-08-13. `comment` is
captured and deliberately not shipped — see §5.**

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
| `engine/voyager-write.ts` — `delete` | ✅ **Verified live — post removed, confirmed server-side** |
| `engine/sdui-write.ts` — `react` / un-react | ✅ **Verified live over LinkedIn's SDUI surface** |
| `commands/transport.ts` — transport choice | Built and tested |
| Confirm gate, budget ledger, breaker, pacing | Unchanged, already applied to writes |
| `share` over OAuth | Built, unusable without a Page |
| `comment` / `react` over Voyager | **Deliberately refuse** — see §5 |

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

### ✅ Done — `delete`, built before verifying anything else

Non-obvious but correct, and it paid off: it is the best-evidenced operation in the research (W1 §4,
one implementation demonstrably run against production asserting a real `204`), it makes every later
test reversible, and it covers the scariest way `share` could have been subtly wrong —
`visibleToConnectionsOnly` is a **boolean**, inverted from OAuth's enum, so a backwards mapping
would publish a connections-only post to the open web.

`DELETE /voyager/api/contentcreation/normShares/{url-encoded urn}`.

### ✅ Done — `share` verified live, 2026-08-13

Right first time. See §4.

### ✅ Done — `share --image` / `--video` verified live, 2026-09-25

Three requests, all Voyager:

1. `POST /voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload`
   `{ mediaUploadType: IMAGE_SHARING | VIDEO_SHARING, fileSize, filename }` → a ticket with the
   `digitalmediaAsset` urn, `singleUploadUrl`, and `singleUploadHeaders` (`media-type-family:
   STILLIMAGE | VIDEO`) that the PUT must carry.
2. `PUT <singleUploadUrl>` with the raw bytes, the file's content type, and those headers.
3. `POST contentcreation/normShares` with `media: [{ category: IMAGE | VIDEO, mediaUrn, tapTargets: [] }]`.

An image post came back as `urn:li:share:…`, a video post as `urn:li:ugcPost:…`. Both rendered: the
image in full, the 19.7 s video playing, transcoded by LinkedIn to 720 px. Nothing waited on the
video's `pollingUrl`; LinkedIn accepted the post while processing continued.

The web client no longer takes this path. A capture of a hand-made image post the same day showed it
going entirely over SDUI (`UploadImageMedia` → `registerMediaUpload` → the same `/dms-uploads/` PUT →
`RegisterImageMedia` → `CreatePost`), with kilobytes of memory-namespace bindings per request. The
Voyager endpoints still answer, so they are used; if they are ever retired, that capture is the map.

Several images and alt text, VERIFIED LIVE the same evening: each image is registered and PUT in
turn, then one post lists them in order; `media[i].altText` carries alt text. A two-image post
rendered side by side, and the first image's `<img alt>` was exactly the approved text. An
unrecognised field would have been a 400 before anything was published (Rest.li validates create
bodies strictly), which is why guessing the name was a safe way to find it.

### Captured 2026-09-25 — documents and scheduling (not built yet)

A hand-made **document post, scheduled for the next day**, captured end to end (no post was
published; it was then deleted from the scheduled list):

- **Document upload** runs the same pipeline as images. Voyager registration accepts
  `mediaUploadType: DOCUMENT_SHARING` (verified: ticket with `media-type-family: PAGINATEDDOCUMENT`,
  recipes `feedshare-document` + `-preview`). Unlike images, the web client uploads the moment the
  file is picked, and requires a title before the post can be made.
- **The web client's CreatePost** (SDUI) carried: `shareLifeCycleState = ShareLifeCycleState_SCHEDULED`,
  `scheduledPublishTime = <epoch ms>`, `detourType = Document`, `mediaTitleBinding = <title>`, and the
  document asset id.
- **A scheduled post is a ugcPost** (`urn:li:ugcPost:…`) from the moment it is scheduled. Cancelling
  it went over SDUI `deletePost` with that urn and the SCHEDULED state.

**Resolved 2026-10-13 — built as `share --document --title` and `share --at`.** Two probes, both
scheduled a week ahead so neither could publish, read back from LinkedIn's own scheduled-posts list:

- `normShares` with `postState: "SCHEDULED"` and `scheduledAt: <epoch ms>` → "Post scheduled.", listed
  as "Posting Tue, Oct 20, 2026 at 2:00 PM" — exactly the time sent.
- media `{ category: "NATIVE_DOCUMENT", mediaUrn, tapTargets: [], title: { text } }` after a
  `DOCUMENT_SHARING` upload → listed with the title and "2 Pages".
- The existing `DELETE normShares/<urn>` cancels a scheduled post (share or ugcPost urn); the list
  went back to "Scheduled (0)". A document post comes back as a ugcPost, a text one as a share.

What follows is the original note, kept for the record.

Still unknown: the Voyager spellings. `normShares` already sends `postState: PUBLISHED`, so
`SCHEDULED` plus a time field is the natural probe; for documents, the media `category` and where
the title goes. Both probes are safe in the sense that matters: a state of SCHEDULED cannot publish
immediately, and Rest.li answers an unknown field with a 400 before creating anything.

### ✅ Edit a post, and polls — verified 2026-10-13

Both from mguttmann/linkedin-internal-api (docs/24), each re-verified here on a SCHEDULED probe so
nothing published, then end to end on a real connections-only poll post: posted, edited (the page
read "Edited", the new text, the poll intact with "1d left"), then deleted:

- **Edit:** `POST normShares/<share|ugcPost urn>` with `{ patch: { $set: { commentaryV2: { text,
  attributes: [] } } } }` — Rest.li partial update on the resource `delete` already uses, so no
  queryId. The response returns the post as LinkedIn now holds it; `edit` refuses to report success
  unless that text is the text sent. The activity urn is refused: it names the feed entry, not the post.
- **Poll:** GraphQL `voyagerFeedDashPollsPollSummary` creates it (`{ poll: { question, duration,
  options } }`, returns `urn:li:fsd_pollSummary:<id>`; a 200 can carry `errors`, which are read), then
  normShares posts it as `media: [{ category: URN_REFERENCE, mediaUrn }]`. On the scheduled probe the
  poll read "1w left" a week before it would publish — its clock appears to start at creation — so
  scheduling a poll is refused until that is measured.

### ✅ Link cards, and the scheduled queue — captured 2026-10-13

Captured from the web composer (link pasted, post scheduled a week out, scheduled list opened), then
re-verified over our own client on scheduled probes; all three were cancelled, nothing published:

- **A URL in the text is only text.** A `normShares` post without media rendered the link bare in
  the scheduled list — no card. The composer resolves the URL first (SDUI `feedUpdateByUrl`, then an
  ingestion poll) into `urn:li:article:<id>` and sends it as `mediaUrnString`.
- **The lookup** is the Voyager GraphQL read `voyagerContentcreationDashUpdateUrlPreview` (queryId
  from mguttmann/linkedin-internal-api), `variables=(url:<encoded>)`. It returned the same article
  urn the composer used, with the title and site in `included[].content.articleComponent`. An empty
  `elements` means LinkedIn has no preview for the link.
- **The card** rides `normShares` as `media: [{ category: ARTICLE, mediaUrn: <article urn> }]`;
  the scheduled list then showed the card under the text.
- **The queue.** Voyager cannot read a scheduled post (`GET normShares/<urn>` → 400) and `my-posts`
  lists only published ones. The list is SDUI: POST `rsc-action/actions/pagination` with pager
  `com.linkedin.sdui.pagers.sharing.scheduledPosts` and `{ start, count, shareLifeCycleState:
  SCHEDULED }`. Each row carries `feedUpdateUrn` + `scheduledAtEpochMillis`, then the full text
  (links as lnkd.in), in schedule order. `ShareBoxscheduledPostCount` is LinkedIn's own total — the
  only way to tell an empty queue from a page we no longer understand, so its absence is drift.

### ✅ Profile headline and About — captured 2026-10-13

Captured by editing each by one character in the browser and reverting at once (the profile was read
back equal to the original both times):

- **SDUI, not Voyager.** `identity/dash/profiles` PARTIAL_UPDATE answers 400 (mguttmann/linkedin-internal-api).
  The forms save with `saveProfileIntroForm` and `saveProfileAboutForm`.
- **The intro save sends the whole form**: name, headline, location (geo ids, postal code), current
  position, education, industry, website. A hand-built body would have to know all of it.
- **So nothing is hand-built.** Opening the form (`rsc-action/actions/navigation`, screens
  `ProfileEditIntroForm` / `ProfileAboutForm`, payload `{ vanityName, isVanityNameResolved }`) returns
  the save action with its `requestedStateKeys` and payload, and every field's initial value in
  `modelStates`. The save is that action, those values, one replaced. Rebuilt this way, both captured
  saves are reproduced exactly (tests/sdui-profile.test.ts). Keys absent from `modelStates` are
  omitted, as the browser omits them.
- **About carries top skills** as an expression over a client-side list that starts as
  `initialSkills`. Only the empty list has been observed, so About edits are refused while top skills
  are set.
- **The About form's binding keys are per-load** (`auto-binding-<uuid>`); another reason to take them
  from the form rather than from a capture.

### ✅ Experience: add, edit, remove a role — captured 2026-10-14

- **The save is not in the form.** Save fires `uploadPositionMedia` (carried by the form, screens
  `ProfilePositionAddForm` / `ProfilePositionDetailsEditForm`); its REPLY carries
  `saveProfilePositionForm`. Delete (`deleteProfilePositionForm`) is in the edit form itself. The
  Experience list (`ProfileExperienceDetails`) holds each role's edit navigation, whose payload is
  `{ vanityName, positionId, profileId, title, titleId }`.
- **The add form rewrites the headline.** `dynamicallyCreateHeadline` defaults to true; the browser
  capture replaced the owner's live headline with "<title> at <org>" (restored by hand). This tool
  always sends false. `allowProfileEditBroadcasts` (notify network) is false unless `--notify`.
- **Computed values** are evaluated from the expression the form ships (company required unless the
  employment type is self-employed/freelance), and refused when unrecognised. RSC bigints
  (`"$n-1"`) go back as `{ type: "bigint", value }`. Media ids are a computed list never observed
  non-empty, so a role with media is refused.
- **Verified** by rebuilding the browser's add save from a fresh form read (equal field for field,
  except the headline rewrite), then live through `lnrelay role add/edit/remove` on a past test
  role, with the headline, About, intro fields and role list compared to a baseline after each step.

### ✅ Skills: list, add, remove — captured 2026-10-14

- **Add** is `saveProfileSkillForm`, carried directly by `ProfileSkillAddForm`: the name, an empty
  catalogue id (free text) and empty association lists (roles, schools, projects…).
- **Remove** is `deleteProfileSkillForm`, in `ProfileSkillDetailsEditForm` (opened with
  `{ vanityName, skillId, isFromDetailScreen }`); there is also `updateProfileSkillForm`, not built.
- **The list** is the pager `pagers.profile.details.skills`, its payload (`profileId`, `filter`,
  `count`) taken from the `ProfileSkillDetails` screen and paged by `start`. Each row's name is the
  single text node before its edit action; any other count leaves the name null.
- **Verified** by rebuilding the browser's add save from a fresh form read, then live: the
  browser-added test skill removed through `lnrelay skill remove`, and a second one added and removed
  through `lnrelay`, the skill list compared to the baseline afterwards.

Not built: `MULTIPART` tickets (large files get several part URLs and a completion call that has not
been observed). `parseUploadTicket` refuses them before anything is uploaded.

### Next — exercise `delete` against the verification post

The 204 path has never run. Deleting the test post is both the cleanup and the proof.

### Then — capture, and unblock `comment` + `react`

`bun run scripts/observe-write.ts`, perform each action once by hand in the debug Chrome. The capture
settles both urn contracts from ground truth instead of from a single contradicted sample.
Credentials are redacted before anything touches disk.

### Optional, later — transport C (in-page `fetch` over CDP)

The genuinely novel option, and the only one with no mature reference implementation (W2 found only
0–3★ hobby repos). Issue the request *from inside the logged-in page*: real cookies, real Origin,
real TLS fingerprint — because it really is the browser making the call — while the payload stays
ours, so it keeps A's determinism.

Worth building if evidence ever emerges that raw HTTP is fingerprinted at the TLS layer. **Note that
the first live write went through cleanly on a residential IP with plain Bun `fetch`**, which is a
data point against that concern, though one post is not a sample.

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

## 9. Approval modes — revised 2026-09-25

The owner's requirement changed: this tool is driven by their own personal agents, which must be able
to act on "post it" said in chat without the owner opening a terminal, and — if the owner chooses —
to manage the account on their own. The TTY gate made both impossible; the only way through was an
`expect` script typing the token, which is the circumvention the gate existed to make deliberate.

So approval is now a mode the owner selects:

| mode | approval | mechanism |
|---|---|---|
| `interactive` (default) | a human at a terminal | unchanged |
| `agent` | the owner, in chat | `--plan` returns the preview and a token derived from the content, sending nothing; `--confirm <token>` sends it. Any change to the content changes the token. |
| `unattended` | none | the command runs as given |

What did not change, and why:

- **The mode is the owner's, not the agent's.** `lnrelay approval set` needs a terminal and a typed,
  mode-specific token, so an agent cannot promote itself. A corrupt or unknown setting refuses every
  write rather than defaulting to anything.
- **Budget caps, cooldowns and zero-retry apply in every mode.** Unattended is not unlimited.
- **Every approval and outcome is appended to `~/.lnrelay/writes.jsonl`** with its mode and content.
  Unsupervised writes must at least be reviewable afterwards.
- **Writes stay off MCP.** Agents with a shell use the CLI; putting writes on MCP is a separate call.
- **The no-network-on-refusal guarantee holds per mode**: commands that must read before asking
  (comment's harvest, delete's preview) refuse first when the invocation cannot end in an approval.

Stated honestly: in `agent` mode the token binds approval to content; it does not authenticate the
owner. The agent is trusted to relay the owner's word, and the audit log is what makes that trust
checkable. Comment tokens are derived from `{activityId, text}` rather than the full payload, because
the harvested trackingId changes on every render and would make `--plan` and `--confirm` disagree.
