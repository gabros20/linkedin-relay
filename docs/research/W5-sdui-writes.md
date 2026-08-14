# W5 — Where LinkedIn's writes actually go

Captured live 2026-08-13 from the owner's own logged-in Chrome, over CDP, while they cycled every
reaction type on a post and on a comment and posted a comment. **Everything here came off the wire.**
No claim in this document is `repo`, `doc` or `inferred` unless it says so.

This supersedes W1 §2–3 for `comment` and `react`. W1's single OSS sample for each was not merely
uncorroborated — it was pointed at a surface the web client no longer uses.

## The finding

**Reactions and comments do not go to Voyager.** They go to LinkedIn's Server-Driven UI surface, via
React Server Component actions:

```
POST https://www.linkedin.com/flagship-web/rsc-action/actions/server-request?sduiid=<operation>
```

Operations observed, with call counts from a single 10-minute session:

| sduiid | n |
|---|---|
| `com.linkedin.sdui.reactions.create` | 28 |
| `com.linkedin.sdui.reactions.delete` | 28 |
| `com.linkedin.sdui.comments.createComment` | 2 |
| `com.linkedin.sdui.requests.comments.courtesyReminder` | 2 |
| `com.linkedin.sdui.requests.comments.commentControlMenuRequest` | 2 |

### Why this took three attempts to find

The observer filtered for `/voyager/api/` — where every READ lives — and was therefore structurally
blind to a surface that is not under that path. It reported "no mutating Voyager request seen" while
a comment demonstrably landed, twice. Two other defects compounded it: the observer attached to a
single page target found at startup (missing anything after a navigation), and browser-level
auto-attach alone yields 1 session where recursing into each attached session yields 8.

The methodological lesson is the same one §5 of ENGINE-RESEARCH records for reads, in a new costume:
**an accept-list of where you expect traffic will hide traffic you did not expect.** The fix was to
record every mutating request on every host and exclude known telemetry by name instead.

## Reactions — self-contained, and shippable

Body, verbatim except for the id:

```json
{"requestId":"com.linkedin.sdui.reactions.create",
 "serverRequest":{"requestId":"com.linkedin.sdui.reactions.create",
   "requestedArguments":{"$type":"proto.sdui.actions.requests.RequestedArguments",
     "requestedStateKeys":[],
     "payload":{"threadUrn":{"threadUrnActivityThreadUrn":{"activityUrn":{"activityId":"7000000000000000001"}}},
                "reactionType":"ReactionType_LIKE","reactionSource":"Update"},
     "requestMetadata":{"$type":"proto.sdui.common.RequestMetadata"}},
   "isApfcEnabled":false,"isStreaming":false,"rumPageKey":""},
 "states":[],
 "requestedArguments":{ …same payload…, "states":[], "knownTemplateIds":[],
   "screenId":"com.linkedin.sdui.flagshipnav.feed.UpdateDetail"}}
```

1,481 bytes. **No trackingId, no binding key, no server-issued token.** The arguments are sent twice —
nested and top-level — in all 56 recorded calls, so both copies are reproduced rather than tidied.

Three details that would each have been a silent failure:

1. **The urn never reaches the wire as a urn.** It is a nested object holding the BARE NUMERIC ID.
   W1's unresolved "activity urn or ugcPost urn?" question was a false dilemma — the answer is
   neither.
2. **Reaction types carry a `ReactionType_` prefix.** The OSS sample sent bare `LIKE`.
3. **A post and a comment take different shapes AND different sources**, and they are not
   interchangeable:

   | target | threadUrn | reactionSource |
   |---|---|---|
   | post | `{threadUrnActivityThreadUrn:{activityUrn:{activityId}}}` | `Update` |
   | comment | `{threadUrnCommentThreadUrn:{commentUrn:{commentId,thread}}}` | `Comment` |

All six reaction types were observed: `LIKE`, `PRAISE`, `EMPATHY`, `INTEREST`, `APPRECIATION`,
`ENTERTAINMENT`.

**`reactions.delete` is the un-react** — the operation W1 found *zero* implementations of anywhere in
the open-source field. It carries the reaction type being removed.

Headers: `content-type: application/json`, `csrf-token`, plus `x-li-page-instance` and `x-li-track`,
which this tool's verified minimal read header set deliberately omits. Whether this surface requires
them is **unknown** — it is the first thing to try if a replay is refused.

## Comments — captured, and NOT replayable as a single request

The text IS in the request, under `requestedArguments.states[].value`. But the payload also carries:

- `collection.updateKey.items[].trackingId` — e.g. `KgqrlKP8QFOsjQ/0KFWlTw==`, issued by the feed render
- `commentFieldBinding.key` — `commentBoxText-CgsIgIC6tO+ggf/PAQ--C6B_POCUy-…FeedType_FEED_DETAIL`

