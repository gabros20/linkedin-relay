# linkedin-relay

Deep research over LinkedIn from your own account — a TypeScript CLI (`lnrelay`), a read-only MCP
server, and a Claude Code skill. No paid API.

Sibling to [`x-relay`](../x-relay), [`github-relay`](../github-relay) and
[`youtube-context`](../youtube-context); same stack, same shape, same philosophy.

```bash
npm i -g linkedin-relay-mcp
lnrelay login                              # mint a session from your own Chrome
lnrelay people "engineering manager" --company Microsoft --location Hungary --compact
                                           # people search with every filter, names looked up
lnrelay search posts "AI agents" --posted week --sort recent --compact
                                           # posts, companies, groups, events, courses, products, …
lnrelay jobs "frontend engineer" "AI agent developer" --workplace remote --posted week --compact
                                           # one merged job list across keyword sets
lnrelay job 4479248573 4475225930          # full jobs, with their apply links
lnrelay feed --compact                     # your feed, with engagement counts
lnrelay post <activity-urn>                # a post's comment thread
lnrelay sync connections
lnrelay local "rust"                       # then search it offline, free
```

## As an MCP server

Twenty-seven tools, none of which writes to LinkedIn, so an agent does the reading. Writes are not on that surface at any price.
The bundled Claude Code skill (`.claude/skills/linkedin-relay/SKILL.md`) teaches an agent the
funnels, the budget, and how to read `meta` — including step-by-step recipes for finding people and
for job hunting.

```bash
claude mcp add linkedin-relay -s user -- bun "$(npm root -g)/linkedin-relay-mcp/dist/mcp-shim.js"
```

## Commands

| | |
|---|---|
| `people` · `people-filters` | people search with every filter: company, past company, school, place, degree, title, someone's connections |
| `search` · `search-filters` | posts, companies, groups, events, courses, products, services, schools — each with its filters |
| `profile` · `feed` | a profile, your feed |
| `jobs` · `job` · `job-filters` | job search with every filter, several keyword sets merged in one call, and apply links |
| `post` · `reactions` | a post's comment thread, and who engaged |
| `scheduled` · `experience` · `skills` | your queued posts, and your own roles and skills |
| `network` | your My Network: connections, following, followers, pages, events, groups, invitations sent — or the count of each |
| `inbox` · `messages` · `draft` · `drafts` | read your messages without marking them read; draft replies locally — nothing is ever sent |
| `sync` · `local` · `connections` · `my-posts` | fill a local cache, then query it for free |
| `whoami` · `doctor` · `risk` · `budget` · `cache-status` | session, standing and spend |
| `share` · `comment` · `reply` · `edit` · `react` · `delete` | writes to your feed — OAuth when available, private API otherwise |
| `edit headline\|about` · `role` · `skill` | writes to your own profile |
| `oauth` · `approval` | the write credential, and how writes are approved |
| `purge` | delete cached data |

Every command prints a JSON envelope on stdout. `--compact` and `--fields a,b` trim the output;
`--raw` keeps the original Voyager node for when a shape has drifted.

## Writing

Reads have no sanctioned path, so they go over Voyager and carry the risk below. Writes *do* have
one, so they don't get to spend the same currency: posting, commenting and reacting all go over
`w_member_social`, LinkedIn's own self-serve scope. It needs an app you register yourself — two
self-serve products, no partner review — and then:

```bash
lnrelay oauth login --client-id <id>   # opens consent, catches the callback, stores the token
lnrelay share "text"                   # prints the plan, asks, then posts
lnrelay delete <urn>                   # reads the post back and shows it before destroying it
```

**No company, no Page, no app?** Then that route is closed to you, and `share` falls back to the
private API using the same session your reads use. It breaches §8.2 and puts the account at risk;
the prompt says so, names the transport, and asks anyway. An expired OAuth token is never silently
demoted to it. Reasoning and alternatives: **[docs/DECISION-writes.md](docs/DECISION-writes.md)**.

