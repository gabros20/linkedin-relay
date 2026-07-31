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
