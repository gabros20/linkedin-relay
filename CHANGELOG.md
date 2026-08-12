# [1.1.0](https://github.com/gabros20/linkedin-relay/compare/v1.0.0...v1.1.0) (2026-08-12)


### Features

* **oauth:** add the three-legged login that actually obtains a write token ([de0a718](https://github.com/gabros20/linkedin-relay/commit/de0a718a0757aa0eab39b144aaed4653a3d5427b))

# 1.0.0 (2026-08-12)


### Bug Fixes

* **build:** run the binaries under Bun so bun:sqlite resolves ([330ee25](https://github.com/gabros20/linkedin-relay/commit/330ee2508f2a55c2d6168b8198a20b686bb5499f))
* **cache:** accent-insensitive offline search, and keep stdout JSON-only ([ac1aff3](https://github.com/gabros20/linkedin-relay/commit/ac1aff3676df5eac59197c0882eec751f74e5662))
* **ci:** drop registry-url so semantic-release owns npm auth ([795d99c](https://github.com/gabros20/linkedin-relay/commit/795d99cfa01a6d0fb6520a92435f6062e28322a7))
* **restli:** escape URL-hostile characters in encoded values ([7f7a509](https://github.com/gabros20/linkedin-relay/commit/7f7a50952983c3aab2ececfcecd24ac0aa4c28a4))


### Features

* deliver the advertised output flags, and make the docs enforceable ([cdaf053](https://github.com/gabros20/linkedin-relay/commit/cdaf053650daf37477298ed7c69c8d08f9eb88f3))
* **engine:** Phase 0 gate passed — raw HTTP still reaches Voyager in 2026 ([f044bca](https://github.com/gabros20/linkedin-relay/commit/f044bca5fa49e68f388da6fba5fc3f4dc7f8f08c)), closes [#1](https://github.com/gabros20/linkedin-relay/issues/1) [#2](https://github.com/gabros20/linkedin-relay/issues/2)
* **engine:** response classifier and Voyager parser ([b7a8103](https://github.com/gabros20/linkedin-relay/commit/b7a8103ef543497a226d43b16d5d26f0b905df14))
* **mcp:** read-only agent surface, generated skill, parity test ([0d57667](https://github.com/gabros20/linkedin-relay/commit/0d57667854205533a33fca94fc5407e06564c245))
* Phase 1 scaffolding — envelope, Rest.li codec, budget ledger, CLI ([2c1463e](https://github.com/gabros20/linkedin-relay/commit/2c1463e992f3931cf633a3cd3892fa1b01e726f6))
* Phase 2 — engine wired, four commands live against LinkedIn ([5daff5f](https://github.com/gabros20/linkedin-relay/commit/5daff5f8344dcb980254a8971290d49bfcd8be64))
* Phase 3 — post comments, reactions, and feed engagement counts ([54c817a](https://github.com/gabros20/linkedin-relay/commit/54c817a04b5f7303bfe41b6f104645ad24bc6bb6))
* Phase 4 — SQLite cache, offline search, opt-in retention ([69fd47d](https://github.com/gabros20/linkedin-relay/commit/69fd47df33bd4dd6a289d9deda1b5905def1fb08))
* Phases 1-6 complete — sync, offline reads, and the OAuth write path ([034651a](https://github.com/gabros20/linkedin-relay/commit/034651a5cc9a0e873611d564893541142f42b962))
