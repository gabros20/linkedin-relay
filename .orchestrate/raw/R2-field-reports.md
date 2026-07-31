# R2 — Practitioner Field Reports: LinkedIn Automation in the Wild

Source: X/Twitter sweep, 15 queries → 364 deduped posts (`.orchestrate/raw/r2-archive.json`, collected
2026-07-31), plus 5 deep-read threads pulled via `xrelay thread` (saved under `/tmp/r2threads/`, not
in this repo — re-derivable from the tweet IDs cited below). Corpus spans 2012–2026 but automation/ban
discussion clusters almost entirely in 2025–2026; dates are called out per claim. Confidence tags:
**verified** (artifact/screenshot or cross-corroborated by independent unrelated accounts), **reported**
(plausible first-person account, no artifact), **rumor** (vague, secondhand, or from a
selling-the-solution bio).

## 1. Ban/restriction evidence table

| Action / trigger | Volume or detail stated | Outcome | Date | Source | Confidence |
|---|---|---|---|---|---|
| Manual (non-automated) rapid opening of ICP profiles from Sales Navigator | unspecified volume, self-described as manual | Account banned | 2026-06 (reply to id 2066618816335950326) | [@BehrensCorey](https://x.com/BehrensCorey/status/2066748423303213084)-adjacent reply | reported |
| "Conservative" use of a 3rd-party MCP-based outreach tool | unspecified, self-described as conservative | Force-logout + explicit automation warning on next login | 2026-06 | reply to id 2066618816335950326, @frankcowell | reported |
| Just "clicking around and opening new tabs," no automation tool used | unspecified, described as fast/heavy tab-switching | "Permanent underclass restriction" (a named LinkedIn restriction tier), locked out of login entirely | 2026-05-28 | [@tekbog](https://x.com/tekbog/status/2059841283674533977) (201 likes, 30 replies) | reported — but note a reply from @brettfarrow claims the account's *activity pattern* (reading without posting) looked automated, i.e. velocity/behavior, not a specific tool, is the likely trigger |
| Account "locked entirely," asked to upload government ID to unlock | "dunno what i did other than click around" | Full lockout pending ID verification | ~2026-05 (reply to tekbog thread) | @NeonNoodle22 | reported |
| Apollo (major sales-outreach SaaS) LinkedIn integration | company-scale, not individual | Apollo "had to stop its connection to LinkedIn" | referenced retrospectively in 2026-06, describing 2025 | cross-corroborated: @filos (reply, id 2066748423303213084) AND @EdWeeksJr ("Apollo and Seamless found out in 2025") independently, id 2066866709558894787 | verified (two independent accounts naming the same company/event) |
| Seamless.AI LinkedIn integration | unspecified | Implied restricted/broken per ToS enforcement, grouped with Apollo | 2025 | @EdWeeksJr, id 2066866709558894787 | reported (single source) |
| Any 3rd-party automation tool without a residential/dedicated IP (no VPN) | n/a | "Typically gets you banned" | 2026-06 | @0xlentil, reply to id 2066618816335950326 | rumor (no specifics) |
| Using a 3rd-party MCP for LinkedIn (general) | n/a | Multiple independent commenters: "you'll get blocked pretty quickly," "yeah all yall getting banned soon," "shadowban incoming," "this is most definitely against tos" | 2026-04 | replies to @cdxker thread, id 2043061865048347120 | rumor/reported mix — consensus sentiment, no specific artifacts |
| Manual profile updates (non-automation) flagged for political content | n/a | Banned within ~5 minutes of a resume edit, appeal denied | 2026-07-31 | [@NotMikeHarlow](https://x.com/NotMikeHarlow/status/2083221667409428903) | reported — but this reads as content-policy moderation, not automation detection; low relevance to rate-limit design |
| Numerous individual "restricted without reason, no automation used" appeals to @LinkedInHelp | n/a | Restricted, appeals rejected or unanswered for weeks/months | recurring throughout 2024–2026, at least 15 separate individuals in corpus | see e.g. ids 2082559901738369136, 2082569109791719570, 2050078818539622785, 2068613909809156466, 2031927630644330661 | reported (high volume of *independent* similar complaints, but each individually unverifiable — could reflect false positives, hacked accounts, or undisclosed activity) |
| Identity-verification appeal flow after restriction routes through a third-party vendor named "Persona" | n/a | Appeal fails on "Couldn't verify photos," accepted-ID types rejected, cases stuck 30+ days | 2026-07 (5+ independent posters, same vendor name) | ids 2083257638830358725, 2083081924248309931, 2083199116952187138 (implicit), 2083249810400800810, 2083209898964238582 | **verified** — five unrelated accounts across the same week independently name the identical proprietary vendor ("Persona"); too specific and consistent to be coincidental, strong signal about LinkedIn's actual restriction-appeal architecture even without a LinkedIn-side confirmation |
| "Coldcast" tool, browser-based human-speed extraction, own session | claims 6 months in production | "Zero LinkedIn suspensions, not one" | claimed as of 2026-07-30 | @hasanrahma00, id 2082873858391253219 | rumor — 27-follower account marketing its own product; self-interested, unverifiable, but the *mechanism claim* ("cloud scrapers share fingerprints across accounts — when one gets flagged, they all do") is a plausible and often-repeated architecture pattern worth noting as a hypothesis, not a fact |

## 2. Inferred rate-limit envelope

**This corpus does not contain hard, corroborated numeric ceilings for most action types.** Where a
number appears, it is a vendor's or growth-hacker's own marketing claim, not an independently verified
LinkedIn-side limit. I am flagging extrapolation explicitly rather than inventing precision the evidence
doesn't support.

| Action type | Best evidence-based number | Evidence | Confidence / extrapolation flag |
|---|---|---|---|
| Connection requests | "~20 invites a day" cited as a cap that a named competing tool ("LinkNav")'s own blog documents, calling anything faster via API "a fast permaban" | @EdWeeksJr, id 2066866709558894787 (secondhand paraphrase of a vendor blog post, not directly read) | reported — single secondhand source; directionally consistent with widely-known industry lore (LinkedIn's public weekly invite caps have historically been in the 100–200/week range for free accounts) but the corpus itself gives only this one ~20/day figure |
| Connection requests (agency claim) | "~400 connection requests to work with" (unclear if per week/month/campaign) | @dan__rosenthal, id 2081016705447301404 (216 likes, 285 replies — but replies were mostly people asking for the lead-magnet, not corroborating the number) | rumor — vague unit, self-interested (selling an outreach guide), not corroborated in its own reply thread |
| Connection acceptance / reply rates (not a safety limit, but a benchmark) | 40–50% acceptance, 15–25% reply, 10–15% positive-reply claimed as achievable; two *other* unrelated accounts (@pierreeliottlal, @romanbuildsaas) independently posted near-identical "50%+ acceptance / 40%+ reply" claims within days | ids 2081016705447301404, 2082746347728314679, 2083111562877804902 | rumor — near-identical numbers from multiple lead-magnet marketers suggests a shared template/script rather than independently measured results; treat as marketing copy, not evidence |
| Messages | **corpus thin: 0 posts with a specific per-day/per-week message cap.** | — | not found — do not encode a number from this corpus |
| Profile views | **corpus thin: 0 posts with a specific per-day/per-month view cap.** LinkedIn's well-known public "commercial use limit" on search/profile views is common outside-corpus industry knowledge but was not surfaced by any of the 15 queries run. | — | not found in this corpus — flag for the design panel to source separately if a number is needed |
| Search | same as above — corpus thin, 0 substantive posts | — | not found |
| Posts / reactions / feed reads | **corpus thin: 0 posts with any rate figure.** The one datapoint here is qualitative: multiple people describe getting flagged for *reading/browsing velocity alone* (tekbog, BehrensCorey, frankcowell) with no automation tool involved, which argues that **read-heavy velocity, not just write actions, is itself a detection trigger** — a finding more useful to the design than any specific number. | ids 2059841283674533977 (+ replies), reply chain to id 2066618816335950326 | reported, and the single most actionable qualitative finding in this section |
| API/MCP automated writes (connect, message) vs. reads | One practitioner claim: "MCP works for reading LinkedIn but not for writing (connections, messages)" | @FilippoCagliero, reply to id 2043061865048347120 | reported, single source, but directionally consistent with the rest of the corpus (no verified write-automation success stories; several verified failure/restriction stories tied to write-style automation) |

**Design implication (my synthesis, not a corpus quote):** the corpus supports pacing *reads* as
conservatively as writes — several restriction reports involve zero automation and zero write actions,
only fast manual browsing. It does not support picking a specific numeric envelope per action with
confidence; the design should either (a) source LinkedIn's own current public help-center numbers
directly (out of scope for this X sweep) or (b) default to the most conservative end of what's floating
around here (order of 15–20 connection requests/day, not the 400 figure) and make the ceiling
configurable/discoverable rather than hardcoded on faith.

## 3. Detection mechanics

Claim vs. evidence, kept separate deliberately:

- **Behavioral/velocity detection (claim, reported):** a reply to the tekbog restriction post argues the
  account's "activity was sus because it looked like you were reading things instead of posting"
  (@brettfarrow, reply to id 2059841283674533977) — i.e., asymmetric read:write ratio or rapid
  sequential profile/tab opens is itself a signal, independent of any bot tooling.
- **Input-timing / mouse-movement fingerprinting (claim, rumor but specific):** "linkedin often punishes
  me for my low latency connection, full size kbd+mouse on an i9 / all you need is a little perlin noise
  and you are golden" (@Manitcor, reply to id 2059841283674533977). Specific enough to be a real
  practitioner belief, but it's one person's folk theory, not a verified mechanism.
- **Identity-verification vendor "Persona" (verified per above):** LinkedIn's restriction-appeal flow
  routes through a third-party identity-verification product from a company called Persona, corroborated
  by 5 independent posters in the same week (2026-07). This is evidence of enforcement *architecture*
  (what happens after a flag fires), not of the trigger itself.
  - **CAUTION for the design panel:** "Persona" is also a generic English word and a common product name
    (identity-verification vendor Persona Identities is a real, well-known company independent of this
    corpus). The corroboration here is about the *specific appeal-flow experience* (photo verification
    failing, ID types rejected), not a novel discovery — treat as reasonably solid but not exotic.
- **Fingerprint-sharing across cloud/multi-tenant scraping infra (claim, rumor):** "Cloud scrapers share
  fingerprints across hundreds of accounts — when one gets flagged, they all do. You're renting a ban."
  (@hasanrahma00, id 2082873858391253219). Plausible and consistent with how anti-bot vendors describe
  their own fleet-detection heuristics elsewhere (generic, not LinkedIn-specific evidence in this
  corpus), but comes from a 27-follower account marketing a competing product — self-interested framing.
- **TLS/JA3 fingerprinting specifically on LinkedIn: not found.** The corpus surfaced substantial generic
  anti-bot/stealth-browser chatter (CloakBrowser, Botasaurus, NopeCHA, Lightpanda — ids 2032720924047454699,
  2064233547649654925, 2080473049309368392, 2082076214685319466) but none of it names LinkedIn
  specifically as the target; these are general-purpose anti-detection tools discussed in an AI-agent/
  scraping context, not LinkedIn field reports. Do not cite these as LinkedIn-specific evidence.
- **CAPTCHA:** one open question, no answer — "@2BitSalute: So CAPTCHA doesn't work for LinkedIn anymore,
  or they haven't heard of it?" (reply to id 2059841283674533977) went unanswered in the thread.
- **Read vs. write asymmetry (reported):** "MCP works for reading LinkedIn but not for writing
  (connections, messages)" (@FilippoCagliero, reply to id 2043061865048347120) — one data point
  suggesting LinkedIn's enforcement bites harder on automated *write* actions than reads, which sits in
  tension with the velocity-alone findings above (both can't be fully true; more likely both are partial
  truths — reads are more tolerant per-action but still rate-sensitive in aggregate).

## 4. The commercial layer

**Corpus thin here — only 2 posts directly about Proxycurl, despite a dedicated query for it.**

- Proxycurl (LinkedIn Data API) "got sued and shutdown by LinkedIn at ~$10M annual revenue," posted as
  news reacting to the event, calling for "captcha bypassing, fingerprint evading, proxy slinging" people
  to "setup shop next" and @-ing @browserbase as a candidate (@PhilipSnyder, 2025-07-11, id
  1943551741288681559). Single source in this corpus for the shutdown itself.
- Older context (2023-11-23, @IndieHackers, id 1727643623468978535): Proxycurl's founder Steven grew it
  to $100k MRR starting as a LinkedIn scraping API, cold-emailing recently-funded companies from a
  Crunchbase list — useful backstory but pre-dates the shutdown by ~18 months, no bearing on 2026 state.
- **No migration destination found.** The corpus does not show where former Proxycurl customers moved.
  What it does show is a live, fragmented market of smaller players and DIY approaches filling adjacent
  niches (see below) — consistent with "no single successor," but that's an inference, not a corpus fact.
- Adjacent commercial activity found: @paolo_scales (2026-07-28, id 2082103886786257184) describes a live
  "GTM hack" combining PhantomBuster (LinkedIn profile/post scraping) + Apify API to pull competitors'
  lead magnets/hooks/CTAs — i.e., PhantomBuster + Apify are still actively used for LinkedIn scraping in
  mid-2026 despite the Proxycurl precedent, for read-only competitive intel rather than outreach
  automation. @levikmunneke (2026-07-30) markets a new "lead scraper" positioned explicitly against
  Apollo's pricing, evidence the market keeps spawning Apollo/Proxycurl-style entrants regardless of prior
  enforcement action.

## 5. Who is building what

- **LinkNav** — referenced repeatedly as "LinkNav MCP," the specific MCP server @AlfieJCarter's viral
  thread (id 2066618816335950326, 953 likes / 920 replies) is built on for LinkedIn connect/message
  automation via Claude. One reply claims "there is an official linkedin mcp server iirc" referring to
  this (@d3layd) — **unverified whether "official" means LinkedIn-sanctioned or just well-known**; treat
  as unverified/likely not LinkedIn-sanctioned given the surrounding ban discussion in the same thread.
  EdWeeksJr's reply claims LinkNav's *own* blog documents a ~20/day invite cap and calls faster API use "a
  fast permaban" — i.e., even the tool's own vendor is on record warning against its aggressive use.
- **bycrawl MCP** — claimed by a commenter (@kyelchung) to have "the same functionality" as the LinkedIn
  MCP @cdxker was demoing (id 2043061865048347120). Not independently verified.
- **Coldcast** — self-described browser-based, human-speed LinkedIn extraction tool, marketed on the
  "your own session, never looks like a bot" pitch (@hasanrahma00, id 2082873858391253219). Tiny account
  (27 followers), reads as early-stage self-promotion.
- **LinkedInDumper** — an OSINT/security tool that "dump[s] employee information from LinkedIn Voyager
  API," shared via meterpreter.org (@akaclandestine, 2025-10-26, id 1982398163668344853). This is a
  security-research-flavored tool (name recon via Voyager), not a growth/outreach tool — relevant to
  linkedin-relay's engine-research phase (confirms Voyager is still the addressable private API surface
  as of late 2025) more than to the safety-envelope question.
- **agent-reach** — not LinkedIn-specific, but directly relevant as a precedent: a Python package claimed
  to hit 23K GitHub stars offering free, no-API-key scraping across Twitter/Reddit/GitHub/YouTube "via
  direct parsing, not official APIs," explicitly flagged by its own author as "not for production web
  scraping at scale — use for agentic research and prototyping" (@israfill, 2026-06-13, id
  2065868713895829991). Same category of tool as x-relay/linkedin-relay; worth a direct look at its repo
  for prior art on framing "research not scraping," though it was not deep-read here (out of this lane's
  scope, flag for R1/github lane if not already covered).
