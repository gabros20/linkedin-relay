# linkedin-relay

**Status: design complete, nothing implemented.** This repo currently contains research, a converged
design, and a build plan. No code has been written, deliberately — the design's Phase 0 gate must pass
first (see [docs/PLAN.md](docs/PLAN.md)).

A deep-research tool for LinkedIn — a TypeScript CLI (`lnrelay`) + a thin read-only MCP shim
(`linkedin-relay-mcp`) + a Claude Code skill. Sibling to [`x-relay`](../x-relay),
[`github-relay`](../github-relay) and [`youtube-context`](../youtube-context); same stack, same shape,
same philosophy.

---

## Read this before anything else

**If your LinkedIn account is materially load-bearing for your income right now, do not run this
tool.** LinkedIn can restrict or permanently ban an account, the appeal process routes through
third-party identity verification and frequently fails, and unlike an X account a professional
identity of N years cannot be re-registered. That asymmetry is the strongest single fact in the
research behind this design, and it argues against the project on its own terms.

This tool **breaches LinkedIn's User Agreement §8.2.** It is not ToS-compliant and this repo will
never claim it is. It is also not "legally safe": the practical protection for a single-account,
non-reselling personal tool is that it is not economically worth suing — an economics fact, not a
property of the design. The Proxycurl founder's own conclusion, after being sued and shutting down, is
worth quoting exactly: **"Legal does not mean safe."**

What the design *does* control is account-ban risk, which is a different and more tractable objective.
That is what most of it is about.

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
