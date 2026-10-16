#!/usr/bin/env bun
// ─── MCP surface ──────────────────────────────────────────────────────────────
//
// Thin by contract: this file validates arguments, calls the same runners the
// CLI calls, and returns the same envelope. No parsing, no transport, no
// pacing, no cache logic lives here.
//
// Writes are not registered. Not disabled, not permission-gated — absent. The
// registry marks each command's audience and risk, `mcpCommands()` filters on
// both, and a test asserts no write survives that filter. An agent talking to
// this server cannot post, comment, react, connect or message, whatever
// arguments it composes.
//
// Tool descriptions do real work here. The agent reads them BEFORE it ever sees
// a response, so each one states the specific misreading that would cause harm
// — chiefly that an empty result and a failed fetch look identical unless you
// check the counts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runCacheStatus, runLocal, runSourceRead } from './commands/cache.ts';
import { runCompany } from './commands/company.ts';
import { runEvent, runEvents } from './commands/events.ts';
import { type JobsRequest, runJob, runJobFilters, runJobs } from './commands/jobs.ts';
import {
  runFeed,
  runPost,
  runProfile,
  runReactions,
  runScheduled,
  runWhoami,
} from './commands/live.ts';
import { runBudget, runDoctor, runRisk } from './commands/local.ts';
import {
  runDraft,
  runDraftRemove,
  runDrafts,
  runInbox,
  runMessages,
} from './commands/messaging.ts';
import { runMyItems } from './commands/my-items.ts';
import { runNetwork } from './commands/network.ts';
import { type PeopleRequest, runPeople, runPeopleFilters } from './commands/people.ts';
import { runPostsSearch } from './commands/posts-search.ts';
import { mcpCommands } from './commands/registry.ts';
import { runExperience } from './commands/role.ts';
import { runFind, runFindFilters } from './commands/search-kinds.ts';
import { runSkills } from './commands/skill.ts';
import { shouldRunAsEntry } from './entry.ts';
import type { Envelope } from './types.ts';

const READING_CONTRACT =
  'ALWAYS read `meta` before reporting. `state:"complete"` with an empty `items` genuinely means ' +
  'none. `state:"partial"` means references failed to resolve — the record is INCOMPLETE, not ' +
  'small. `claimedCount > 0` with `returnedCount === 0` is a FAILED FETCH, never "no results". ' +
  'A non-empty `unknownTypes` means LinkedIn changed shape and the parser is behind — say so. ' +
  'If `meta.budget.remaining` is low, tell the user and stop.';

const NO_RETRY =
  'Never retry on failure. RATE_LIMITED, REQUEST_DENIED, CHALLENGE_DETECTED and COOLDOWN_ACTIVE ' +
  'all mean a cross-process cooldown has opened; every further call will refuse until it lifts. ' +
  'Report it and stop.';