Every write shows exactly what it will send, over which surface, and how reversible it is, and is
approved the way **you** chose with `lnrelay approval set` (only at a real terminal):

| mode | how a write is approved |
|---|---|
| `interactive` (default) | a token typed at the terminal; no TTY means no write and no network call |
| `agent` | `--plan` returns a preview and a token; you approve it in chat; `--confirm <token>` runs exactly that content |
| `unattended` | runs as given |

There is no `--yes` and no environment variable. Every approval and outcome is logged to
`~/.lnrelay/writes.jsonl`.

## Messages: read, and draft — never send

```bash
lnrelay inbox --folder archive --unread --compact     # conversations, who with, unread, last message
lnrelay messages <conversation-id|thread-url>         # a conversation, oldest first
lnrelay draft <conversation-id> "Thanks — let's talk Tuesday."   # saved locally, with the thread link
lnrelay drafts                                        # your drafts; open the link and send it yourself
```

- **Reading leaves no trace.** Opening a conversation in the browser marks it read, clears "unseen"
  and acknowledges delivery — separate calls this tool never makes. Nothing read is stored.
- **There is no send.** A draft is a local note (`~/.lnrelay/drafts.json`, owner-only) with the
  conversation's link; you review and send it yourself. Agents get `inbox`, `messages` and `draft`
  over MCP for exactly that: read, then draft.
- Folders: `inbox`, `primary`, `other`, `archive`, `requests`, `spam`.

## Searching everything else

`lnrelay search <kind>` covers the rest of the search box — `posts`, `companies`, `groups`, `events`,
`courses`, `products`, `services`, `schools` — and hands `people` and `jobs` to their own commands.

```bash
lnrelay search posts "AI agents" --posted week --author-company Microsoft --compact
lnrelay search companies "fintech" --location Hungary --filter companySize=C,D --compact
lnrelay search courses "python" --filter difficultyLevel=Beginner
lnrelay search-filters companies "fintech"            # every filter for a kind, ids and counts
```

- **Posts** come with author, time, text and reaction, comment and repost counts, filterable by date,
  type, author, author's company, industry and title, and mentions. LinkedIn serves them over a
  heavier interface than the rest, 20 a call.
- **Everything else** comes back 50 a call as LinkedIn's own lines (a company's industry and HQ and
  followers, an event's time and place, a course's length and instructor), with each kind's filters
  through `--filter key=value` and `search-filters`.
- Several keyword sets merge by id, as for people and jobs.

## Finding people

```bash
lnrelay people "engineering manager" "head of engineering" --company Microsoft --location Hungary --network 2nd --compact
lnrelay people --school "Budapest University of Technology" --company OTP --limit 200   # alumni at a company
lnrelay people --connection-of <profile-id> --network 2nd                                 # their connections you are not yet connected to
lnrelay people-filters "frontend developer" --location Budapest                            # every filter, ids and counts
```

- **Every filter the people search has:** current and past company, school, place, connection
  degree, industry, profile language, service category, the connections or followers of a person,
  open to volunteering, and free-text first name, last name, title, company and school.
- **Names, not ids.** `--company`, `--past-company`, `--school` and `--location` take names and look
  them up; `data.resolved` says what each became, so a wrong match is visible.
- **50 people a call** (the page asks for 10). Asking for 100 is answered with an *empty success*, so
  the tool never does. Several keyword sets merge by person, as for jobs.
- **LinkedIn serves at most 1000 people per query**, whatever it claims to have matched;
  `meta.servedLimit` says when it held back, and the list is reported partial, not complete.
- People searches and name lookups spend the general search budget (25 calls a day), so a
  1000-person query takes most of a day's allowance.

## Job hunting

```bash
lnrelay job-filters "frontend engineer" --location "European Union"   # every filter, its ids and counts
lnrelay jobs "frontend engineer" "AI agent developer" "agent engineer" \
  --location "European Union" --workplace remote --posted week --limit 200 --compact
lnrelay job <id> <id> <id>                                            # finalists in full, apply links
```

