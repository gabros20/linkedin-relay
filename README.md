# linkedin-relay

Deep research over LinkedIn from your own account — a TypeScript CLI (`lnrelay`), a read-only MCP
server, and a Claude Code skill. No paid API.

Sibling to [`x-relay`](../x-relay), [`github-relay`](../github-relay) and
[`youtube-context`](../youtube-context); same stack, same shape, same philosophy.

```bash
npm i -g linkedin-relay-mcp
lnrelay login                              # mint a session from your own Chrome
lnrelay search people "rust developer"     # ranked rows: name, headline, location, url
lnrelay feed --compact                     # your feed, with engagement counts
lnrelay post <activity-urn>                # a post's comment thread
lnrelay sync connections
lnrelay local "rust"                       # then search it offline, free
```

## As an MCP server

Thirteen read-only tools, so an agent does the reading. Writes are not on that surface at any price.

```bash
claude mcp add linkedin-relay -s user -- bun "$(npm root -g)/linkedin-relay-mcp/dist/mcp-shim.js"
```

## Commands

| | |
|---|---|
| `search` · `profile` · `feed` | the research surface — people, companies, jobs |
| `post` · `reactions` | a post's comment thread, and who engaged |
| `sync` · `local` · `connections` · `my-posts` | fill a local cache, then query it for free |
| `whoami` · `doctor` · `risk` · `budget` · `cache-status` | session, standing and spend |
| `oauth` · `share` · `comment` · `react` | writes, over LinkedIn's official OAuth scope |
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
lnrelay oauth status | logout
```

`lnrelay oauth login` with nothing set up prints the registration steps. Every write stops at an
interactive terminal and shows exactly what it will send, to whom, and how reversible it is — no
TTY means no write and no network call. There is no `--yes`.

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
- **Writes need a human at a terminal.** No TTY, no write — and no network call on that path.
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
bun run check   # typecheck + lint + 317 tests
bun run build
bun run dev -- <command>
```

## License

MIT
