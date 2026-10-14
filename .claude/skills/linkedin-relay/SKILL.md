---
name: linkedin-relay
description: Research LinkedIn from the user's own account — search people/companies/jobs, read profiles, read the chronological feed — and, through the lnrelay CLI, post (text, image or video), comment, reply, react and delete under the approval mode the owner chose. Use when finding or evaluating people, companies or roles on LinkedIn, reading what the user's network is posting, or when the user asks to post or engage on LinkedIn. Not for messaging or connection requests, which do not exist.
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
search kind:people|companies query:"<terms>" [limit:1-25]   (jobs: use `jobs`)
```
Returns `{items, meta}`. Each item: `name`, `headline`, `location`, `url`, `urn`.

`meta.claimedCount` is LinkedIn's total for the query (often millions) — it is **not** how many you
got. `meta.state` is always `unknown` here: this is one page of many and we never claim exhaustion.

Out-of-network people come back as `name: "LinkedIn Member"` with a `/headless` URL. That is real
LinkedIn behaviour, not a bug — LinkedIn will not name them to this account. Say so rather than
presenting it as a data problem.

### `jobs` — 1 search call per 25 results. Job search with every filter.
```
jobs keywords:"<terms>" [location:"<place>" | geoId:"<id>"] [distance:<miles>]
     [posted:"24h|week|month|<N>h|<N>d"] [experience:[internship|entry|associate|mid-senior|director|executive]]
     [type:[full-time|part-time|contract|temporary|volunteer|internship|other]]
     [workplace:[on-site|remote|hybrid]] [easyApply] [under10] [verified] [inNetwork] [fairChance]
     [company|industry|function|title|place:[ids]] [filter:["key=v1,v2"]] [sort:recent|relevant]
     [limit:1-100] [start:N] [details] [description] [compact]
