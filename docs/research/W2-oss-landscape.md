# W2 — OSS landscape: how existing tools actually write to LinkedIn

Researched 2026-08-12 via `gh`/`ghrelay` (GitHub repo/code/release reads) + `xrelay` (X/Twitter search) +
`WebSearch`. This is a **narrower, write-focused** pass layered on top of [R1-github-landscape.md](R1-github-landscape.md)
(broad GitHub survey, 2026-08-01) and complements [W1-voyager-writes.md](W1-voyager-writes.md) (raw Voyager
write-endpoint mechanics) and [W3-browser-control.md](W3-browser-control.md) (which browser-driving tool to
build with). Where a fact is already established in one of those docs, this doc cites it rather than
re-deriving it; everything below is either genuinely new (the Agent-Reach deep-dive, the exact
write-tool-surface audit of the incumbent MCP server, two dated migration commits, and the X practitioner
scan) or a corroborating second source for an existing claim.

Claim labels per this project's convention: **repo** (read the source, file cited), **doc** (README/release
notes), **social** (X/forum post), **inferred** (my reasoning, not directly stated).

---

## Verdict

**The field has already answered the raw-HTTP-vs-browser question, and it answered "browser," but not for
the reason you'd expect — and the specific project the user asked about doesn't touch LinkedIn's transport
at all.**

1. **`Panniantong/Agent-Reach` is not a LinkedIn tool.** It's a Python meta-installer/doctor for ~15
   platforms. For LinkedIn specifically, all it does is check whether a *different*, third-party MCP server
   (`stickerdaniel/linkedin-mcp-server`, invoked as `mcp-server-linkedin`) is installed and configured, and
   print setup instructions if not (`repo`, `agent_reach/channels/linkedin.py`). It has zero LinkedIn-specific
   code of its own beyond that check and a `docs`-only Jina-Reader read fallback. Its 71k stars and #1
   GitHub-trending badge are about the other ~14 platforms (Twitter, YouTube, Reddit, Bilibili, XiaoHongShu,
   GitHub, RSS, arbitrary web pages) — LinkedIn isn't even listed in its own README's "why do you need
   this" pitch (`repo`, README head). Delegating to it doesn't get `linkedin-relay` anywhere it isn't
   already; it delegates to the exact incumbent R1 already flagged as dominant.

2. **The incumbent LinkedIn MCP server cannot create a post.** `stickerdaniel/linkedin-mcp-server`
   (3,095★, the same repo R1 called "dominant") exposes 17 read tools and exactly two write tools:
   `connect_with_person` and `send_message` (`repo`, `linkedin_mcp_server/tools/*.py` — see full audit
   below). There is no `create_post`/`share`/`publish` tool anywhere in its tool surface. Its `post.py`
   module is a **content-search** tool (`search_posts`), not a post-creation tool — the filename is a false
   friend. This means the single most popular, most actively maintained (daily commits, pushed hours before
   this research) open-source LinkedIn MCP server, used by hundreds of downstream projects including
   Agent-Reach, **does not solve the user's stated problem at all**, regardless of transport.

