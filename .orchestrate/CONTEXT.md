# Shared context — linkedin-relay deep research

Read this in full before starting your slice. Every researcher on this run gets the same file.

## What already exists (the "relay family")

The user has built a family of agent-facing research tools. All three share a deliberate shape:

| project | binary | MCP shim | what it does |
|---|---|---|---|
| **x-relay** | `xrelay` | `x-relay-mcp` | Deep research over X/Twitter via X's **private GraphQL surface**, authenticated with the user's own browser login cookies (`auth_token` + `ct0`). No paid X API. Search, profiles, threads, quoters, feed, plus an incrementally-synced local cache of the user's bookmarks/posts, plus confirmed write commands (post/reply/like/follow/delete). Published to npm, v1.5.4. |
| **github-relay** | `ghrelay` | `github-relay-mcp` | "Research GitHub, not read GitHub." Wide-net discovery across four lanes, offline star-skeptical ranking, deep-read only the 2–3 finalists. One free zero-permission PAT, no paid API. |
| **youtube-context** | — | `youtube-relay-mcp` | Same shape for YouTube. |

Shared architecture DNA (this is the pattern linkedin-relay must join):

- **Bun + TypeScript**, `tsup` build, Biome lint, `bun test`, semantic-release with Conventional Commits.
- **CLI is the product**; the MCP shim is a thin, read-only subset with no business logic.
- **A single command registry** (`src/commands/registry.ts`) is the source of truth that drives both the CLI
  dispatcher and the *generated* Claude Code SKILL.md — the skill can never drift from the code.
- **All network access is quarantined in `src/engine/`** so every other module is pure and unit-testable.
- **A JSON envelope on stdout** — `{ok, command, data}` / `{ok:false, command, error:{code,message,hint}}`.
  stdout stays JSON-only; progress goes to stderr and `--quiet` silences it.
- **Layout-drift tolerance**: parsers filter by *exclusion*, never by an accept-list, because a private
  API renames its entry types and every unnamed type becomes silent data loss that still looks healthy.
  (This exact bug cost x-relay every reply in every thread, and 34 of 77 tweets per feed page.)
- **Rotating query-ids / feature blobs live in config, never in logic**, and an auth-shape failure must
  **fail loudly**, never silently return an empty array.
- **A `doctor` command** that diagnoses setup end-to-end.
- **Honest risk documentation** — "assumes a residential IP; any account used can be rate-limited or
  banned; document the risk, never promise safety."

## What we are designing: linkedin-relay

A **personal, single-account, agent-driven deep-research and account-management tool for LinkedIn**, the
same way x-relay is one for X. Intended surface (to be challenged and refined by the design panel):

- **Read/research**: search people, companies, jobs and posts; read a profile; read a post and its comment
  thread; read reactions/commenters; read a company page; read the user's own feed and notifications.
- **Local cache**: incrementally sync the user's own connections, saved posts, and authored posts into a
  local store under `~/.lnrelay`, with watermark-based incremental sync and offline search.
- **Account management (write, explicit + confirmed only)**: post, comment, react, connect/withdraw,
  message, follow — CLI-only, never exposed over MCP.
- **Non-goals**: mass lead harvesting, multi-account farms, selling scraped data, evading LinkedIn's
  anti-abuse for someone else's benefit. This is one person's own account and their own research.

## The honest hard part

LinkedIn is materially more hostile than X:

- Aggressive bot detection, member-level rate limits, CAPTCHA/challenge flows, account restriction and
  permanent bans that cost the user a real professional identity — a much higher blast radius than an X ban.
- A long litigation history against scrapers (hiQ v. LinkedIn and its aftermath, and later suits).
- A private "Voyager" REST/GraphQL surface with its own auth (`li_at`, `JSESSIONID`/CSRF) that is
  under-documented and drifts.

The design must confront this head-on: what is safe, what is merely *possible*, what should be refused,
and how the tool makes its risk legible to the user rather than hiding it.

## What this research run produces

1. Five parallel research slices (you are one of them) → `.orchestrate/raw/`.
2. A consolidated brief → given verbatim to an expert panel (Codex GPT-5.6-Sol, Grok-4.5, Fable 5).
3. A converged `docs/DESIGN.md` + `docs/PLAN.md` in the new repo.

## Rules for your slice

- **Ground every claim.** Cite the repo, URL, post, or file you got it from. If you could not verify
  something, say "unverified" — do not smooth over a gap. A confident wrong fact poisons the panel.
- **Prefer primary sources**: actual source code, actual API responses, actual practitioner reports over
  listicles and SEO blogspam. Vendor marketing pages are evidence of a market, not of a technique.
- **Recency matters more than usual.** LinkedIn's surface changes; a 2021 blog post about Voyager may be
  archaeology. Always record the date of what you found.
- **Write your file to disk, then return a dense summary** (≤600 words) as your final message. Your final
  message IS your return value — no preamble, no "I have completed", just the findings.