/** Render an envelope as MCP content. Errors stay envelopes, not exceptions. */
function reply(envelope: Envelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'linkedin-relay', version: '0.1.0' });

  // Guard rather than trust: if a write ever reached this list, fail loudly at
  // startup instead of quietly exposing it.
  const exposed = mcpCommands();
  const write = exposed.find((c) => c.risk === 'write');
  if (write !== undefined) {
    throw new Error(`refusing to start: write command '${write.name}' reached the MCP surface`);
  }

  server.tool(
    'risk',
    'Circuit-breaker state and the ToS notice. Free, no network. CALL THIS FIRST in a research ' +
      'session — it reports whether LinkedIn has thrown a throttle, block or challenge, so you ' +
      'find out before spending calls rather than one wasted call at a time.',
    {},
    async () => reply(runRisk(Date.now())),
  );

  server.tool(
    'budget',
    "Remaining request budget per class, with each cap's provenance. Free, no network. The caps " +
      'are deliberately low because LinkedIn restricts accounts for READ velocity alone — they are ' +
      "guesses, not measured safe limits, and they cannot see the user's own browser activity.",
    {},
    async () => reply(runBudget(Date.now(), false, false)),
  );

  server.tool(
    'doctor',
    'Diagnose setup end to end: session, cooldown, budget, engine readiness. Free with offline. ' +
      'Run this first when anything behaves oddly. Never reveals credential values.',
    { offline: z.boolean().optional().describe('skip live checks (default true)') },
    async ({ offline }) => reply(runDoctor(Date.now(), offline ?? true)),
  );

  server.tool(
    'whoami',
    'The authenticated LinkedIn member: name, headline, public id, urn. Cheap (1 call). Good ' +
      `first call to confirm the session works and which account it is. ${NO_RETRY}`,
    {},
    async () => reply(await runWhoami()),
  );

  server.tool(
    'search',
    'Search LinkedIn posts, companies, groups, events, courses, products, services or schools ' +
      '(people and jobs have their own tools, `people` and `jobs`). 1 search call per 50 results ' +
      '(posts: per 20; a posts call is heavy, ask for the depth you need). Rows: id, name, ' +
      'subtitle, detail, summary, url — what subtitle and detail hold depends on the kind ' +
      '(companies: industry • HQ, followers; groups: members; events: when, where • organiser; ' +
      'courses: length, instructor • released; schools: place, alumni; services: the provider). ' +
      'Posts rows: id (the post urn, which `post` takes), url, author, authorHeadline, authorUrl, ' +
      "posted (as LinkedIn shows it, in the user's language), text, reactions, comments, reposts. " +
      'Several keyword sets as a list are searched and merged by id, with `matched`. Filter ' +
      'options and their ids for each kind come from `search_filters`. LinkedIn pages at most ' +
      `1000 results per query; \`meta.servedLimit\` means it claimed more. ${READING_CONTRACT} ${NO_RETRY}`,
    {
      kind: z.enum([
        'posts',
        'companies',
        'groups',
        'events',
        'courses',
        'products',
        'services',
        'schools',
      ]),
      keywords: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      location: z.string().optional().describe('companies (HQ) and services: a place by name'),
      industry: z.array(z.string()).optional().describe('companies: industry ids'),
      network: z
        .array(z.enum(['1st', '2nd', '3rd+']))
        .optional()
        .describe('companies, services'),
      filter: z
        .array(z.string())
        .optional()
        .describe('raw key=v1,v2 by the names search_filters lists'),
      sort: z.enum(['recent', 'relevant']).optional().describe('posts'),
      posted: z.enum(['24h', 'week', 'month']).optional().describe('posts'),
      type: z
        .array(z.enum(['videos', 'images', 'jobs', 'live', 'articles', 'documents']))
        .optional()
        .describe('posts'),
      postedBy: z
        .array(z.enum(['1st', 'me']))
        .optional()
        .describe('posts'),
      from: z.array(z.string()).optional().describe('posts by these people (profile ids)'),
      mentions: z
        .array(z.string())
        .optional()
        .describe('posts mentioning these people (profile ids)'),
      fromCompany: z
        .array(z.string())
        .optional()
        .describe('posts by these companies (names or ids)'),
      mentionsCompany: z.array(z.string()).optional().describe('posts mentioning these companies'),
      authorCompany: z.array(z.string()).optional().describe('posts by people at these companies'),
      authorIndustry: z
        .array(z.string())
        .optional()
        .describe('posts by people in these industries'),
      authorTitle: z.string().optional().describe('posts by people with this job title'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('per keyword set; default 25 (posts 20)'),
      start: z.number().int().min(0).optional(),
      compact: z.boolean().optional().describe('one line per result'),
    },
    async ({
      kind,
      keywords,
      location,
      industry,
      network,
      filter,
      limit,
      start,
      compact,
      ...posts
    }) => {
      const opts = compact === true ? { compact: true } : {};
      const common = {
        ...(keywords !== undefined ? { keywords } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(filter !== undefined ? { raw: filter } : {}),
      };
      if (kind === 'posts')
        return reply(await runPostsSearch({ ...common, ...posts, limit: limit ?? 20 }, opts));
      return reply(
        await runFind(
          kind,
          {
            ...common,
            limit: limit ?? 25,
            ...(location !== undefined ? { location } : {}),
            ...(industry !== undefined ? { industry } : {}),
            ...(network !== undefined ? { network } : {}),
          },
          opts,
        ),
      );
    },
  );

  server.tool(
    'search_filters',
    "Every filter a search kind has for a query, with each option's id and live count: the " +
      'values `search` takes as raw `filter` (key=value by the listed key), or `industry`, … ' +
      `1 search call. ${NO_RETRY}`,
    {
      kind: z.enum(['companies', 'groups', 'events', 'courses', 'products', 'services', 'schools']),
      keywords: z.string().optional(),
      location: z.string().optional(),
    },
    async ({ kind, keywords, location }) =>
      reply(
        await runFindFilters(kind, {
          ...(keywords !== undefined ? { keywords } : {}),
          ...(location !== undefined ? { location } : {}),
        }),
      ),
  );

  const peopleQuery = {
    keywords: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('search terms; a list runs one search per entry and merges them by person'),
    company: z.array(z.string()).optional().describe('current company: names or ids'),
    pastCompany: z.array(z.string()).optional().describe('past company: names or ids'),
    school: z.array(z.string()).optional().describe('school: names or ids'),
    location: z.string().optional().describe('a place by name, looked up to its geo id'),
    geo: z.array(z.string()).optional().describe('geo ids, from people_filters'),
    network: z.array(z.enum(['1st', '2nd', '3rd+'])).optional(),
    industry: z.array(z.string()).optional().describe('industry ids, from people_filters'),
    language: z.array(z.string()).optional().describe('profile language codes: en, de, …'),
    service: z.array(z.string()).optional().describe('service category ids'),
    connectionOf: z.string().optional().describe("a profile id: that person's connections"),
    followerOf: z.string().optional().describe("a profile id: that person's followers"),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    title: z.string().optional().describe('free text matched against current title'),
    companyText: z.string().optional().describe('free text matched against company names'),
    schoolText: z.string().optional().describe('free text matched against school names'),
    openToVolunteer: z.boolean().optional(),
    filter: z
      .array(z.string())
      .optional()
      .describe('raw key=v1,v2 by the parameter names people_filters lists'),
  };
  type PeopleArgs = { [K in keyof typeof peopleQuery]?: z.infer<(typeof peopleQuery)[K]> };
  const peopleRequest = (a: PeopleArgs, limit: number): PeopleRequest => {
    const { keywords, location, filter, ...rest } = a;
    return {
      limit,
      ...(keywords !== undefined ? { keywords } : {}),
      ...(location !== undefined ? { location } : {}),
      filter: { ...rest, ...(filter !== undefined ? { raw: filter } : {}) },
    };
  };

  server.tool(
    'people',
    'Search LinkedIn people with every filter the people search has. 1 search call per 50 ' +
      'people, plus 1 per company, school or place given by name. Filter by current or past ' +
      'company, school, place, connection degree, industry, title, profile language, or the ' +
      "connections / followers of a person (their profile id, a row's `id`). Names are looked " +
      'up to ids and `data.resolved` says what each became: CHECK IT, a name can match a ' +
      'different organisation. Rows: id, name, headline, location, degree, verified, insight ' +
      '(mutual connections, services), url. Several keyword sets as a list are searched and ' +
      'merged by person, with `matched`. Out-of-network people come back as "LinkedIn Member" ' +
      'with no url: LinkedIn will not name them to this account. LinkedIn pages at most 1000 ' +
      'people per query; `meta.servedLimit` means it claimed more, so narrow with filters. ' +
      `\`meta.next\` is the start for the next page. ${READING_CONTRACT} ${NO_RETRY}`,
    {
      ...peopleQuery,
      limit: z.number().int().min(1).max(1000).optional().describe('per keyword set; default 25'),
      start: z.number().int().min(0).optional(),
      compact: z.boolean().optional().describe('one line per person'),
    },
    async ({ limit, start, compact, ...q }) =>
      reply(
        await runPeople(
          { ...peopleRequest(q, limit ?? 25), ...(start !== undefined ? { start } : {}) },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'people_filters',
    "Every people-search filter for a query, with each option's id and live count, and which " +
      'filters take free text. The ids go into `people` (geo, industry, service, company, …) ' +
      `or raw \`filter\` (key=value by the listed key). 1 search call. ${NO_RETRY}`,
    peopleQuery,
    async (q) => reply(await runPeopleFilters(peopleRequest(q, 25))),
  );

  const jobQuery = {
    keywords: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('search terms; a list runs one search per entry and merges them by job id'),
    location: z
      .string()
      .optional()
      .describe('a place, resolved by LinkedIn; check data.location for what it chose'),
    geoId: z.string().optional().describe('an exact geo id, in place of location'),
    distance: z.number().int().optional().describe('miles around the location'),
    posted: z.string().optional().describe('24h | week | month | <N>h | <N>d'),
    experience: z
      .array(z.enum(['internship', 'entry', 'associate', 'mid-senior', 'director', 'executive']))
      .optional(),
    type: z
      .array(
        z.enum([
          'full-time',
          'part-time',
          'contract',
          'temporary',
          'volunteer',
          'internship',
          'other',
        ]),
      )
      .optional(),
    workplace: z.array(z.enum(['on-site', 'remote', 'hybrid'])).optional(),
    easyApply: z.boolean().optional(),
    under10: z.boolean().optional().describe('fewer than 10 applicants'),
    verified: z.boolean().optional(),
    inNetwork: z.boolean().optional(),
    fairChance: z.boolean().optional(),
    company: z.array(z.string()).optional().describe('company ids, from job_filters'),
    industry: z.array(z.string()).optional().describe('industry ids, from job_filters'),
    function: z.array(z.string()).optional().describe('function codes, from job_filters'),
    title: z.array(z.string()).optional().describe('title ids, from job_filters'),
    place: z.array(z.string()).optional().describe('city geo ids, from job_filters'),
    filter: z
      .array(z.string())
      .optional()
      .describe('raw key=v1,v2 by the parameter names job_filters lists'),
    sort: z.enum(['recent', 'relevant']).optional(),
  };
  type JobArgs = { [K in keyof typeof jobQuery]?: z.infer<(typeof jobQuery)[K]> };
  const jobRequest = (a: JobArgs, limit: number): JobsRequest => {
    const { keywords, location, geoId, filter, ...rest } = a;
    return {
      limit,
      ...(keywords !== undefined ? { keywords } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(geoId !== undefined ? { geoId } : {}),
      filter: { ...rest, ...(filter !== undefined ? { raw: filter } : {}) },
    };
  };

  server.tool(
    'jobs',
    'Search LinkedIn jobs with every filter the jobs page has. 1 job-search call per 100 results (150 a day). ' +
      'Rows carry id, title, company, location, workplace, listed (date), easyApply, promoted, ' +
      'salary when shown, url. RANK ON THOSE, then call `job` on finalists for the description ' +
      'and apply link; `details:true` reads every row in full, 100 per job read (60 a day). ' +
      'Pass several keyword sets as a list to search them all with the same filters in one ' +
      'call: jobs found by several come back once, with `matched` naming the sets that found ' +
      'them, most-matched first; `meta.searches` reports each set and `meta.duplicates` how ' +
      'many repeats were merged. ' +
      'Ids for company/industry/title/place/filter come from `job_filters`. `data.location` is ' +
      "the place a typed location resolved to: check it. `meta.claimedCount` is LinkedIn's total; " +
      '`meta.next` is the start for the next page; LinkedIn serves at most 1000 per search. ' +
      `${READING_CONTRACT} ${NO_RETRY}`,
    {
      ...jobQuery,
      limit: z.number().int().min(1).max(1000).optional().describe('per keyword set; default 25'),
      start: z.number().int().min(0).optional(),
      details: z.boolean().optional().describe('read each job: apply link, applicants'),
      description: z.boolean().optional().describe('with details, keep full descriptions'),
      compact: z.boolean().optional().describe('one line per job'),
    },
    async ({ limit, start, details, description, compact, ...q }) =>
      reply(
        await runJobs(
          {
            ...jobRequest(q, limit ?? 25),
            ...(start !== undefined ? { start } : {}),
            ...(details !== undefined ? { details } : {}),
            ...(description !== undefined ? { description } : {}),
          },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'job',
    'LinkedIn jobs by id or URL, in full: description, apply {type: external | easy-apply, url}, ' +
      'company, location, workplace, employmentType, applicants, listed/expires, state (LISTED or ' +
      'CLOSED), and whether the user already applied or saved it. One id returns the job; ' +
      'several return {items, meta}, read 100 per job read (60 a day), so pass all finalists in ' +
      `one call. meta.unread lists ids LinkedIn did not return. team: true adds hiringTeam ` +
      '[{name, id, url, headline, degree, role ("Job poster"), verified}] per job — who posted ' +
      'it and who is hiring — one page call (60 a day) per job; [] means LinkedIn shows no one, ' +
      `and hiringTeamError says why one could not be read. ${NO_RETRY}`,
    {
      job: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe('job id, /jobs/view/ URL or ?currentJobId= URL, or a list of them'),
      team: z.boolean().optional().describe("also read each job's hiring team"),
    },
    async ({ job, team }) => reply(await runJob(job, {}, undefined, { team: team === true })),
  );

  server.tool(
    'job_filters',
    "Every job-search filter for a query, with each option's id and live result count: the " +
      'values `jobs` takes for company, industry, function, title, place, and raw `filter` ' +
      `(key=value by the listed key). 1 job-search call. ${NO_RETRY}`,
    jobQuery,
    async (q) => reply(await runJobFilters(jobRequest(q, 25))),
  );

  server.tool(
    'profile',
    'Read one LinkedIn profile: headline, location, current title, company, school. MEDIUM cost — ' +
      'use only on finalists surfaced by `search`. Accepts a public id, a urn, or a ' +
      "linkedin.com/in/… URL. KNOWN LIMIT: LinkedIn's profile projections do not return a name, " +
      'so the result has a headline but no first/last name — use the identifier you passed in. ' +
      `Do NOT report the profile as empty on that basis. ${NO_RETRY}`,
    { id: z.string().min(1).describe('public id, urn, or profile URL') },
    async ({ id }) => reply(await runProfile(id)),
  );

  server.tool(
    'feed',
    "The user's own chronological LinkedIn feed: author, when, text, url. MEDIUM cost. Promoted " +
      'posts are dropped and counted in `meta.excludedCount`, so fewer items than `limit` usually ' +
      `means ads were filtered, not that the fetch failed. ${READING_CONTRACT} ${NO_RETRY}`,
    { limit: z.number().int().min(1).max(20).optional().describe('default 10') },
    async ({ limit }) => reply(await runFeed(limit ?? 10)),
  );

  server.tool(
    'post',
    "A LinkedIn post's comment thread. EXPENSIVE — read only finalists. Accepts a bare " +
      'urn:li:activity:…, a urn:li:ugcPost:…, or a linkedin.com/feed/update/… URL; no prior lookup ' +
      'is needed. Feed and search rows already report how many comments a post has, so use that to ' +
      'decide whether the thread is worth a call. `meta.state` is always "unknown" — this is the ' +
      'first page and pagination is not followed, so NEVER report a comment count as complete. ' +
      `Nested replies are not supported and a comment with replies does not carry them. ${READING_CONTRACT} ${NO_RETRY}`,
    {
      urn: z.string().min(1).describe('activity/ugcPost urn, or a feed-update URL'),
      limit: z.number().int().min(1).max(100).optional().describe('default 20'),
    },
    async ({ urn, limit }) => reply(await runPost(urn, limit ?? 20)),
  );

  server.tool(
    'reactions',
    'Who reacted to a LinkedIn post, and with which reaction. MEDIUM cost. Often more informative ' +
      'than the comments for mapping who is paying attention to a topic. Same input forms as ' +
      '`post`. `meta.state` is always "unknown" — first page only, so do not report a total. ' +
      `${READING_CONTRACT} ${NO_RETRY}`,
    {
      urn: z.string().min(1).describe('activity/ugcPost urn, or a feed-update URL'),
      limit: z.number().int().min(1).max(100).optional().describe('default 20'),
    },
    async ({ urn, limit }) => reply(await runReactions(urn, limit ?? 20)),
  );

  server.tool(
    'local',
    'Search the LOCAL cache. Free — no network call, no budget spent. PREFER THIS before any live ' +
      'command: if the answer is already cached, there is no reason to spend a request on it. The ' +
      'cache only fills when the user runs a live read with --retain, so an empty result here means ' +
      'nothing has been retained yet — NOT that LinkedIn has nothing. Check `meta.cachedTotal`.',
    {
      query: z.string().optional().describe('substring match; omit to list everything'),
      source: z.string().optional().describe('comma-separated: connections,my-posts,third-party'),
      since: z.string().optional().describe('YYYY-MM-DD'),
      limit: z.number().int().min(1).max(1000).optional().describe('per keyword set; default 25'),
    },
    async ({ query, source, since, limit }) => reply(runLocal(query, source, since, limit ?? 25)),
  );

  server.tool(
    'experience',
    "The roles on the user's own LinkedIn profile: positionId and title. LIVE — 2 calls. The " +
      'positionId is what `lnrelay role edit|remove` takes (CLI-only; changing a role is a write ' +
      `the user approves). ${NO_RETRY}`,
    {},
    async () => reply(await runExperience()),
  );

  server.tool(
    'skills',
    "The skills on the user's own LinkedIn profile: skillId and name. LIVE — about 3 calls. " +
      '`name` is null when it could not be matched to its row for certain. Adding or removing a ' +
      `skill is the CLI-only \`lnrelay skill\`, a write the user approves. ${NO_RETRY}`,
    {},
    async () => reply(await runSkills()),
  );

  server.tool(
    'my_items',
    "The user's My items. posts: posts they saved — id (the post urn, which `post` takes), url, " +
      'author, authorHeadline, posted, text. learning: their LinkedIn Learning courses — name, ' +
      'length, detail (instructor, released), progress, url. jobs: the job tracker — id (which ' +
      '`job` takes), title, company, location, workplace, stage, note ("No longer accepting ' +
      'applications"), url; with no stage, all five stages (5 page calls) and `meta.byStage`. ' +
      `1 page call per 10 items. ${NO_RETRY}`,
    {
      list: z.enum(['posts', 'learning', 'jobs']),
      stage: z.enum(['saved', 'in-progress', 'applied', 'interview', 'archived']).optional(),
      limit: z.number().int().min(1).max(500).optional().describe('default 50'),
      compact: z.boolean().optional(),
    },
    async ({ list, stage, limit, compact }) =>
      reply(
        await runMyItems(
          list,
          { limit: limit ?? 50, ...(stage !== undefined ? { stage } : {}) },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'events',
    "The events page's own lists: events LinkedIn recommends to the user, and its Premium " +
      "LinkedIn Live events. Rows: id, name, when (as shown, in the user's language), organizer, " +
      'attendees, premium, url. 1 page call. To find events by topic use `search` with kind ' +
      `events; to read one in full use \`event\`. ${NO_RETRY}`,
    {
      premium: z.boolean().optional().describe('only the Premium LinkedIn Live events'),
      limit: z.number().int().min(1).max(100).optional().describe('default 25'),
      compact: z.boolean().optional(),
    },
    async ({ premium, limit, compact }) =>
      reply(
        await runEvents(
          { limit: limit ?? 25, ...(premium === true ? { premium: true } : {}) },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'event',
    'Events in full, by id or URL: name, when (as shown), start/end (ISO), timeZone, state ' +
      '(FUTURE, ONGOING, PAST), cancelled, online, place (city, region, country), site (its own ' +
      'registration page), attendees, organizer {name, kind, url}, private, premium, you (the ' +
      "user's own response, when they gave one), description. 1 page call per event. " +
      NO_RETRY,
    {
      event: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe('event id or URL, or a list'),
    },
    async ({ event }) => reply(await runEvent(Array.isArray(event) ? event : [event])),
  );

  server.tool(
    'company',
    'A LinkedIn company page in full, by universal name, /company/ or /showcase/ URL, or id: ' +
      'id (what people/jobs company filters and search posts fromCompany take), name, about, ' +
      'website, industry, type, size (the band it chose), employeesOnLinkedIn, followers, ' +
      'headquarters, specialties, locations, affiliated and showcasePages [{id, name, url, ' +
      'followers}], jobsUrl. 1 page call per company; several return {items, meta}, with ' +
      'meta.unread for any not found. posts: N adds its N newest posts (a posts search, on the ' +
      `search budget); postsError says why they could not be read. ${NO_RETRY}`,
    {
      company: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe('universal name (microsoft), company URL or id, or a list'),
      posts: z.number().int().min(1).max(50).optional().describe('also its newest N posts'),
      compact: z.boolean().optional().describe('one line per company (several) and per post'),
    },
    async ({ company, posts, compact }) =>
      reply(
        await runCompany(
          Array.isArray(company) ? company : [company],
          posts !== undefined ? { posts } : {},
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'network',
    "The user's own My Network. With no `list`: the count of connections, people they follow, " +
      'followers, pages, events, groups and invitations they sent (7 page calls). With a `list`: ' +
      'its rows — people as id, name, headline, location, degree, url; pages, events and groups ' +
      'as id, name, subtitle, detail, url; invitations as to, id, headline, sent, note, url. ' +
      '1 page call per 50 rows. Read only: no badge is cleared and nothing is marked seen. ' +
      `Received invitations and "people you may know" are not available. ${NO_RETRY}`,
    {
      list: z
        .enum(['connections', 'following', 'followers', 'pages', 'events', 'groups', 'invitations'])
        .optional(),
      limit: z.number().int().min(1).max(1000).optional().describe('default 50'),
      start: z.number().int().min(0).optional(),
      compact: z.boolean().optional(),
    },
    async ({ list, limit, start, compact }) =>
      reply(
        await runNetwork(
          list,
          { limit: limit ?? 50, ...(start !== undefined ? { start } : {}) },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'inbox',
    "The user's LinkedIn conversations in a folder, newest first: id, url, with (each person or " +
      'organisation: name, kind, headline, degree, url), unread, lastActivity, last message ' +
      '(from, fromMe, at, text, sponsored), folders, inmail. 1 page call per 20. READS ONLY: ' +
      'nothing is marked read or seen, and nothing is stored. These are private messages: quote ' +
      'them to the user, never elsewhere. `meta.unread` counts conversations with unread messages. ' +
      `Folders: inbox (default), primary, other, archive, requests, spam. ${NO_RETRY}`,
    {
      folder: z.enum(['inbox', 'primary', 'other', 'archive', 'requests', 'spam']).optional(),
      unread: z.boolean().optional().describe('only conversations with unread messages'),
      limit: z.number().int().min(1).max(500).optional().describe('default 20'),
      compact: z.boolean().optional(),
    },
    async ({ folder, unread, limit, compact }) =>
      reply(
        await runInbox(
          {
            folder: folder ?? 'inbox',
            limit: limit ?? 20,
            ...(unread === true ? { unread: true } : {}),
          },
          compact === true ? { compact: true } : {},
        ),
      ),
  );

  server.tool(
    'messages',
    "One conversation's latest messages, oldest first: from, fromMe, at, text, subject. 1 page " +
      'call. Reading does not mark it read. `meta.state` "partial" means a full page came back ' +
      `and older messages may exist; only the latest page is read. ${NO_RETRY}`,
    { conversation: z.string().min(1).describe('a conversation id from inbox, or its thread URL') },
    async ({ conversation }) => reply(await runMessages(conversation)),
  );

  server.tool(
    'draft',
    'Save a reply draft for a conversation ON THIS MACHINE, with its link, for the user to review ' +
      'and send themselves. NOTHING IS SENT — this tool cannot send messages, on any surface. Show ' +
      'the user the draft and the link. 1 page call, to check the conversation and who it is ' +
      'with. Pass `remove` with a draft id to delete a draft instead.',
    {
      conversation: z.string().optional().describe('a conversation id or thread URL'),
      text: z.string().optional().describe('the reply'),
      remove: z.string().optional().describe('a draft id to delete'),
    },
    async ({ conversation, text, remove }) =>
      reply(remove !== undefined ? runDraftRemove(remove) : await runDraft(conversation, text)),
  );

  server.tool(
    'drafts',
    'The reply drafts saved on this machine: id, to, text, the conversation link. Free, local.',
    {},
    async () => reply(runDrafts()),
  );

  server.tool(
    'scheduled',
    "The user's own posts waiting to publish, soonest first: urn, scheduledAt (ISO), text. LIVE " +
      '— about 1 call per 10 posts. These are NOT in `my_posts` until they go out. Links in `text` ' +
      'show as lnkd.in short links, as LinkedIn lists them. `text` is null when it could not be ' +
      "matched to its post for certain. `meta.claimedCount` is LinkedIn's own count; if " +
      `\`meta.state\` is not "complete", say the list may be short. ${NO_RETRY}`,
    {},
    async () => reply(await runScheduled()),
  );

  for (const source of ['connections', 'my-posts'] as const) {
    server.tool(
      source.replace('-', '_'),
      `The user's own ${source === 'connections' ? 'connections' : 'authored posts'}, read from the ` +
        'LOCAL cache. Free — no network call, no budget spent. An empty result means the cache has ' +
        `not been filled, NOT that the user has none: tell them to run \`lnrelay sync ${source}\` ` +
        'themselves (it is CLI-only). Check `meta.cachedTotal` to tell the two apart.',
      {
        query: z.string().optional().describe('substring match; omit to list everything'),
        limit: z.number().int().min(1).max(1000).optional().describe('per keyword set; default 25'),
      },
      async ({ query, limit }) => reply(runSourceRead(source, query, limit ?? 25)),
    );
  }

  server.tool(
    'cache_status',
    'What is cached per source, with sync checkpoints and the retention policy. Free, no network. ' +
      'Third-party records expire 30 days after capture — the body goes, an identity stub stays, so ' +
      'a re-fetch is a visible choice rather than a silent budget charge.',
    {},
    async () => reply(runCacheStatus()),
  );

  return server;
}

const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'linkedin-relay-mcp',
  'lnrelay',
]);

if (entry.run) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
