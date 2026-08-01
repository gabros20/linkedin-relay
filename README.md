# linkedin-relay

**Status: working.** All six phases are built and verified against live LinkedIn. 249 tests.

```
lnrelay login                              # mint a session from your own Chrome
lnrelay search people "rust developer"     # 1.4M claimed, ranked rows back
lnrelay feed                               # your feed, with engagement counts
lnrelay post <activity-urn>                # a post's comment thread
lnrelay sync connections && lnrelay local "rust"   # then search offline, free
```

Also available as an MCP server, so an agent can do the reading — 13 read-only tools, no writes on
that surface at any price.

A deep-research tool for LinkedIn — a TypeScript CLI (`lnrelay`) + a thin read-only MCP shim
(`linkedin-relay-mcp`) + a Claude Code skill. Sibling to [`x-relay`](../x-relay),
[`github-relay`](../github-relay) and [`youtube-context`](../youtube-context); same stack, same shape,
same philosophy.

---

## Read this before anything else

This tool **breaches LinkedIn's User Agreement §8.2.** It is not ToS-compliant and this repo will
never claim it is. Any account it touches can be restricted or permanently banned, with no reliable
appeal — the restriction-appeal flow routes through third-party identity verification that is widely
reported to fail on valid documents.

It is also not "legally safe". The practical protection for a single-account, non-reselling personal
tool is that it is not economically worth suing — an economics fact, not a property of the design. The
Proxycurl founder's own conclusion, after being sued and shutting down, is worth quoting exactly:
**"Legal does not mean safe."**

**Know what you're staking.** A LinkedIn ban is not an X ban: connections, endorsements, message
history and the channel recruiters use are accumulated over years and cannot be re-registered. Run
this on an account whose loss you would genuinely shrug at. If your LinkedIn is materially
load-bearing for your income, that is a real argument against running it at all — weigh it honestly
rather than skipping past it.

What the design *does* control is account-ban risk, which is a different and more tractable objective.
That is what most of it is about — and why reads are paced as conservatively as writes, why nothing is
ever retried automatically, and why the tool refuses to keep working after LinkedIn signals once.

## Why it exists anyway

LinkedIn offers an individual developer **zero** sanctioned read access — no search, no profile
reading, no thread reading, no feed. The partner programs that would grant it require an incorporated
company with a verified Page and months of approval. The only self-serve products are "Sign In with
LinkedIn" (identity only) and "Share on LinkedIn" (write-only).

So the read half of this tool has no substitute and earns its risk. The write half mostly *does* have
a substitute — so it doesn't get to spend the same currency. `share`, `comment` and `react` go over
LinkedIn's own OAuth scope; `connect`, `follow`, `message` and invitation handling are cut entirely.

## Design in one screen

- **Browserless raw HTTP** to LinkedIn's private Voyager API. A real browser mints cookies once, via
  CDP, and is never in the hot path.
- **Zero automatic retry.** A 429 is the warning shot on an escalation ladder, not a suggestion to
  wait and try again. Cooldowns are a *file*, so the breaker survives across processes.
- **Reads paced as conservatively as writes** — the field evidence shows restrictions triggered by
  fast browsing with no automation and no writes at all.
- **Budget as a type.** The client cannot be called without a `Permit` whose only producer is the
  ledger. An unaccounted network call is a compile error.
- **Writes need a capability an agent cannot forge.** `--confirm` is a flag the acting party writes
  about its own action; here the agent *is* the process. Writes create a plan; a separate interactive
  command confirms it.
- **Parse by exclusion, never by an accept-list** — and report unknown types in the envelope. This is
  a scar carried over from x-relay, where an accept-list silently dropped every reply in every thread
  and 34 of 77 posts per feed page while still returning `ok: true`.
- **Third-party data is not cached by default.** When retained, a 30-day TTL swept on the read path;
  on expiry the body dies and only an identity stub survives.
- **Single account by construction** — multi-account isn't disallowed, it's unrepresentable.

Full reasoning: **[docs/DESIGN.md](docs/DESIGN.md)** · Build order: **[docs/PLAN.md](docs/PLAN.md)**

## How this design was produced

Five parallel research lanes (GitHub prior art, practitioner field reports gathered via `x-relay`,
LinkedIn's technical surface, law/ToS/GDPR/market, and the relay-family pattern extracted from the
sibling repos) fed a three-model design panel — GPT-5.6-Sol, Grok-4.5 and Fable 5 — who each wrote an
independent proposal, then read and attacked each other's.

All three changed position under argument. The panel's convergence and the full disagreement record
are in [docs/DESIGN.md §Appendix](docs/DESIGN.md); the raw proposals and critiques are in
`.orchestrate/panel/`, and the research lanes in [docs/research/](docs/research/).

## Non-goals

Mass lead harvesting · multi-account operation or farms · proxy rotation · CAPTCHA solving ·
anti-detection/stealth tooling · reselling or sharing scraped data · outreach automation ·
anything that touches another person's session.

## License

MIT