plus four more bindings on the same opaque key. These do not exist until a page has been rendered;
they are handles into the client's `MemoryNamespace` state. The whole request is 9,826 bytes.

So commenting is **a two-step protocol**: fetch the SDUI screen for the post, harvest the tracking id
and binding key, then submit. That is a real protocol, not a missing constant, which is why `comment`
remains unimplemented over this surface rather than shipped on a guess.

## What this changes

- `react` / un-react: **implemented and VERIFIED LIVE** in `src/engine/sdui-write.ts`. A
  `--type PRAISE` produced a Celebrate on a real post, and `--remove` took it back. Note the enum
  names are not the UI labels: PRAISE renders as "Celebrate", INTEREST as "Insightful".
- `comment`: still refuses, now with a specific reason instead of "the one sample is unverified".
- W1 §2–3 are superseded. The samples there describe endpoints the current client does not call.

---

## Addendum — commenting IS automatable, without a browser (2026-08-13)

The section above concluded `createComment` is not replayable because its payload carries a
`trackingId` from the feed render and an opaque `commentBoxStateId` binding key. Both facts hold. The
conclusion drawn from them — that this needs a driven browser — was **wrong**.

### The binding key is half derivable

```
commentBoxText-CgsIgIC6tO+ggf/PAQ--C6B_POCUy-WtfBFZljzw4nBJWJuFXssdgUqs8M9nh0FeedType_FEED_DETAIL
               └── segment A ───┘└──────────── segment B ───────────┘└──── suffix ────┘
```

**Segment A is the post id.** Base64 (with `-` standing in for `=` padding) of a protobuf message
whose one field is the activity id, zigzag-encoded as `sint64`:

```
CgsIgIC6tO+ggf/PAQ--  ->  0a0b 08 8080bab4efa081ffcf01
                          field 1 (bytes, len 11) -> nested varint 14987422137400066048
                          14987422137400066048 = 2 x 7493711068700033024   (zigzag of the id)
```

**Segment B is 31 opaque bytes** — a server-issued screen/component state id, not derivable. The
suffix is a feed-type enum (`FeedType_FEED_DETAIL` on a permalink, `FeedType_FEED` in the main feed),
so the key is context-dependent and the harvested one must match the screen used.

### Where the tokens come from

`POST /flagship-web/rsc-action/actions/component` **consumes** `commentBoxStateId`; it does not
produce it. The key originates in the SDUI screen render.

**And that render is a plain authenticated GET.** Verified live:

```
GET https://www.linkedin.com/feed/update/urn:li:activity:<id>/
    cookie: li_at + JSESSIONID     (no csrf-token, no browser, no CDP)
-> 200, ~2.8 MB of HTML containing commentBoxStateId, commentBoxText-<key>, trackingId
```

### So the flow is two requests, fully automatable

1. `GET` the post permalink with session cookies; scrape `commentBoxText-…` and `trackingId`.
2. `POST .../server-request?sduiid=com.linkedin.sdui.comments.createComment` with the harvested key,
   the text under `requestedArguments.states[].value`, and the key echoed in `requestedStateKeys`.

The binding key was CONSTANT across two comments on the same post, so step 1 is once per post.

### Costs and cautions, honestly

- Step 1 is a **~2.8 MB HTML fetch**, far heavier than any Voyager read here. It deserves its own
  spend class rather than being counted as a cheap read.
- Scraping a rendered page is the most drift-prone thing in this codebase. It must fail loudly when
  the key is absent, never post with a stale or empty binding.
- Segment B's semantics are **unknown**: whether it expires, is per-session or per-screen-instance is
  not established — only that it was stable across two comments minutes apart.

---

## Replying to a comment — investigated, NOT solved (2026-08-13)

Edit and delete were discovered by asking the server: the comment "…" menu is a contract listing
that returns each action with fully-populated arguments. **Replying does not appear there**, and the
reason is structural rather than an oversight in the search.

What the evidence shows:

- **Reply is a client-side toggle, not a server action.** The reply button carries
  `viewName: "comment-reply"` and flips `replyCommentBoxDisplayBinding-urn:li:comment:(…)`. Nothing
  is sent when it is pressed; it just reveals a box.
- **The submit therefore goes through `createComment`**, the same operation a top-level comment uses.
- **The box bindings are keyed by the PARENT COMMENT urn**, not by the opaque post binding a
  top-level comment uses. All 25 slots appear in that form:
  `commentBoxText-urn:li:comment:(urn:li:activity:<post>,<comment>)`, `…CharCount-…`, `…IsSaving-…`.

And here is the blocker. That comment-keyed binding is **the same shape the EDIT box uses**. So the
binding alone cannot be what distinguishes a reply from an edit — the difference has to be the
operation (`createComment` vs `updateComment`) plus, presumably, a parent reference inside the
`createComment` payload.

