## [2.0.1](https://github.com/gabros20/linkedin-relay/compare/v2.0.0...v2.0.1) (2026-08-14)


### Bug Fixes

* **comments:** a comment's thread is not always an activity urn ([228c747](https://github.com/gabros20/linkedin-relay/commit/228c747987cd61aebcfe91e90f1f6fbd8152bbb8))

# [2.0.0](https://github.com/gabros20/linkedin-relay/compare/v1.7.0...v2.0.0) (2026-08-13)


* refactor(comment)!: editing gets its own verb ([24de4b1](https://github.com/gabros20/linkedin-relay/commit/24de4b1cc6bc53dde0dd60eb1b09ae98d8f56cbf))


### BREAKING CHANGES

* `lnrelay comment <comment-urn> "text"` no longer edits that
comment; it is refused. Use `lnrelay edit <comment-urn> "text"`.

462 tests.

# [1.7.0](https://github.com/gabros20/linkedin-relay/compare/v1.6.0...v1.7.0) (2026-08-13)


### Features

* **comments:** wire edit and delete into the CLI, routed by urn ([7a3c259](https://github.com/gabros20/linkedin-relay/commit/7a3c259a09d732d8c1f30ae17f3f3ba2865bcc55))

# [1.6.0](https://github.com/gabros20/linkedin-relay/compare/v1.5.1...v1.6.0) (2026-08-13)


### Features

* **comments:** edit and delete, discovered by asking the server ([44942cc](https://github.com/gabros20/linkedin-relay/commit/44942cc1fce69fa4fe4b66c644404a6e1746a053))

## [1.5.1](https://github.com/gabros20/linkedin-relay/compare/v1.5.0...v1.5.1) (2026-08-13)


### Bug Fixes

* **comment:** account for the harvest, which was invisible traffic ([d9e5ff8](https://github.com/gabros20/linkedin-relay/commit/d9e5ff841ca2db8e2c369daf690015a92be802b6))

# [1.5.0](https://github.com/gabros20/linkedin-relay/compare/v1.4.0...v1.5.0) (2026-08-13)


### Features

* **comment:** build the SDUI comment payload and harvest its tokens ([63cc6c5](https://github.com/gabros20/linkedin-relay/commit/63cc6c58f269dab6e601d35ce4f204deb03fcc3a))

# [1.4.0](https://github.com/gabros20/linkedin-relay/compare/v1.3.3...v1.4.0) (2026-08-13)


### Features

* **harvest:** derive and verify the tokens a comment needs, no browser ([462ca79](https://github.com/gabros20/linkedin-relay/commit/462ca79a00d1e7635da80cd9877f7e2dff0291cc))

## [1.3.3](https://github.com/gabros20/linkedin-relay/compare/v1.3.2...v1.3.3) (2026-08-13)


### Bug Fixes

* **delete:** evict the deleted post from the local cache ([b4e85c6](https://github.com/gabros20/linkedin-relay/commit/b4e85c6454a2e695184e05abaa87c50569ef8191))

## [1.3.2](https://github.com/gabros20/linkedin-relay/compare/v1.3.1...v1.3.2) (2026-08-13)


### Bug Fixes

* **budget:** a write was billed twice, locking the user out early ([6f32d73](https://github.com/gabros20/linkedin-relay/commit/6f32d73dd360ae1487a7488cf0e45048fb87ee28))

## [1.3.1](https://github.com/gabros20/linkedin-relay/compare/v1.3.0...v1.3.1) (2026-08-13)


### Bug Fixes

* **classify:** a write's response is a receipt, not a read contract ([00a5fc2](https://github.com/gabros20/linkedin-relay/commit/00a5fc26859a0365fd4fea4a2ad37747d3d8378d))

# [1.3.0](https://github.com/gabros20/linkedin-relay/compare/v1.2.3...v1.3.0) (2026-08-13)


### Features

* **react:** implement reactions from a live capture of LinkedIn's SDUI surface ([d8a451c](https://github.com/gabros20/linkedin-relay/commit/d8a451c3349316dd4df7ac8c6642458a02ec46ce))

## [1.2.3](https://github.com/gabros20/linkedin-relay/compare/v1.2.2...v1.2.3) (2026-08-13)


### Bug Fixes

* **observe:** watch every tab and worker, not one page ([f8c40c9](https://github.com/gabros20/linkedin-relay/commit/f8c40c94c805a094f86f1795f129bb1ed266a561))

## [1.2.2](https://github.com/gabros20/linkedin-relay/compare/v1.2.1...v1.2.2) (2026-08-13)


### Bug Fixes

* **read:** my-posts returned nothing, and its posts had no urn ([318a3ad](https://github.com/gabros20/linkedin-relay/commit/318a3ad008a29736367ed8cd766d8e5242d0ed56))

## [1.2.1](https://github.com/gabros20/linkedin-relay/compare/v1.2.0...v1.2.1) (2026-08-13)


### Bug Fixes

* **classify:** accept 201 and 204 — a write is not a failed read ([a92fe28](https://github.com/gabros20/linkedin-relay/commit/a92fe289220922245925707056a5c890bbfbe31e))

# [1.2.0](https://github.com/gabros20/linkedin-relay/compare/v1.1.0...v1.2.0) (2026-08-12)


### Features

* **write:** delete a post, and never do it blind ([e8a79de](https://github.com/gabros20/linkedin-relay/commit/e8a79de909ec3e8938e394781c8807d60950d508))
* **write:** post over Voyager when no OAuth app is available ([9b099db](https://github.com/gabros20/linkedin-relay/commit/9b099dbaba54e95ef00dbdb54f368e1a4d8d7ab2))

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