```
Each item: `id`, `title`, `company`, `location`, `workplace`, `listed` (YYYY-MM-DD), `easyApply`,
`promoted`, `salary` (when the card shows one), `insights`, `url`. `compact` gives one line per job.

- **Rank on the rows, then read the finalists with `job`.** `details` reads *every* row (1 profile
  call each, 30 a day) to add the apply link, applicants and employment type.
- **Check `data.location`.** A typed location is resolved by LinkedIn, and the place it chose is
  reported there. "Vienna, Austria" resolved to one district of Vienna. Pass `geoId` for an exact
  place; ids are in `job_filters` under `populatedPlace`.
- **Paging:** `meta.claimedCount` is LinkedIn's total, `meta.next` is the `start` for the next
  batch, and `meta.state` is `complete` only when the results ran out. LinkedIn serves at most 1000
  per search; narrow the query rather than paging deep.
- For several searches (keyword variants), keep each one narrow with filters. Every 25 rows costs a
  search call, and the day has 25.

### `job` — 1 profile call. One job, in full.
```
job job:"<id | /jobs/view/ URL | ?currentJobId= URL>"
```
`description`, `apply: {type: "external" | "easy-apply", url}`, `company`, `companyUrl`,
`location`, `workplace`, `employmentType`, `experienceLevel`, `industries`, `functions`, `listed`,
`expires`, `state` (`LISTED` or `CLOSED`), `applicants`, `ats` (the employer's applicant tracking
system), and `applied` / `saved` for this user. For an external application, `apply.url` goes to
the employer's own site.

### `job-filters` — 1 search call. The knobs, with ids.
```
job_filters keywords:"<terms>" [location | geoId] [any jobs filter]
```
Every filter LinkedIn offers for this query, each with its options' `value`, `label` and live
`count`. These values go into `company`, `industry`, `function`, `title`, `place`, or raw
`filter:["<key>=<value>,…"]` for anything else (benefits, commitments, …).

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

### `scheduled` — live, ~1 call per 10 posts. The queue.
```
scheduled
```
The user's own posts waiting to publish, soonest first: `urn`, `scheduledAt` (ISO), `text`. They are
**not** in `my-posts` until they go out, so check here before saying nothing is planned. Links in
`text` show as lnkd.in short links, the way LinkedIn lists them. `text` is null when it could not be
matched to its post for certain. A scheduled post is cancelled with `lnrelay delete <urn>` and its
text changed with `lnrelay edit <urn> "<text>"` (both CLI, approved like any write). If `meta.state`
is not `complete`, the list may be short — say so.

### `experience` — live, 2 calls. The user's roles.
```
experience
```
Each role on their profile with its `positionId` and title. The id is what `lnrelay role edit` and
`lnrelay role remove` take.

### `skills` — live, ~3 calls. The user's skills.
```
skills
```
Each skill on their profile with its `skillId` and name. The id is what `lnrelay skill remove` takes.

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

Writes are **not on the MCP surface**. They exist only as CLI commands:

| command | does |
|---|---|
| `lnrelay share "<text>" [--image <path> ... [--alt "…" ...] \| --video <path> \| --document <pdf> --title "…"] [--at "YYYY-MM-DD HH:MM"] [--poll "…" --option "…" --option "…" [--duration 1w]] [--no-card]` | post to their own feed — up to 20 images, one video, or one PDF; `--at` schedules it and LinkedIn publishes it then; a link in the text gets its preview card unless `--no-card` |
| `lnrelay comment <activity-urn> "<text>"` | comment on a post |
| `lnrelay reply <comment-urn> "<text>"` | reply, nested under that comment |
| `lnrelay edit <comment-urn \| share-urn \| ugcPost-urn> "<text>"` | change the text of their own comment or post |
| `lnrelay edit headline\|about ("<text>" \| --file <path>)` | change their profile headline (max 220 characters) or About section |
| `lnrelay role add --title "…" --company "…" --start YYYY-MM [--end YYYY-MM \| --current] [--location "…"] [--description "…" \| --description-file <path>] [--notify]` | add a role to their Experience |
| `lnrelay role edit <position-id> [the same flags]` / `lnrelay role remove <position-id>` | change or remove one of their roles (ids from `experience`) |
| `lnrelay skill add "<name>"` / `lnrelay skill remove <skill-id>` | add a skill (free text, linked to nothing) or remove one (ids from `skills`); removing drops its endorsements |
| `lnrelay react <urn> [--type X] [--remove]` | react to a post or comment |
| `lnrelay delete <activity-urn \| comment-urn>` | delete their post or comment |

The urn decides nothing on its own — `comment`, `reply` and `edit` are separate verbs because they
are separate operations, and passing a comment urn to `comment` is refused rather than guessed at.

### How a write gets approved

The owner chooses, and only the owner can change it (`lnrelay approval set <mode>` needs a real
terminal and a typed token). Check with `lnrelay approval`:

| mode | what you do |
|---|---|
| `interactive` (default) | you cannot complete the write. Give the user the exact command to run themselves. |
| `agent` | run the command with `--plan`: it sends nothing and returns a `preview` and a `token`. Show the user the preview **verbatim** and ask. Only when they say yes, run the **identical** command with `--confirm <token>`. |
| `unattended` | the command runs as given. Still show the user what you posted afterwards. |

In `agent` mode the token is bound to the exact content: change one character of text, swap the
image, or target a different urn and the token no longer matches — plan again, and show the new
preview. Never reuse a token across different content, never `--confirm` something the user has not
seen, and never treat "sounds good" about a draft as approval of a *different* draft.

Every approval and outcome is appended to `~/.lnrelay/writes.jsonl`; the owner can read what you did.

Do not look for a way around the mode — no pty tricks, no editing `config.json`. If the mode does
not let you write, say so and give the command.

Things worth telling a user who asks:

- `share` prefers LinkedIn's official OAuth scope and falls back to the private API when they have no
  developer app — the preview names which, and a Voyager write states the ToS breach. Why an app is
  needed at all: `docs/DECISION-writes.md`.
- `--image` / `--video` upload over the private API only; `--via oauth` with media is refused. A
  video post comes back as a `urn:li:ugcPost:` rather than `urn:li:share:`.
- A link in a post's text gets the preview card LinkedIn's composer would show (the first link only,
  and not on a post that already carries images, a video, a PDF or a poll). The plan names the card
  (`card "<title>" (<site>)`), or says LinkedIn has none. If the lookup fails nothing is posted; add
  `--no-card` to post the link as plain text.
- A profile edit's preview shows the current headline or About beside the new one. The approval is
  bound to both, so if the profile changed after the preview, re-plan. Every other profile field
  (name, location, current position) is sent back exactly as LinkedIn holds it, and the result is
  read back from the profile. About edits are refused while the About section has top skills set.
- Adding or editing a role never touches the headline. LinkedIn's own form would rewrite it to
  "<title> at <company>"; this tool always turns that off. "Notify network" is off unless `--notify`.
  The company is free text, not linked to a company page. A role with media attached is refused.
- Scheduled posts are listed by `scheduled` (MCP and CLI), not by `my-posts`.
- Editing a post replaces its whole text and LinkedIn marks it edited; pass the urn `share` printed
  (or `shareUrn` from `my-posts`), not the activity urn. An @mention in the old text is not kept.
- A poll takes 2–4 options and runs 1d/3d/1w/2w; it cannot be scheduled yet.
- A scheduled post gets its urn immediately; `lnrelay delete <urn>` cancels it before it publishes.
  `--at` without an offset is the machine's local time — say the time back to the user in the
  preview's own words, which name the timezone.
- **Deleting a comment also deletes every reply under it**, including other people's. Verified live.

Connecting and messaging do not exist at all, in any surface. They are the actions where the
enforcement reports cluster, and an agent bug there is visible to a third party and unrecoverable.

Also absent by design: inbox reading, notifications, nested comment replies, and bulk sweeps.

## Honest risk

This uses LinkedIn's private API with the user's own session. It **breaches LinkedIn's User
Agreement §8.2** and the account can be restricted or permanently banned. The tool never claims
otherwise, and neither should you. If the user seems unaware, say it once, plainly.