**The name and shape of that parent field is unknown.** It is not in the menu stream, not in the
rendered page, and not in any capture taken so far, because no reply was ever performed while
observing. Guessing a field name here is exactly the failure this project refuses: a `createComment`
that silently omits the parent posts a TOP-LEVEL comment on someone's post instead of a reply —
public, under the owner's name, and wrong in a way no status code reports.

### RETRACTED — the "solution" below is WRONG (verified live 2026-08-14)

Everything in this section is left standing because the reasoning error is more instructive than the
conclusion. **Sending `createComment` with a parent-keyed binding does NOT create a nested reply.**
Tested live: it posted a second TOP-LEVEL comment on the post, sitting as a sibling of the comment it
was supposed to answer.

The error was circular, and worth naming precisely. The component render was treated as DISCOVERY —
"ask the server what a reply box submits" — but it is an **ECHO**. We pass
`commentBoxStateId = <parent comment urn>`, and the server reflects that value back inside the action
it describes. The guard then verified "is the payload bound to the parent?" against a value we had
supplied ourselves. **It could not have failed.** An instrument that can only confirm its own input
is not evidence, and this is the second time in this project that shape of mistake produced a
confident wrong answer — the first was an observer that filtered for the wrong path and reported its
own blindness as a finding.

So the binding key is NOT the parent reference, and whatever actually nests a comment has not been
found. `lnrelay reply` is withdrawn and refuses.

What would settle it, and this time there is no shortcut: **capture a real reply.** Run
`bun run scripts/observe-write.ts`, click Reply on a comment in the debug Chrome, and diff the
resulting `createComment` against the top-level one already captured. The difference will be real
rather than reflected.

---

### The original, incorrect reasoning (kept as the record)

The assumption above was that a reply must carry a parent reference, so the field naming it had to be
observed. **There is no such field.**

Rendering the reply box's own submit button revealed its declared action — the same server-describes-
itself trick that gave edit and delete, one level down:

```
POST /flagship-web/rsc-action/actions/component
     ?componentId=com.linkedin.sdui.generated.comments.dsl.impl.submitCommentButton
     payload.commentBoxStateId = urn:li:comment:(urn:li:<threadType>:<post>,<comment>)
-> 200, and the createComment action it declares comes back fully populated
```

The reply payload's field names are **identical** to a top-level comment's:

```
optimisticKey, collection, commentFieldBinding, richCommentFieldBinding,
linkPreviewIngestedContentId, externalImageUrl, externalImageId
```

The only difference is what the bindings are keyed to:

| | binding key body |
|---|---|
| top-level comment | `Cg…<opaque 31 bytes>…FeedType_FEED_DETAIL` |
| **reply** | `urn:li:comment:(urn:li:<threadType>:<post>,<comment>)` |

**The binding key IS the parent reference.** That is why no field names it, and why the instinct to
guess a `parentCommentUrn` would have produced a request that posts a TOP-LEVEL comment on someone
else's thread — publicly, under the owner's name, with nothing erroring.

Note this is the same key shape an EDIT uses, so the binding alone does not distinguish the two: the
OPERATION does. `createComment` with a comment-keyed binding replies; `updateComment` with the same
binding edits.


---

## Replies live on Voyager, not SDUI (captured 2026-08-14)

The withdrawn implementation searched the SDUI surface because that is where top-level comments live.
**Replies are not there.** A captured reply goes to a plain Voyager endpoint:

```
POST /voyager/api/voyagerSocialDashNormComments
     ?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43
{
  "commentary": { "text": "…", "attributesV2": [],
                  "$type": "com.linkedin.voyager.dash.common.text.TextViewModel" },
  "threadUrn": "urn:li:comment:(activity:<post>,<parentComment>)"
}
```

Four fields against the 9 KB of bindings a top-level comment needs. Same product surface, two
entirely different transports — no reasoning from the SDUI side could have reached this, which is
exactly why the echo-based "discovery" produced a confident wrong answer instead.

Three details that cost something to learn:

- **`threadUrn` is the parent comment** — the real parent reference. Note the SHORT urn form:
  `(activity:<id>,…)` with no `urn:li:` prefix on the inner urn, unlike everywhere else here.
- **The `decorationId` is required.** Omitting it returns **HTTP 500**, not a 400 — a decorated
  resource asked for without its recipe. It is versioned (`-43`) and rotates like a queryId.
- **The captured reply carried a `profileMention` attribute**, because LinkedIn's UI pre-fills
  "@Author " into the reply box. We send `attributesV2: []`. An @mention notifies a real person, and
  inventing one would put both words and a notification where the user did not ask for them.

Verified live by control: a known-good manual reply does not appear in the top-level comment list, the
withdrawn implementation DID appear there as a sibling, and this one does not.