- **Every filter the jobs page has:** location or exact geo id, distance, date posted, experience,
  job type, workplace, Easy Apply, under 10 applicants, verified, in your network, fair chance,
  company, industry, function, title, city, sort — and any other by its own name with
  `--filter key=value`.
- **Several keyword sets, one list.** Each set is searched with the same filters and the results are
  merged by job id: a job found by three sets comes back once, saying which. Live, four sets of 200
  gave 800 rows, of which 280 were repeats.
- **100 jobs a call, both ways.** Searches ask for 100 results a page (the browser asks for 25), and
  `job` / `--details` read up to 100 jobs in full in one batch call. 250 jobs with every apply link
  took 6 calls.
- **The apply link** is the employer's own site (`external`) or LinkedIn's Easy Apply. This tool
  finds jobs; it does not apply to them.
- Job hunting has its own daily budget — 150 search calls, 60 job reads — so it neither uses up nor
  is stopped by the other searches, which share 25 search calls a day.

## Design in one screen

- **Browserless raw HTTP** to LinkedIn's Voyager API. A real browser mints cookies once, via CDP, and
  is never in the hot path.
- **Zero automatic retry.** A 429 is a warning shot, not a suggestion to wait and try again.
  Cooldowns are a *file*, so the breaker survives across processes.
- **Reads are paced as conservatively as writes** — restrictions get triggered by fast browsing with
  no automation involved at all.
- **Budget as a type.** The client cannot be called without a `Permit` whose only producer is the
  ledger. An unaccounted network call is a compile error.
- **Parse by exclusion, never by an accept-list** — and report unknown types in the envelope. A scar
  carried from `x-relay`, where an accept-list silently dropped every reply in every thread and 34 of
  77 posts per feed page while still returning `ok: true`.
- **Empty is never confused with failed.** Every collection reports `state`, `returnedCount` and
  `claimedCount`; a claimed-but-empty response is an error, not "no results".
- **Third-party data is not cached by default.** When retained, a 30-day TTL swept on the read path;
  on expiry the body dies and only an identity stub survives.
- **Writes are approved under a mode only the owner can set** — at a terminal, behind a typed token.
  An agent can plan a write but never choose its own approval.
- **Single account by construction** — multi-account isn't disallowed, it's unrepresentable.

Full reasoning: **[docs/DESIGN.md](docs/DESIGN.md)** · Engine internals:
**[docs/ENGINE-RESEARCH.md](docs/ENGINE-RESEARCH.md)** · Build order: **[docs/PLAN.md](docs/PLAN.md)**

## Risk

LinkedIn does not offer individual developers a sanctioned read API, so this uses their private
Voyager surface with your own session. That is against LinkedIn's User Agreement, and any account it
touches can be restricted. Most of the design above exists to keep that risk low — conservative
pacing, no retries, a breaker that stops on the first signal — but it cannot be eliminated. Use an
account you would not mind losing.

`lnrelay risk` reports current standing; `lnrelay budget` reports what has been spent.

## Non-goals

Mass lead harvesting · multi-account operation or farms · proxy rotation · CAPTCHA solving ·
anti-detection tooling · reselling or sharing scraped data · outreach automation · anything that
touches another person's session.

## How this was built

Five parallel research lanes fed a three-model design panel — GPT-5.6-Sol, Grok-4.5 and Fable 5 —
who each wrote an independent proposal, then read and attacked each other's. All three changed
position under argument. The convergence and the full disagreement record are in
[docs/DESIGN.md](docs/DESIGN.md); the raw proposals are in `.orchestrate/panel/` and the research in
[docs/research/](docs/research/).

## Development

```bash
bun run check   # typecheck + lint + tests
bun run build
bun run dev -- <command>
```

## License

MIT
