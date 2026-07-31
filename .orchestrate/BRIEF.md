# Design brief — linkedin-relay

You are one of **three independent expert architects** on a design panel. The other two are frontier
models from different lineages. You will each answer the same question without seeing each other's
work, and then in a second round you will read the others' proposals and attack them. The controller
(Claude Opus 5) synthesises the result. **Your value to this panel is your independence** — do not
try to guess a consensus, and do not hedge toward the middle. Say what you actually think is right,
and say plainly where you think the premise is wrong.

## Read these first, in this order

All paths are relative to the repo root you are running in
(`/Users/tamas/Documents/Personal/Projects/linkedin-relay`). You have read access — actually open
them; do not answer from the summaries below.

| file | what it gives you |
|---|---|
| `.orchestrate/CONTEXT.md` | What we are building and why; the existing "relay family". |
| `.orchestrate/raw/R5-relay-pattern.md` | **The most important one.** A normative spec of the family's architecture, extracted from the existing code with excerpts. Your design must be recognisably a member of this family. |
| `.orchestrate/raw/R3-linkedin-surface.md` | LinkedIn's actual technical surface — auth, Voyager/GraphQL endpoints, response shapes, defenses. Every claim is tagged verified / reported / unverified. **Respect those tags.** |
| `.orchestrate/raw/R1-github-landscape.md` | Prior art: what exists in open source, what's alive, what died and why. |
| `.orchestrate/raw/R2-field-reports.md` | Practitioner field reports from X — ban evidence, rate-limit envelope, detection mechanics. |
| `.orchestrate/raw/R4-risk-and-market.md` | Law, ToS, GDPR, account-risk, commercial alternatives, and a hard-constraints list. |

You may also read the sibling implementation directly if it helps —
`/Users/tamas/Documents/Personal/Projects/x-relay/src/` is the flagship and is on disk.

## The question

**Design linkedin-relay: the best possible personal, single-account, agent-driven deep-research and
account-management tool for LinkedIn — a CLI + thin MCP shim + generated Claude Code skill, in
Bun/TypeScript, in the shape of the relay family.**

Not a survey. A design: specific, opinionated, buildable.

## What your proposal must cover

1. **Scope and command surface.** The concrete list of commands, their arguments, and their output
   shape. What is read-only, what is a write, what is CLI-only vs. exposed over MCP. Justify every
   command's existence — a command that an agent will not actually use is a liability. Say
   explicitly what you are **leaving out** and why.
2. **The engine.** How we authenticate, how we talk to Voyager/GraphQL, how we survive queryId and
   schema drift, how we detect and handle rate limits, challenges, and restriction states. Given
   R3's verification tags, be explicit about what must be **discovered empirically** by watching real
   traffic before a line of engine code is written, versus what we can build now on documented facts.
3. **The parser.** LinkedIn's `included[]` + URN-reference model is the analogue of X's
   `instructions[]→entries[]`. Design the normalisation layer. R5 documents a production bug that
   cost x-relay every reply in every thread because it filtered by an accept-list — apply that lesson
   here concretely, don't just cite it.
4. **The local cache and incremental sync.** LinkedIn has no snowflake ids. What plays the role of
   the watermark? If the pattern genuinely does not transfer, say so and design what should replace
   it, rather than forcing the analogy.
5. **Safety architecture.** How the design encodes R4's hard constraints structurally — in types and
   control flow, not in documentation. A constraint that lives only in a README is not a constraint.
   Include the rate-limit/pacing model, the write-confirmation model, the cache-retention/purge
   model, and how the tool makes its risk legible to the user at the moment of risk.
6. **The MCP surface and skill.** What an agent sees, and how the tool descriptions teach the agent
   to interpret results correctly — especially how to distinguish "no data" from "failed fetch",
   which R5 identifies as a load-bearing pattern.
7. **Build order.** A phased plan where each phase ends in something demonstrably working. Name the
   riskiest assumption in the whole design and put the cheapest test of it in phase 1.
8. **The kill criteria.** Under what discovered facts should this project be abandoned or radically
   rescoped? Be honest. If your reading of the research says the whole premise is unsound, say that
   — that is a legitimate and valuable answer, and it will be weighted as such.

## Constraints you may not negotiate away

From R4's hard-constraints list (read them in full there): one user-owned session only; no fake or
secondary accounts; no multi-tenant data lake or resale; every write gated behind explicit human
confirmation; loud failure on 429/challenge rather than retry-hammering; bounded retention of
third-party personal data with a working purge; and documentation that states the ToS breach plainly
rather than claiming compliance.

You may argue that a constraint should be *stricter*. You may not argue it away.

## Output contract

Write your proposal to the file path given in your task instruction. Markdown. Aim for 2,000–4,000
words — dense, structured, decision-first. Prefer tables and concrete signatures over prose.

Three qualities will be weighted above all others:

- **Groundedness.** Cite the research file and the specific finding behind each decision. A design
  choice that floats free of the evidence will be discounted.
- **Falsifiability.** For each risky assumption, state what observation would prove it wrong.
- **Disagreement.** Where you think the brief, the research, or the family pattern is wrong, say so
  explicitly in a section titled **"Where I dissent"**. A proposal with no dissent section will be
  treated as a proposal that did not think hard enough.
