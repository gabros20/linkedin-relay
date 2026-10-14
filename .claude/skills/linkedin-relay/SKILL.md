---
name: linkedin-relay
description: Research LinkedIn from the user's own account — find people by company, past company, school, place, title, degree or whose connections they are, search posts, companies, groups, events, courses, products, services and schools, hunt jobs with every filter LinkedIn has and collect their apply links, read profiles, read the chronological feed — and, through the lnrelay CLI, post (text, image or video), comment, reply, react, delete and edit the user's own profile (headline, About, roles, skills) under the approval mode the owner chose. Use when finding or evaluating people (who works or worked somewhere, alumni, people in a role or a city, someone's connections), companies, groups, events, courses, posts on a topic, roles or job openings on LinkedIn, when the user wants job listings or application links, when reading what the user's network is posting, when the user wants to read their LinkedIn messages or draft replies to them, or when the user asks to post, engage or update their profile on LinkedIn. Cannot send messages, connect, or apply to jobs: those do not exist.
---

# linkedin-relay

**"Research LinkedIn, not browse LinkedIn."** A CLI (`lnrelay`) + this read-only MCP surface, running
on the user's own logged-in session against LinkedIn's private Voyager API. No paid API, no browser
in the request path.

## Three things to know before you call anything

1. **Every call spends a budget that cannot be topped up.** Caps are deliberately low (30 profile
   reads a day, 25 search calls shared by `people`, `search` (every kind) and name lookups, 350
   requests total; job hunting has its own 150 job searches and 60 job reads) because LinkedIn restricts accounts for *read*
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
people          1 call / 50 — find people with filters (company, school, place, degree, …)
jobs            1 call / 100 — find jobs with filters; `job` reads finalists, 100 a call
search          1 call / 50 — posts, companies, groups, events, courses, products, services, schools
  ↓ pick 2-3 finalists from the rows alone, not by reading each one
profile         mid    — deep-read ONLY the finalists
feed            mid    — what the user's network is posting right now
  ↓ feed rows carry likes/comments counts — rank on those before reading a thread
post            exp    — a post's comment thread
reactions       mid    — who engaged with a post
whoami          cheap  — who we are authenticated as
risk / budget   free   — check standing BEFORE spending
```

People and search rows already carry name, headline, location and URL. **Rank on those.** Calling `profile` on
every search result is how a day's budget disappears in one request.

## Finding people — the recipe

`people` is the people search with every filter LinkedIn has. Each call moves 50 people; a company
or school given by name costs one extra call to look up.

```
1. people_filters  (optional, 1 call)  ids and live counts for places, companies, schools,
                   industries, services — for this query
2. people          ALL keyword sets in ONE call, the filters, compact:true
3. rank            on headline, location, degree, insight — from the rows alone
4. profile         ONLY the 2-3 finalists, if the row is not enough
```

A worked call, the shape to copy:

```
people keywords:["engineering manager", "head of engineering"] company:["Microsoft"]
       location:"Hungary" network:["2nd"] limit:100 compact:true
```

From a shell: `lnrelay people "engineering manager" "head of engineering" --company Microsoft
--location Hungary --network 2nd --limit 100 --compact`.

- **Check `data.resolved`.** Company and school names, and `location`, are looked up to ids, and the
  choice is reported there. A name can land on a different organisation ("Microsoft Cloud", a
  similarly named school); if it did, re-run with the id from `people_filters` or the row it shows.
- **Ask the question with filters, not keywords.** "Who works at X" is `company`, not keywords;
  "alumni of Y" is `school`; "in Z" is `location`; "people I can get an intro to" is `network:["2nd"]`;
  "who does A know" is `connectionOf` with A's `id`. Keywords match anywhere on a profile.
- **`title` is free text against the current title**; `companyText`/`schoolText` are free text too,
  for when there is no single organisation to name.
- **Budget:** people searches and name lookups spend the general search budget, 25 calls a day.
  A deep query of 1000 people is 20 of them, so ask for the depth you need (`limit`), not the most
  LinkedIn serves; check `budget` before a big run.
- **LinkedIn pages at most 1000 people per query.** `meta.servedLimit` means it claimed more: split
  the query (by location, by company) rather than reporting the 1000 as everyone.
- **Not everyone is named.** LinkedIn may return people outside the user's network as
  `"LinkedIn Member"` with no `url`. That is LinkedIn withholding them from this account; count them,
  do not drop them silently, and say so.
- A row's `id` is the profile id: it goes into `connectionOf` / `followerOf`, and `profile` takes it.

## Job hunting — the recipe

Jobs have their own commands, their own budget (150 job searches, 60 job reads a day) and their own
funnel. Each call moves 100 jobs, so a whole hunt is a few dozen calls, not hundreds.

```
1. job_filters  (optional, 1 call)  the ids for company / industry / title / place, and live counts
2. jobs         ALL keyword sets in ONE call, the same filters, compact:true
                → one merged list; `matched` says which sets found each job
3. rank         on title, company, location, workplace, listed — from the rows alone
4. job          ALL finalists in ONE call (a list of ids) → description + apply.url
5. report       title · company · location · apply.url, and say how the list was cut
```

A worked call, the shape to copy:

```
jobs keywords:["frontend engineer", "AI agent developer", "agent engineer"]
     location:"European Union" workplace:["remote"] posted:"week" limit:200 compact:true
job  job:["4479248573", "4475225930", "4476083905"]
```

From a shell the same is
`lnrelay jobs "frontend engineer" "AI agent developer" --location "European Union" --workplace remote --posted week --limit 200 --compact`
and `lnrelay job 4479248573 4475225930 4476083905`.

- **Put every keyword set in one `jobs` call**, never one call per keyword: the tool merges them by
  job id, so you read each job once and `job` reads it once. Separate calls leave the merging to you
  and spend reads twice on the same job.
- **Use filters, not keywords, to narrow.** `posted:"week"`, `workplace`, `experience` and `geoId`
  cut a list from hundreds to tens. Keywords are matched loosely by LinkedIn, so "AI agent
  developer" also returns plain frontend jobs; a narrow keyword is not a narrow search.
- **`compact:true` for the wide pass** (one line per job, under half the size of the full rows), the full rows or
  `job` only for what you will actually judge.
- **`details:true` only when you need every job's apply link** (for a full export, say). It costs one
  read per 100 jobs and adds the employer, applicant count and apply link to every row; add
  `description:true` only if you will read them all, because descriptions are long.
- **Most results are promoted** (often three in four). That is LinkedIn's ranking, not a filter we
  can turn off; `promoted` on each row says which.
- **This tool cannot apply.** It finds the job and the link. `apply.type: "external"` is the
  employer's own site; `"easy-apply"` is LinkedIn's form, done by the user in a browser.

## Commands

### `search` — everything else in the search box: posts, companies, groups, events, courses, products, services, schools
```
search kind:posts|companies|groups|events|courses|products|services|schools
       keywords:"<terms>" | ["<terms>", …] [filter:["key=v1,v2"]] [limit:N per keyword set] [start:N] [compact]
       companies, services: [location:"<place>"] [network:[1st|2nd|3rd+]]   companies: [industry:[ids]]
       posts: [sort:recent|relevant] [posted:24h|week|month] [type:[videos|images|jobs|live|articles|documents]]
              [postedBy:[1st|me]] [from:[profile ids]] [mentions:[profile ids]] [fromCompany:["<name|id>"]]
              [mentionsCompany:["<name|id>"]] [authorCompany:["<name|id>"]] [authorIndustry:[ids]] [authorTitle:"<text>"]
```
CLI: `lnrelay search <kind> "<terms>" ["<more>" …] [flags]`; `lnrelay search people|jobs …` hands over to
`people` and `jobs` with all their flags. One call returns 50 results (posts: 20); several keyword
sets merge by id, with `matched`, as for `people`.

Rows other than posts are `id`, `name`, `subtitle`, `detail`, `summary`, `url`, in LinkedIn's own
lines; what each line holds depends on the kind:

| kind | `subtitle` | `detail` | `id` |
|---|---|---|---|
| companies | industry • HQ | followers | company id (`people company:[id]` takes it) |
| groups | members | — | group id |
| events | when | where • organiser | event id |
| courses | length | instructor • released | course id |
| products | category by vendor | — | product page id |
| services | the provider's headline | place | the provider's profile id |
| schools | place | students and alumni | school id (`people school:[id]` takes it) |

**Posts** rows: `id` (the post's urn — `post` reads its comments), `url`, `author`, `authorHeadline`
(people only), `authorUrl` (a profile or a company page), `posted` (as LinkedIn shows it, in the user's
LinkedIn language: "5h", or "5 órája" in Hungarian), `text`, `reactions`, `comments`, `reposts`.
- Every `search` call, name lookup included, spends the general search budget (25 a day, shared
  with `people`); ask for the depth you need.
- A posts call is heavy (about half a megabyte a post on LinkedIn's side), so ask for the depth you
  need. Posts come in LinkedIn's ranking unless `sort:"recent"`.
- `fromCompany` is the company's own posts; `authorCompany` is posts by people who work there.
- A group post may come back with no author or counts: LinkedIn keys those differently.
- Most other filters for a kind (company size, course level, product category, …) go in raw
  `filter`, with the keys and ids `search_filters` lists for that kind.

### `search-filters` — 1 search call. A kind's knobs, with ids.
```
search_filters kind:companies|groups|events|courses|products|services|schools [keywords] [location]
```
Every filter that kind has for the query, with option ids and live counts. Companies, for example:
`companyHqGeo`, `industryCompanyVertical`, `companySize` (B = 1-10 employees … ), `hasJobs`, `network`.
Groups, events and schools have none.

### `people` — 1 search call per 50 people. People search with every filter.
```
people [keywords:"<terms>" | ["<terms>", …]] [company:["<name|id>"]] [pastCompany:["<name|id>"]]
       [school:["<name|id>"]] [location:"<place>" | geo:["<id>"]] [network:[1st|2nd|3rd+]]
       [industry:[ids]] [language:["en"]] [service:[ids]] [title:"<text>"] [firstName] [lastName]
       [companyText] [schoolText] [connectionOf:"<id>"] [followerOf:"<id>"] [openToVolunteer]
       [filter:["key=v1,v2"]] [limit:1-1000 per keyword set] [start:N] [compact]
```
CLI: `lnrelay people "<terms>" ["<more>" …] [--company "<name|id>" …] [--location "<place>"]
[--network 2nd] [--title "<text>"] [--limit N] [--compact]` — every option is in `lnrelay help`.
Company, past company and school take names or ids; repeat the flag for several names (a name may
contain commas), or comma-separate ids.

Each item: `id`, `name`, `headline`, `location`, `degree` (`1st`, `2nd`, `3rd+`, `out of network`),
`verified`, `insight` (mutual connections, followers, services offered), `url`, and `matched` with
several keyword sets. `compact` gives one line per person. `data.resolved` lists each name and the
id it became. Paging and `meta` work as for `jobs`, plus `meta.servedLimit` when LinkedIn claimed
more people than the 1000 it serves. Filters alone are a search: `connectionOf` with no keywords
lists that person's connections.

### `people-filters` — 1 search call. The knobs, with ids.
```
people_filters [keywords:"<terms>"] [any people filter]
```
Every people filter for the query: its key, whether it takes ids or free text, and its options'
`value`, `label` and live `count`. The ids go into `geo`, `industry`, `service`, `company`, … or raw
`filter:["<key>=<value>"]`.

### `jobs` — 1 job-search call per 100 results. Job search with every filter.
```
jobs keywords:"<terms>" | ["<terms>", "<terms>", …] [location:"<place>" | geoId:"<id>"] [distance:<miles>]
     [posted:"24h|week|month|<N>h|<N>d"] [experience:[internship|entry|associate|mid-senior|director|executive]]
     [type:[full-time|part-time|contract|temporary|volunteer|internship|other]]
     [workplace:[on-site|remote|hybrid]] [easyApply] [under10] [verified] [inNetwork] [fairChance]
     [company|industry|function|title|place:[ids]] [filter:["key=v1,v2"]] [sort:recent|relevant]
     [limit:1-1000 per keyword set] [start:N] [details] [description] [compact]
```
CLI: `lnrelay jobs "<terms>" ["<more terms>" …] [--location … | --geo …] [--workplace remote,hybrid]
[--posted week] [--experience mid-senior] [--easy-apply] [--limit N] [--details] [--compact]` — every
option is in `lnrelay help`; list options take commas or repeat.

Each item: `id`, `title`, `company`, `location`, `workplace`, `listed` (YYYY-MM-DD), `easyApply`,
`promoted`, `salary` (when the card shows one), `insights`, `url`, and `matched` with several
keyword sets. `compact` gives one line per job:
`<id> | <title> | <company> | <location> | <workplace> | <listed> | easy apply | promoted | matched: a + b`.

- **Several keyword sets in one call.** Pass `keywords` as a list: each set is searched with the
  same filters, and the results are merged by job id. A job found by several sets comes back once,
  with `matched` naming them; the most-matched come first. Treat that order as a hint, not a
  ranking: LinkedIn matches keywords loosely ("AI agent developer" returns plain frontend jobs),
  so a generic job can match every set. Rank on title and company.
  `meta.searches` has each set's total, count, state and `next`; `meta.duplicates` is how many
  repeats were merged. One set failing leaves the others, with `state: "failed"` in its entry.
- **Rank on the rows, then read the finalists with `job`.** `details` reads every row in full, 100
  per job read, to add the apply link, applicants and employment type.
- **Check `data.location`.** A typed location is resolved by LinkedIn, and the place it chose is
  reported there. "Vienna, Austria" resolved to one district of Vienna. Pass `geoId` for an exact
  place; ids are in `job_filters` under `populatedPlace`.
- **Paging:** `meta.claimedCount` is LinkedIn's total, `meta.next` is the `start` for the next
  batch, and `meta.state` is `complete` only when the results ran out. LinkedIn serves at most 1000
  per search; narrow the query rather than paging deep.
- Job hunting has its own budget: 150 job-search calls and 60 job reads a day, apart from the
  people and company `search`. A search call returns 100 jobs, so ten keyword sets of a few
  hundred results each take about 30 calls. Reposts and recruiter copies of one role carry
  different ids, so they are not merged: judge those by company, title and description.

### `job` — 1 job read per 100 jobs. Jobs, in full.
```
job job:"<id | /jobs/view/ URL | ?currentJobId= URL>"   or   job job:["<id>", "<id>", …]
```
One id returns the job; a list returns `{items, meta}`, read 100 per call, so pass all your finalists
at once rather than one call each. `meta.unread` lists ids LinkedIn did not return.
`description`, `apply: {type: "external" | "easy-apply", url}`, `company`, `companyUrl`,
`location`, `workplace`, `employmentType`, `experienceLevel`, `industries`, `functions`, `listed`,
`expires`, `state` (`LISTED` or `CLOSED`), `applicants`, `ats` (the employer's applicant tracking
system), and `applied` / `saved` for this user. For an external application, `apply.url` goes to
the employer's own site.

### `job-filters` — 1 job-search call. The knobs, with ids.
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

### `inbox` — 1 page call per 20 conversations. The user's messages.
```
inbox [folder:inbox|primary|other|archive|requests|spam] [unread] [limit:N] [compact]
```
CLI: `lnrelay inbox [--folder archive] [--unread] [--limit N] [--compact]`. Each conversation: `id`,
`url` (the thread), `with` (each person or organisation: `name`, `kind`, `headline`, `degree`, `url`),
`unread`, `lastActivity`, `last` (`from`, `fromMe`, `at`, `text`, `sponsored`), `folders`, `inmail`.
`meta.unread` counts conversations with unread messages. `inbox` is LinkedIn's Inbox folder; much
of a mailbox may sit in `archive` or `other`, so look there before saying there is nothing.

### `messages` — 1 page call. One conversation.
```
messages conversation:"<id from inbox | /messaging/thread/ URL>"
```
The latest messages, oldest first: `from` ("you" for the user), `fromMe`, `at`, `text`, `subject`.
`meta.state: "partial"` means a full page came back and older messages may exist.

**Reading is invisible to the other side.** The browser, opening a conversation, also marks it read
(the sender sees it), clears "unseen" and acknowledges delivery; those are separate calls, and this
tool makes none of them. Nothing read is stored. These are private messages: summarise or quote them
to the user, never into anything else (a post, a comment, a file someone else will read).

### `draft` / `drafts` — local. A reply for the user to send.
```
draft conversation:"<id | thread URL>" text:"<reply>"      drafts      draft remove:"<draft id>"
```
CLI: `lnrelay draft <conversation> "<text>" | --file <path>`, `lnrelay drafts`, `lnrelay draft remove <id>`.
Saves the reply ON THIS MACHINE with the conversation's link (one read, to check the conversation
and who it is with). **Nothing is sent, and nothing can be: there is no send.** Show the user the
draft and the link; they open it, paste, review, and send it themselves. Write drafts in the user's
own voice and language, from what the conversation actually says.

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
| `state: unknown` | we stopped at the limit and cannot prove exhaustion (`post`, `reactions`, `feed`) |
| `next` | `jobs` / `people` / `search`: the `start` that continues this search; absent when the results ran out |
| `servedLimit` | `people` / `search`: LinkedIn claimed more matches than it serves (1000 a query) — the list is NOT everyone; narrow the query |
| `searches` / `duplicates` | `jobs` / `people` / `search` with several keyword sets: each set's own count and state, and how many repeats were merged |
| `unread` | `jobs --details` / `job`: jobs LinkedIn did not return in full — they are not closed, just unread |
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

**Sending a message and connecting do not exist at all, in any surface.** Messages can be read and
replies drafted (below), but a draft stays on this machine for the user to send. These are the
actions where the enforcement reports cluster, and an agent bug there is visible to a third party
and unrecoverable.

Also absent by design: notifications, nested comment replies, and bulk sweeps.

## Honest risk

This uses LinkedIn's private API with the user's own session. It **breaches LinkedIn's User
Agreement §8.2** and the account can be restricted or permanently banned. The tool never claims
otherwise, and neither should you. If the user seems unaware, say it once, plainly.
