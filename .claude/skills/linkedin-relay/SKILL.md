---
name: linkedin-relay
description: Research LinkedIn from the user's own account — search people/companies/jobs, read profiles, read the chronological feed. Use when finding or evaluating people, companies or roles on LinkedIn, or reading what the user's network is posting. Not for posting, messaging, or connection requests — those are CLI-only and require the human.
---

# linkedin-relay

**"Research LinkedIn, not browse LinkedIn."** A CLI (`lnrelay`) + this read-only MCP surface, running
on the user's own logged-in session against LinkedIn's private Voyager API. No paid API, no browser
in the request path.

## Three things to know before you call anything

1. **Every call spends a budget that cannot be topped up.** Caps are deliberately low (30 profile
   reads a day, 25 searches, 250 requests total) because LinkedIn restricts accounts for *read*
   velocity alone — several documented restrictions involved no automation and no writes, just fast
   browsing. Check `meta.budget.remaining`; when it's low, tell the user and stop rather than
   spending the rest.

2. **An empty result is not the same as a failed fetch, and you must tell them apart.** Read
   `meta.state` and the counts on every collection. Getting this wrong means telling the user
   "there's nothing there" when the truth is "we failed to read it" — the single most damaging thing
   this tool can do.

3. **Nothing is ever retried.** If a call fails with `RATE_LIMITED`, `REQUEST_DENIED`,
   `CHALLENGE_DETECTED` or `COOLDOWN_ACTIVE`, a cross-process cooldown has opened and every
   subsequent call will refuse until it lifts. **Do not loop.** Report it to the user and stop.

## The funnel

```
search          cheap  — cast wide, rank on the returned headline/location
  ↓ pick 2-3 finalists from the search rows alone, not by reading each one
profile         mid    — deep-read ONLY the finalists
feed            mid    — what the user's network is posting right now
  ↓ feed rows carry likes/comments counts — rank on those before reading a thread
post            exp    — a post's comment thread
reactions       mid    — who engaged with a post
whoami          cheap  — who we are authenticated as
risk / budget   free   — check standing BEFORE spending
```

Search rows already carry name, headline, location and URL. **Rank on those.** Calling `profile` on
every search result is how a day's budget disappears in one request.

## Commands

### `search` — cheap. The net.
```
search kind:people|companies|jobs query:"<terms>" [limit:1-25]
```
Returns `{items, meta}`. Each item: `name`, `headline`, `location`, `url`, `urn`.

`meta.claimedCount` is LinkedIn's total for the query (often millions) — it is **not** how many you
got. `meta.state` is always `unknown` here: this is one page of many and we never claim exhaustion.

Out-of-network people come back as `name: "LinkedIn Member"` with a `/headless` URL. That is real
LinkedIn behaviour, not a bug — LinkedIn will not name them to this account. Say so rather than
presenting it as a data problem.

### `profile` — mid. Read only the finalists.
```
profile id:"<public-id|urn|linkedin.com/in/… URL>"
```
Returns `headline`, `location`, `title`, `company`, `school`, `urn`.

**Known limit: no name.** None of LinkedIn's profile projections returns first/last name, so a
looked-up profile has a headline but no name attached. You supplied the identifier, so use that.
Don't tell the user the profile is empty — it isn't.

### `feed` — mid. What the network is posting.
```
feed [limit:1-20]
```
Returns posts with `author`, `posted`, `text`, `url`, plus `likes`, `comments` and `threadUrn`.
Promoted posts are dropped and counted in `meta.excludedCount`, so `returnedCount` being lower than
`limit` is usually ads, not failure.

**Use the engagement counts to decide what to read.** A post with 601 comments and one with 3 cost
the same to fetch but are worth very different amounts. `threadUrn` is what `post` and `reactions`
take — pass it straight through rather than reconstructing it.

### `post` — expensive. The full read.
```
post urn:"<activity-urn | feed-update URL>" [limit:1-100]
```
The comment thread on a post. Accepts a bare `urn:li:activity:…`, a
`urn:li:ugcPost:…`, or a `linkedin.com/feed/update/…` URL — no prior lookup needed.

Returns comments with `author`, `headline`, `text`, `postedAt`, `url`. `meta.state` is `unknown`:
this is the first page and pagination is not followed yet, so **never report a comment count as
complete**. Nested replies are not supported — a comment with replies does not carry them.

Read only the finalists. Feed and search rows already tell you how many comments a post has; use
that to decide whether the thread is worth a call.

### `reactions` — medium. Who engaged.
```
reactions urn:"<activity-urn | feed-update URL>" [limit:1-100]
```
Who reacted and with which reaction type. Returns `name`, `headline`, `reaction`, `url`. Useful for
mapping who is paying attention to a topic — often more informative than the comments.

Same pagination caveat: `meta.state` is `unknown`.

