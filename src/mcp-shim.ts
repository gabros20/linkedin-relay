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
import { type JobsRequest, runJob, runJobFilters, runJobs } from './commands/jobs.ts';
import {
  runFeed,
  runPost,
  runProfile,
  runReactions,
  runScheduled,
  runSearch,
  runWhoami,
} from './commands/live.ts';
import { runBudget, runDoctor, runRisk } from './commands/local.ts';
import { mcpCommands } from './commands/registry.ts';
import { runExperience } from './commands/role.ts';
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
    'Search LinkedIn people, companies or jobs. CHEAP — this is the net. Rows already carry name, ' +
      'headline, location and url, so RANK ON THOSE and deep-read only 2-3 finalists with ' +
      '`profile`. Calling profile on every result burns a day of budget in one request. ' +
      "`meta.claimedCount` is LinkedIn's total for the query (often millions), NOT how many you " +
      'got, and `meta.state` is always "unknown" because this is one page of many. Out-of-network ' +
      'people return as name "LinkedIn Member" with a /headless url — that is real LinkedIn ' +
      `behaviour for this account, not a failure. ${READING_CONTRACT} ${NO_RETRY}`,
    {
      kind: z.enum(['people', 'companies', 'jobs']),
      query: z.string().min(1).describe('search terms'),
      limit: z.number().int().min(1).max(25).optional().describe('default 10'),
    },
    async ({ kind, query, limit }) => reply(await runSearch(kind, query, limit ?? 10)),
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
      `one call. meta.unread lists ids LinkedIn did not return. ${NO_RETRY}`,
    {
      job: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe('job id, /jobs/view/ URL or ?currentJobId= URL, or a list of them'),
    },
    async ({ job }) => reply(await runJob(job)),
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
