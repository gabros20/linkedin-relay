# linkedin-relay

A deep-research tool for LinkedIn — a TypeScript CLI (`lnrelay`) + a thin read-only MCP shim
(`linkedin-relay-mcp`) + a Claude Code skill. Sibling to `../x-relay`, `../github-relay` and
`../youtube-context`; same stack, shape, and philosophy.

**Current state: design complete, zero code.** `docs/DESIGN.md` is ratified and `docs/PLAN.md` is the
build order. Do not start implementing an engine before Phase 0 passes — that gate exists because the
entire architecture rests on one unproven assumption.

## Dev commands (once scaffolded)

- `bun run check` — full CI: typecheck + lint + test
- `bun test` / `bun test --watch`
- `bun run typecheck` / `bun run lint` / `bun run lint:fix`
- `bun run build` — generate skill + build to dist/ via tsup
- `bun run dev` — generate skill + run the CLI from source

## Architecture

Read `docs/DESIGN.md` in full before touching any of this. The short version:

- `src/cli.ts` — CLI entry (`lnrelay`); parses args, dispatches, prints a JSON envelope to stdout.
- `src/mcp-shim.ts` — MCP entry; **read-only subset**, thin, no business logic.
- `src/entry.ts` — pure main-module detection, ported verbatim from x-relay (resolves symlinks so the
  npm bin shim runs instead of silently exiting).
- `src/engine/` — the ONLY place that talks to LinkedIn. `auth.ts`, `restli.ts` (Rest.li 2.0 variables
  codec), `contracts/` (versioned queryIds/decorationIds/headers/UA), `scheduler.ts`, `classify.ts`,
  `client.ts`, `parse/`, `oauth-write.ts`, `index.ts`.
- `src/cache/` — SQLite store under `~/.lnrelay`, behind a narrow `load/save/upsert/query` interface.
- `src/commands/registry.ts` — single source of truth; drives CLI + MCP + SKILL parity test.
- `src/format.ts` / `src/output.ts` / `src/types.ts` — pure helpers, envelope, domain types. No I/O.
- `src/progress.ts` — stderr progress; `--quiet` silences it. **stdout stays JSON-only.**

## Non-negotiables

These are load-bearing. Changing one means re-opening the design, not editing a line.

1. **Parse by exclusion, never by an accept-list.** Unknown types pass through as data *and* are
   counted into `meta.unknownTypes`. An accept-list cost x-relay every reply in every thread while
   returning `ok:true`.
2. **Never an empty success on failure.** `claimedCount > 0 && returnedCount === 0` is `ok:false`.
   `data` referencing URNs with `included: []` is `SCHEMA_DRIFT`. `meta.state` is required and
   three-valued — never an optional boolean that defaults to the reassuring answer.
3. **Zero automatic retry** on 429 / 999 / challenge. The cooldown is a file, checked by every entry
   point before any network call.
4. **No network call without a `Permit`** — including redirects, pagination and contract discovery.
5. **Corrupt cache quarantines and fails loudly.** Never-throw is not never-fail: degrading to an
   empty success turns a disk error into a full resync against a hostile platform.
6. **Writes are OAuth-only, CLI-only, and require a `ConfirmedWrite<T>`** that only the interactive
   `confirm` command can mint. No `--yes`, no env-var, no config escape hatch.
7. **Third-party data is not cached by default.**
8. **Never commit raw captures, HARs, or cookies.** Redact by hand into `tests/fixtures/` first.
9. **Never claim ToS compliance or safety** in code comments, docs, or error messages.

## Testing rules

Test **behaviour**: parse normalisation on captured fixtures, cursor/exhaustion logic, the Rest.li
codec, URN canonicalisation, watermark + 2-page-slack logic, arg parsing, envelope shape, permit
accounting, cooldown transitions. Every parser fixture carries the counting assertion: *this fixture
has N content-bearing nodes; the parser emits N.*

Do NOT test what `tsc`/Biome already enforce. Keep live smoke tests out of unit CI.

## Engineering workflow

- **TDD is mandatory** for production code: failing test first, watch it fail, minimal code to pass.
- **Conventional Commits** — `semantic-release` derives version + CHANGELOG. Never hand-bump.
- **Small commits**, one logical unit each.

## Key reference documentation

- `docs/DESIGN.md` — the ratified design and why each decision was made
- `docs/PLAN.md` — phased build order and the Phase 0 gate
- `docs/research/` — the five research lanes this was built from
- `.orchestrate/panel/` — the three independent proposals and their cross-critiques
- `../x-relay/docs/ENGINE-RESEARCH.md` — the standard of specificity for our own engine research
