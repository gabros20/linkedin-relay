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