- **Generic anti-detection browser infra** (not LinkedIn-specific, surfaced by the stealth/fingerprint
  queries, worth naming since a design panel discussing detection risk will ask): CloakBrowser (custom
  Chromium, fingerprints patched in C++ source), Botasaurus (claims to pass Cloudflare WAF/Datadome/
  Fingerprint tests, human-like mouse movement), NopeCHA (CAPTCHA-solving API/extension), Lightpanda
  (from-scratch Zig browser engine, no Chromium). None were reported in this corpus as tested against
  LinkedIn specifically.
- **Expandi / a tool referred to as "Goji Berry"** — named by one commenter as tools that "achieve this"
  (workflows where generic MCP/API automation "tend to fail hard") (@JayKurtz90, reply to id
  2066618816335950326). Expandi is a real, well-known LinkedIn automation SaaS outside this corpus;
  "Goji Berry" could not be verified as a real product name from this corpus alone — flag as unverified,
  possibly a mishearing/joke.

## 6. Open questions / could not verify

- **No hard numeric ceiling for messages, profile views, search, posts, or reactions per day/week/month**
  survived corroboration in this corpus. Any number the design encodes for these action types should come
  from a direct read of LinkedIn's current help-center pages or a dedicated technical writeup, not from
  this X sweep.
- **Whether read-only automation (search/profile/thread reads, no writes) carries materially lower ban
  risk than write automation is unresolved and internally contradictory in the evidence**: several
  restriction reports involve *zero* automation, triggered by fast manual reading alone; one practitioner
  claims MCP reads work fine while writes don't. Both could be true at different volumes — reads may have
  a much higher tolerance ceiling than writes, but still not infinite.
- **CAPTCHA's current role in the enforcement flow is unknown** — one direct question in the corpus went
  unanswered.
- **No TLS/JA3-level technical detail specific to LinkedIn's bot detection was found**, despite a
  dedicated query for browser-automation detection generally. The generic anti-bot tooling chatter found
  should not be cited as LinkedIn-specific.
- **Proxycurl's shutdown mechanics and where its customers migrated were not found** — corpus thin (2
  posts total on Proxycurl), neither with detail on the legal action or the migration.
- **Whether "LinkNav" is LinkedIn-sanctioned, third-party-tolerated, or actively targeted for enforcement
  is unresolved** — the same viral thread promoting it also contains the corpus's strongest ban-risk
  pushback, including from the tool's own apparent documentation (per one commenter's paraphrase).
- **Scale of the individual-restriction complaints (~15+ separate @LinkedInHelp appeals in this corpus)
  could not be tied to any specific cause** — most explicitly deny using automation, and it's impossible
  from public X posts alone to distinguish false positives, undisclosed automation, hacked accounts, or
  unrelated content-policy triggers (e.g. NotMikeHarlow's case looks like political-content moderation,
  not bot detection).