3. **Every actively-maintained project that *reads* LinkedIn at any real scale has converged on stealth
   browser automation, not raw Voyager HTTP** — confirming R1/W3's finding with two more independent data
   points: `eliasbiondo/linkedin-mcp-server` (175★, second-most-starred LinkedIn MCP server) independently
   chose the same **Patchright** (stealth-patched Playwright) stack as the incumbent (`repo`, README:
   "Built with FastMCP, Patchright"). And the incumbent's own release history shows it **migrating deeper
   into browser automation over time, not away from it**: v3.0.0 (2026-02-12) was a breaking change titled
   *"Switch to patchright with persistent browser context"* (PR #143), and four days later v4.0.0
   (2026-02-16) *removed its dependency on `linkedin-scraper`* (the Selenium-then-Playwright project R1
   separately profiles) *"and integrated core functionalities directly"* (PR #155) — i.e. the two top
   LinkedIn scrapers in R1's table aren't independent; one absorbed the other's approach and then hardened
   it with anti-detection patches. Nobody found is migrating from browser automation to raw HTTP.

4. **Raw Voyager HTTP writes mechanically work** — this doesn't contradict (3), it's the other half of the
   picture W1 already established in detail (four independent repos converge on `POST
   /voyager/api/contentcreation/normShares`, cookie-only auth, no fingerprint/CAPTCHA step). What's new here
   is *who* uses each transport: the raw-HTTP posters (`sigcli/sigcli`, `bcharleson/linkedincli`,
   `CRAKZOR/linkedin-post-automator`) are all small, single-maintainer CLIs with no MCP wrapper and no
   real install base. The browser-automation projects (`stickerdaniel`, `eliasbiondo`, `joeyism`) are the
   ones with thousands of stars, daily/weekly commits, and are the ones other tools (Agent-Reach) delegate
   to. And W1's own strongest data point — `markrussinovich/Polypost` — is an author who *proved* the raw
   `normShares` write works (via a live-browser-driven validation script) and then **still shipped the
   product using native-UI clicks instead**, a direct, dated risk-tolerance decision by someone who had
   both options in hand. Read together: **raw HTTP writes work today, but nobody serious ships them as the
   primary path** for anything meant to last.

5. **The "attach to my own already-logged-in Chrome and post" pattern the user actually wants has no
   mature reference implementation.** The handful of GitHub repos attempting exactly this (Playwright-driven
   LinkedIn posters, one using Chrome CDP explicitly) all sit at 0–3 stars with thin commit histories
   (`repo`, GitHub search — table below). This corroborates W3's conclusion that this project will likely be
   building, not adopting, that specific piece — there's no popular prior art to point at, positive or
   negative.

6. **The classic raw-HTTP Voyager wrapper lineage is confirmed dead, with a date.** `tomquirk/linkedin-api`
   — R1 already found the repo 404s — hasn't shipped a PyPI release since **November 2024** (`social`/`doc`,
   WebSearch of PyPI release history), and its most-starred living fork found in this pass
   (`JNYH/linkedin_api`, PyPI-listed) last pushed **2022-08-07** with 11 stars (`repo`, `gh api`). Nothing
   found in this pass revives that lineage.

---

## Priority 1 — Agent-Reach, read properly

Repo: [`Panniantong/Agent-Reach`](https://github.com/Panniantong/Agent-Reach) · MIT · Python · **71,018★ /
6,016 forks** (as of 2026-08-12) · created 2026-02-24 · pushed hours before this research (`repo`, `gh repo
view`). GitHub Trending #1-of-the-day badge in its own README.

**What it actually is** (`repo`, README head + tree): a CLI/skill installer that gives a coding agent
"internet eyes" — one command (`帮我安装...` / "help me install...") that detects which platform a URL or
request needs, checks whether the right upstream tool is installed and authenticated, and if not, tells the
agent (or user) exactly what to install and how. It is explicitly **not** a from-scratch scraper for most
platforms — `agent_reach/channels/` has 16 channel modules (twitter, youtube, reddit, bilibili, github,
xiaohongshu, xueqiu, v2ex, instagram, facebook, linkedin, rss, web, xiaoyuzhou, exa_search, mcporter/opencli
generic backends), and each one's `check()` method mostly answers "is the *real* upstream tool (yt-dlp,
gallery-dl, a specific MCP server, a CLI) present and configured?" rather than doing the scraping itself.
The two backend adapters (`backends/opencli.py`, `channels/mcporter.py`) are the actual work-doing layer —
Agent-Reach shells out to `mcporter` (a local MCP-server manager/launcher CLI) or an "opencli" generic site
backend.

**LinkedIn specifically** (`repo`, `agent_reach/channels/linkedin.py`, quoted in full above the fold): the
`LinkedInChannel.check()` method does not scrape or post anything. It:
- checks whether `mcporter` is installed (`shutil.which("mcporter")`); if not, tells the user Jina Reader
  can do "basic content" (read-only, public-page-only) and gives manual setup steps
- inspects the local `mcporter` config for a server named one of `linkedin` / `linkedin-scraper` /
  `linkedin-scraper-mcp` / `mcp-server-linkedin`
- if found, warns that it hasn't actually started the server to verify connectivity — "配置检查... 不能仅凭配置宣称完整可用"
  ("can't claim full availability from config alone") — a notably honest self-limitation
- the `_LOGIN_COMMAND` / `_CONFIG_COMMAND` constants it prints are literally `uvx mcp-server-linkedin@latest
  --login` and `mcporter config add linkedin --command uvx --arg mcp-server-linkedin@latest ...`, and the
  docstring points straight at `github.com/stickerdaniel/linkedin-mcp-server`

So: **Agent-Reach's LinkedIn "support" is 100% a pointer to the exact incumbent MCP server this project
already needs to evaluate on its own merits** (see Priority 2 below). It contributes no new transport, no
new auth mechanism, and — per that server's actual tool surface — no post-creation capability either.
`tier = 2` in its own model (needs setup, not zero-config), one of only three tiers it defines.

**Maintenance / trust signal**: extremely active (daily pushes, CI, 27 markdown docs including 4 translated
READMEs, `.openteams` governance specs, a `SECURITY.md`), MIT-licensed, sponsored by three commercial
scraping/browser-automation vendors (BrowserAct, Tencent Cloud, CoreClaw) listed at the top of the README —
worth noting as the same "who's paying for this" question this project should ask of every tool here, though
sponsorship of a meta-installer is a much lower trust concern than sponsorship of something that directly
holds your cookies. No evidence of anything sketchy in the LinkedIn-specific code read — it does not touch
credentials at all for LinkedIn (that's `mcp-server-linkedin`'s job).

**Bottom line for this project**: Agent-Reach is not a candidate architecture and not a competitor — it's
irrelevant to the write problem. The real question it points at is already R1/this doc's actual subject:
`stickerdaniel/linkedin-mcp-server`.

---

## Priority 1b — the incumbent, write-surface audit

Repo: [`stickerdaniel/linkedin-mcp-server`](https://github.com/stickerdaniel/linkedin-mcp-server) ·
Apache-2.0 · Python · 3,095★ / 533 forks · created 2025-04-13 · **v4.22.0** pushed 2026-08-11 (one day before
this research) — this is the repo R1 already profiled in depth (auth model, browser stack, open-issue
texture); this section adds the tool-surface audit R1 didn't do and the migration history.

**Full tool inventory** (`repo`, `linkedin_mcp_server/tools/*.py`, one file per domain):

| file | tools | read/write |
|---|---|---|
| `person.py` | `get_person_profile`, `get_my_profile`, `get_sidebar_profiles`, `search_people` | read |
| `company.py` | `get_company_profile`, `get_company_posts`, `search_companies`, `get_company_employees` | read |
| `job.py` | `search_jobs`, `get_saved_jobs`, `get_job_details` | read |
| `feed.py` | `get_feed` | read |
| `post.py` | `search_posts` (global keyword search of the "Posts" tab — **not** post creation, despite the filename; see the tool's own docstring, quoted above) | read |
| `messaging.py` | `get_inbox`, `get_conversation`, `search_conversations`, `connect_with_person`, `send_message` | 3 read, **2 write** |
| (server-level) | `close_session` | control |

**Total: 17 read tools, 2 write tools** (`connect_with_person`, `send_message`), **zero post/comment/react
tools**. `send_message` explicitly requires `confirm_send: bool` before it fires (`repo`,
`tools/messaging.py:224`), consistent with W3/R4's write-friction observations elsewhere in this project's
research. There is no code path in this repo that would let `linkedin-relay` publish to the user's own feed.

**Transport, confirmed by source, not README claims**: `linkedin_mcp_server/core/browser.py` uses
`patchright.async_api` (`from patchright.async_api import BrowserContext, Page, Playwright,
async_playwright`) against a persistent profile at `~/.linkedin-mcp/profile/` — cookies/localStorage
persist across runs in a real Chromium user-data-dir, not re-minted per session (`repo`). `grep`-ing
`scraping/extractor.py` for any Voyager/GraphQL HTTP call (`requests.`, `httpx.`, `voyager`, `api/graphql`)
returns **nothing** — every read in this codebase goes through DOM `innerText` extraction on a rendered
page, confirmed directly in source, not inferred from the README (`repo`).

**Two dated migration commits** (new to this pass — R1 flagged the *state* as browser-based; this is the
*history* showing how it got there):

- **v3.0.0, 2026-02-12** — breaking change: *"feat!: Switch to patchright with persistent browser context"*
  ([PR #143](https://github.com/stickerdaniel/linkedin-mcp-server/pull/143)). Before this, the project used
  plain Playwright without a persistent profile — moving to Patchright is specifically an anti-detection
  hardening step (Patchright's entire value-add over Playwright is patching the `Runtime.enable` CDP leak
  that fingerprinting scripts check for — the same fact W3 independently arrived at evaluating tools for
  this project's own write path).
- **v4.0.0, 2026-02-16**, four days later — *"refactored scraping tools to use innerText extraction with
  configurable section selection... removed dependency on linkedin-scraper and integrated core
  functionalities directly"* ([PR #155](https://github.com/stickerdaniel/linkedin-mcp-server/pull/155)).
  This confirms the incumbent was **originally built on top of `joeyism/linkedin_scraper`** (the other,
  separately-profiled R1 finalist) as a library dependency, then absorbed and rewrote that logic in-house.
  R1 lists these as two unrelated entries in its ranked table; they're actually parent/child in lineage,
  with the child now outperforming and having outgrown the parent (R1: `joeyism/linkedin_scraper`
  responsiveness subscore 0.08/1 vs. daily maintenance on `stickerdaniel`).

Both moves are **toward** heavier, more defensive browser automation, not away from it — no commit, PR, or
issue found anywhere in this repo's history proposes moving any read or write path to raw Voyager HTTP.

**Account-risk framing** (`doc`, README, already flagged similarly in R4 for the wider ecosystem): *"LinkedIn's
User Agreement prohibits automated access, and accounts using automated tools can be restricted or
banned... Use at your own risk; there is no guarantee of account safety,"* plus explicit guidance *against*
routing through a proxy/VPN, since LinkedIn scores the network address a session signs in from — directly
relevant to this project's own residential-IP assumption.

---

## Priority 2 — the comparable set

### MCP servers for LinkedIn

| name | URL | lang | ★ | last push | transport | auth | can write? | trust note |
|---|---|---|---|---|---|---|---|---|
| `stickerdaniel/linkedin-mcp-server` | [github](https://github.com/stickerdaniel/linkedin-mcp-server) | Python | 3,095 | 2026-08-11 | Patchright (stealth Playwright), persistent Chromium profile | cookies via `--login`/`--import-from-browser`, stored `~/.linkedin-mcp/profile/` | connect requests + DMs only, **no post creation** | Trustworthy — clean architecture, active CI, explicit risk disclaimers, sponsored by Unipile (disclosed) |
| `eliasbiondo/linkedin-mcp-server` | [github](https://github.com/eliasbiondo/linkedin-mcp-server) | Python | 175 | 2026-03-08 | Patchright + FastMCP, "hexagonal architecture" | not fully audited this pass; browser-session-based per README | **read-only** — no write tools listed at all (`close_browser` is the only non-data tool) | Looks clean; independent second confirmation of the Patchright convergence |
| `quinnjr/linkedin-mcp` (`@pegasusheavy/linkedin-mcp`) | [github](https://github.com/quinnjr/linkedin-mcp) | TypeScript | 64 | 2026-08-03 | **official LinkedIn OAuth 2.0 + OIDC** | Client ID/Secret from a registered LinkedIn Developer App | claims post/share support, but **gated behind the same Developer-App + Company-Page requirement this project is trying to avoid** (`repo`, README prerequisites) | Doesn't solve the user's actual problem regardless of code quality |
| `Dishant27/linkedin-mcp-server` | [github](https://github.com/Dishant27/linkedin-mcp-server) | TypeScript | 52 | 2026-08-12 | official OAuth (Client ID/Secret) | LinkedIn Developer App | same gate as above | Same non-fit; R1 marked this "unclear," resolved here as official-API-only |
| `alinaqi/mcp-linkedin-server` | [github](https://github.com/alinaqi/mcp-linkedin-server) | Python | 53 | 2025-02-18 | Playwright (`playwright install chromium`) | **fresh username/password login** (`.env` `LINKEDIN_USERNAME`/`LINKEDIN_PASSWORD`), not existing-session reuse | like + comment only, **no post creation** | Lower trust than the above two: stores raw credentials (encrypted-at-rest, per its own README) rather than riding an existing session; stale (18 months) |
| `Sharan-Kumar-R/Custom-MCP-Server` | [github](https://github.com/Sharan-Kumar-R/Custom-MCP-Server) | Python | 95 | 2025-06-27 | RapidAPI-backed (third-party scraping API), multi-platform | API key | not audited (out of scope — proxies to a paid third party) | Not a direct-session tool; different category |

None of the OAuth-gated entries (`quinnjr`, `Dishant27`) actually escape the Company-Page requirement — they
just re-expose LinkedIn's own official API surface through MCP, which is the exact wall this project already
hit.

### Voyager-API wrappers (Python `linkedin-api` lineage)

- **`tomquirk/linkedin-api`** — the flagship. R1 already found `github.com/tomquirk/linkedin-api` 404s as
  of 2026-08-01; this pass adds that its **last PyPI release predates November 2024** (`social`, WebSearch
  of package/release history — not independently re-verified against PyPI's raw JSON in this pass, flagged
  as a gap below) and that the owner's GitHub account (`tomquirk`) resolves fine, so this looks like a
  deliberate repo removal/rename rather than an account-level takedown, though the *cause* remains
  unconfirmed either way, consistent with R1's "unverified" framing.
- **`JNYH/linkedin_api`** — the most-starred fork still on PyPI (11★). **Last push 2022-08-07** (`repo`,
  `gh api repos/JNYH/linkedin_api`) — effectively as dead as the original, just not 404. No TypeScript/JS
  equivalent of comparable maturity was found in this pass.
- No `linkedin-api`-lineage fork or rewrite found anywhere in this pass has a create-post capability that is
  both current (pushed within the last 12 months) and has more than a handful of stars — the maintained
  raw-HTTP write capability lives entirely in the small single-purpose CLIs W1 already catalogued
  (`sigcli/sigcli`, `bcharleson/linkedincli`, `CRAKZOR/linkedin-post-automator`), not in any general-purpose
  "linkedin-api"-branded library.

### Browser-automation posters (the pattern this project actually wants)

Searched specifically for Playwright/CDP-based posters that could plausibly attach to an existing logged-in
Chrome rather than logging in fresh — this is the pattern W3 recommends building rather than adopting.
Everything found is a hobby project, not a reference implementation:

| name | URL | ★ | last push | note |
|---|---|---|---|---|
| `M-Hammad-Faisal/linkedin-auto-poster` | [github](https://github.com/M-Hammad-Faisal/linkedin-auto-poster) | 3 | 2026-03-26 | Node/TS/Playwright, "scheduling and immediate publishing" |
| `syednajaf28/Agentic-LinkedIn-Poster` | [github](https://github.com/syednajaf28/Agentic-LinkedIn-Poster) | 0 | 2026-04-26 | Claude + Playwright agent, fetches news and posts |
| `m13v/video-social-poster` | [github](https://github.com/m13v/video-social-poster) | 1 | 2026-03-04 | Playwright + macOS automation, multi-platform (LinkedIn, X) |
| `lanfuli/wayamzpost` | [github](https://github.com/lanfuli/wayamzpost) | 0 | 2026-05-08 | explicitly uses **Chrome CDP** (not Playwright's own browser) across X/LinkedIn/other sources — closest naming match to the CDP-attach pattern W3 recommends, but effectively a solo hobby project |

None of these were deep-read (star counts didn't justify the budget), but their existence at all — and their
uniform near-zero traction — is itself the finding: **the specific shape this project wants (own CDP client,
attach to existing Chrome, post deterministically) isn't a solved, popular problem anywhere in OSS.** This
matches W3's independent conclusion from the tooling-comparison side.

### Paid relays

Already covered in depth by [R4-risk-and-market.md §5](R4-risk-and-market.md) (PhantomBuster from $69/mo,
Unipile from ~$55/mo/10-account-minimum, both session-riding not officially-partnered). This pass adds one
current pricing refinement: Unipile's own 2026 pages state **€49/month covers up to 10 connected accounts,
then €5/account beyond that**, post-paid on peak usage, 7-day free trial (`social`, WebSearch of Unipile's
current pricing/review pages, not fetched from unipile.com directly this pass). Consistent with R4's figure,
different currency framing. Not re-litigating R4's conclusion that Unipile is the closest *architectural*
precedent (own-session, no data resale) but is still a paid third party the user explicitly doesn't want.

### Browser extensions

Not deep-researched this pass (R2/R4 already name PhantomBuster, Expandi, and reference "Goji Berry" as
known closed-source LinkedIn automation SaaS). No new open-source browser-extension-based LinkedIn poster
worth flagging was found in the GitHub searches run here beyond what R1/R4 already cover.

---

## Priority 3 — practitioner signal (X)

Ran two `xrelay search` queries (`"linkedin voyager api posting bot banned"`, `"linkedin mcp server voyager
api detection"`, 15/10 results respectively, 2026-08-11/12 window). **Signal was thin** — this specific
technical question (raw HTTP vs. browser automation for LinkedIn writes, detection consequences) does not
appear to be something people are discussing on X in a way that surfaced in these two queries; most results
were generic MCP-architecture commentary or unrelated LinkedIn growth-hacking content. The one directly
relevant post:

> "...4 places to post the same [thing] and all done in one. And I love how the bots talk to each other so
> the blog post bot sent a message to the LinkedIn bot. Damn thats good." — but the same post also notes
> *"posting to here failed with login issues"* for one of the four platforms
> ([@debs_obrien, 2026-08-11](https://x.com/debs_obrien/status/2087295741135847909))

Weak but consistent with everything else in this doc: a practitioner running a real multi-platform
auto-posting pipeline hit **auth/login friction specifically**, not a detection/ban report — matches R2's
own finding (`R2-field-reports.md`) that the corpus has no corroborated numeric ban-rate data, just
qualitative friction reports. Given the low yield, this pass did not spend further query budget chasing this
signal (per the assignment's own guidance to move on rather than retry stalls) — **this should be read as "X
search didn't have much to say," not as evidence of anything.**

---

## Unknowns

- **Why `tomquirk/linkedin-api` actually disappeared** — repo 404, account intact, last PyPI release
  pre-Nov-2024 per secondary sources; no primary statement (blog post, issue, LinkedIn legal notice) found
  explaining it. R1 already flagged this as unverified; still unverified here.
- **Whether Agent-Reach's LinkedIn channel has ever actually been exercised end-to-end by a real user** — the
  code only checks configuration, it doesn't itself install/run `mcp-server-linkedin`; no usage telemetry or
  issue-tracker evidence was reviewed on whether Agent-Reach users successfully get LinkedIn working through
  it in practice.
- **Whether any raw-HTTP LinkedIn poster (`sigcli`, `bcharleson/linkedincli`, `CRAKZOR`) has ever been
  banned or restricted** — W1 found the request shape works mechanically; neither W1 nor this pass found any
  issue, changelog, or social post reporting an account consequence from using them. Absence of evidence,
  not evidence of absence — these are small enough that a ban might simply never get reported publicly.
- **Unipile's exact current pricing page was not fetched directly this pass** (WebSearch summary of
  third-party review sites only) — worth a direct fetch of unipile.com before quoting the €49/€5 figures in
  anything user-facing.
- **X practitioner signal on this exact question is thin by result, not by design** — only two queries were
  run, per budget guidance; a wider sweep (more queries, `xrelay batch`) might surface more, but was judged
  not worth the 1–4 minutes/query cost given how generic the first two results were.
