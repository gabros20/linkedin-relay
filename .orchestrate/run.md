# Orchestration run — linkedin-relay design

**Goal (stop condition):** a converged `docs/DESIGN.md` + `docs/PLAN.md` in a scaffolded
`linkedin-relay` repo, grounded in deep research and hardened by a cross-lineage expert panel.
Autonomous — no human gate until the goal is met.

## Resolved dimensions

| dimension | value | why |
|---|---|---|
| strategy | **team** research fan-out → **adversarial** panel → controller synthesis | The work is investigation + design, not implementation. Research parallelises cleanly; design benefits from independent challenge. |
| planning | adversarial | Three independent proposals, then cross-critique, then synthesis. |
| review | panel:3 (cross-lineage) | Codex/GPT, Grok/xAI, Fable/Anthropic — three different model lineages so the failure modes are not correlated. |
| engine | mixed (claude + codex + grok) | Native subagents for research; external CLIs for the panel. |
| models | orchestrator: Opus 5 · researchers: Sonnet ×5 · panel: `gpt-5.6-sol`, `grok-4.5`, Fable 5 | |
| isolation | off | Nothing writes to a shared tree except the controller; researchers write to disjoint files. |
| trigger | once | |
| budget | 5 researchers + 3 panelists + 3 critique passes ≈ 11 agent invocations | |

## Preflight (verified 2026-08-01)

- `codex` 0.144.6 — logged in via ChatGPT; `-m gpt-5.6-sol` returns cleanly. Requires
  `--cd <git repo>` or `--skip-git-repo-check`, and `</dev/null` in scripts.
- `grok` 0.2.117 — logged in via grok.com; sole model `grok-4.5` (reports as `grok-4.5-build`).
- `xrelay` 1.5.4 — `doctor`: cookies present (browser extract), bootstrap resolved.
- `ghrelay` — NOT on PATH; invoke as `bun ~/Documents/Personal/Projects/github-relay/dist/cli.js`.
  ~5000 GraphQL points and 4970 REST core available.

## Phases

1. **Research fan-out** — 5 Sonnet researchers, disjoint slices, each writing to `.orchestrate/raw/`:
   R1 GitHub landscape · R2 X field-reports · R3 LinkedIn technical surface · R4 risk/law/market ·
   R5 relay-family pattern extraction.
2. **Consolidate** — controller merges into `docs/RESEARCH.md` + a self-contained `BRIEF.md`.
3. **Panel** — the identical brief to all three; independent proposals; then a cross-critique round
   where each reads the others'.
4. **Synthesis** — controller writes `docs/DESIGN.md` + `docs/PLAN.md`; scaffold and commit.

## Ledger

- 2026-08-01 — workspace created; preflight passed for all three panel engines.
- 2026-08-01 — Phase 1 dispatched (R1–R5).
- 2026-08-01 — R1, R3, R4, R5 delivered. **R2 failed twice** (idled without writing its file); root
  cause was tool latency, not the agent — `xrelay search` takes 2–4 min per query and the agent's own
  timeouts killed it. Controller ran the 15-query `xrelay batch` sweep directly (364 deduped posts),
  then dispatched R2b to analyse the archive. R2b delivered.
- 2026-08-01 — Phase 3 round 1: three independent proposals (P1 Codex 3.0k words, P2 Grok 3.9k,
  P3 Fable 3.2k). Six live disagreements identified.
- 2026-08-01 — Phase 3 round 2: cross-critique on those six. **All three panelists changed position.**
  Grok reversed on five, Fable on four, Codex held its line and was adopted on four. Consensus
  reached on every point; `batch` resolved 2–1 toward cut-from-v1.
- 2026-08-01 — Phase 4: `docs/DESIGN.md` + `docs/PLAN.md` + README + CLAUDE.md written, research
  copied to `docs/research/`, repo scaffolded and committed (`9588f9c`).

## Stop condition — met

Converged design document and phased plan exist in a scaffolded repo. Implementation is deliberately
not started: the design's own Phase 0 gate must run first, and it is a manual one-afternoon
experiment, not a coding task.