### `whoami` — cheap. Who we are.
Confirms the session works and which account it is. Good first call in a fresh session.

### `local` — free. The default path after a research session.
```
local query:"<terms>" [source:connections,my-posts,third-party] [since:YYYY-MM-DD] [limit:N]
```
Offline search over whatever has been retained. **Costs nothing and spends no budget**, so prefer it
before reaching for a live command — if the answer is already cached, use it.

The cache only fills when a live read is run with `--retain` (CLI). If `meta.cachedTotal` is 0, the
cache is empty — that is not the same as LinkedIn having nothing, and the response says so.

### `connections` / `my-posts` — free. Cache-backed.
```
connections [query] [limit:N]
my-posts    [query] [limit:N]
```
The user's own graph and posts, read from the local cache. **Free — no network call.** If they come
back empty, the cache has not been filled: tell the user to run `lnrelay sync connections` (or
`sync my-posts`) rather than reporting that they have none.

### `sync` — CLI-only. Fills the cache.
```
lnrelay sync my-posts | lnrelay sync connections [--limit N] [--force]
```
Not on this surface — the user runs it. Worth knowing it exists, because after a sync the `local`
tool can answer questions about their own posts and connections for free.

Connections refuse to re-sync more than once a week without `--force`: it is the most expensive read
in the tool and connections change slowly. Removals are only applied when the snapshot is complete —
if LinkedIn claims more connections than were retrieved, none are reported as removed, because they
were never looked at.

### `cache-status` — free.
What is cached per source, sync checkpoints, and the retention policy. Third-party records expire 30
days after capture: the body is deleted and an identity stub remains, so a re-fetch is a visible
choice rather than a silent budget charge. Owner data never expires.

### `risk` / `budget` — free, no network.
`risk` reports the circuit breaker. **Call it before a research session** rather than discovering a
lockout one wasted call at a time. `budget` reports spend per class with each cap's provenance.

### `doctor` — free with offline.
Diagnoses setup end to end. The first thing to run when anything behaves oddly.

## Reading `meta` — the part that matters

Every collection carries:

| field | meaning |
|---|---|
| `state: complete` | every reference resolved; an empty `items` here genuinely means none |
| `state: partial` | **some references failed to resolve** — the record is incomplete, not small |
| `state: unknown` | we stopped at the limit and cannot prove exhaustion (all searches) |
| `returnedCount` vs `claimedCount` | `claimed > 0` with `returned === 0` is a **failed fetch**, never "no results" |
| `excludedCount` | ads and UI chrome deliberately dropped |
| `unknownCount` / `unknownTypes` | **LinkedIn shipped a shape we don't recognise.** Data is still returned, but the parser is behind. Worth telling the user. |
| `unresolved` | URNs LinkedIn referenced but did not send |

If `unknownTypes` is non-empty, say so — it means LinkedIn changed something and the tool needs
re-capturing.

## Errors, and what to do

| code | what it means | what you do |
|---|---|---|
| `AUTH_FAILED` | session expired (usually just old cookies, not detection) | tell the user to run `lnrelay login` |
| `COOLDOWN_ACTIVE` | a previous call tripped the breaker | **stop.** Report when it lifts. |
| `RATE_LIMITED` / `REQUEST_DENIED` | LinkedIn throttled or blocked us | **stop.** Do not retry. |
| `CHALLENGE_DETECTED` | LinkedIn wants to see a human | stop; only the user can clear it, in a browser |
| `BUDGET_EXHAUSTED` | our own cap, not LinkedIn's | tell the user what's left and stop |
| `SCHEMA_DRIFT` | the endpoint changed shape or moved | report it; this needs a maintainer, not a retry |
| `NOT_IMPLEMENTED` | designed but not built yet | say so plainly |

**None of these is retryable.** A `retryAfterMs` is information for the human, not permission to
call again.

## What this tool will not do

Writes — posting, commenting, reacting — are **not on this surface at all**. They exist as CLI
commands (`lnrelay share`, `comment`, `react`) and go over LinkedIn's own official OAuth scope, not
the private API. Each stops at an interactive terminal, shows exactly what it will send, states the
ToS breach, and requires the user to type a token derived from the content.

**Without a terminal there is no write and no network call.** That is deliberate and there is no
flag that changes it: a flag an agent could set would not be confirming anything. If the user asks
you to post or comment, tell them the exact command to run themselves. Do not look for a way around
it, and do not offer one.

Connecting and messaging do not exist at all, in any surface. They are the actions where the
enforcement reports cluster, and an agent bug there is visible to a third party and unrecoverable.

Also absent by design: inbox reading, notifications, nested comment replies, and bulk sweeps.

## Honest risk

This uses LinkedIn's private API with the user's own session. It **breaches LinkedIn's User
Agreement §8.2** and the account can be restricted or permanently banned. The tool never claims
otherwise, and neither should you. If the user seems unaware, say it once, plainly.
