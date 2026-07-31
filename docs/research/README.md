# Research lanes

Five parallel research slices, run 2026-07-31 / 08-01, that the design in [../DESIGN.md](../DESIGN.md)
was built from. Each was produced independently and was told to mark unverified claims rather than
smooth over gaps — that discipline is why R2 says "corpus thin" instead of inventing a rate-limit
table.

| file | lane | headline finding |
|---|---|---|
| [R1-github-landscape.md](R1-github-landscape.md) | GitHub prior art (via `ghrelay`, 90-repo corpus) | The flagship unofficial client `tomquirk/linkedin-api` **404s as of 2026-08-01** though its PyPI package is live. The raw-Voyager-client lineage is dead as maintained code. Best find: `mguttmann/linkedin-internal-api` — 130 endpoints tagged verified/discovered/inferred, browserless, with a CDP cookie-extraction flow. |
| [R2-field-reports.md](R2-field-reports.md) | Practitioner field reports (via `xrelay`, 364 posts + 5 deep threads) | **No corroborated numeric rate limits exist** in the corpus, and the file says so rather than guessing. The actionable finding is qualitative: multiple restriction reports involve *zero automation and zero writes* — fast manual browsing alone. Reads must be paced like writes. |
| [R3-linkedin-surface.md](R3-linkedin-surface.md) | LinkedIn's technical surface | Auth, the Voyager REST.li/GraphQL split, Rest.li's tuple grammar, the `included[]` decoration model, defenses, and the official path. Every claim tagged verified/reported/unverified. Identifies the design's highest-leverage question: does this need a browser under it? |
| [R4-risk-and-market.md](R4-risk-and-market.md) | Law, ToS, GDPR, market | Verbatim User Agreement clauses; the hiQ → Mantheos → Proxycurl arc; what actually loses in court (contract, not CFAA, once an account is in play); and a hard-constraints list the design had to honour. |
| [R5-relay-pattern.md](R5-relay-pattern.md) | The relay-family pattern | A normative MUST/SHOULD spec extracted from x-relay / github-relay / youtube-context with code excerpts, including the four production scars and the general lesson each one teaches. |

Two large raw artifacts are gitignored as re-derivable and full of third-party personal data:
`.orchestrate/raw/corpus.json` (90 GitHub repos) and `.orchestrate/raw/r2-archive.json` (364 posts).
