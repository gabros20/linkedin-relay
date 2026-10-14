import { readFileSync } from 'node:fs';
import { bool, list, num, type ParsedArgs, parseArgs, str } from './args.ts';
import {
  auditOutcome,
  loadApprovalMode,
  runApprovalSet,
  runApprovalShow,
  wasApproved,
} from './commands/approval.ts';
import { runCacheStatus, runLocal, runPurge, runSourceRead } from './commands/cache.ts';
import type { ConfirmDeps } from './commands/confirm.ts';
import { runDelete } from './commands/delete.ts';
import { runEvent, runEvents } from './commands/events.ts';
import { terminalDeps } from './commands/gate.ts';
import { type JobsRequest, runJob, runJobFilters, runJobs } from './commands/jobs.ts';
import {
  type OutputOpts,
  runFeed,
  runLogin,
  runPost,
  runProfile,
  runReactions,
  runScheduled,
  runWhoami,
} from './commands/live.ts';
import { runBudget, runDoctor, runRisk } from './commands/local.ts';
import {
  draftText,
  runDraft,
  runDraftRemove,
  runDrafts,
  runInbox,
  runMessages,
} from './commands/messaging.ts';
import { runMyItems } from './commands/my-items.ts';
import { runNetwork } from './commands/network.ts';
import { runOauthLogin, runOauthLogout, runOauthStatus } from './commands/oauth.ts';
import { type PeopleRequest, runPeople, runPeopleFilters } from './commands/people.ts';
import { type PostsRequest, runPostsSearch } from './commands/posts-search.ts';
import { findCommand, helpText } from './commands/registry.ts';
import { type RoleRequest, runExperience, runRole } from './commands/role.ts';
import { type FindRequest, runFind, runFindFilters } from './commands/search-kinds.ts';
import { runSkill, runSkills } from './commands/skill.ts';
import { runSync } from './commands/sync.ts';
import {
  type MediaRequest,
  type PollRequest,
  runComment,
  runEdit,
  runReact,
  runReply,
  runShare,
} from './commands/write.ts';
import type { JobFilterOptions } from './engine/jobs.ts';
import type { Folder } from './engine/messaging.ts';
import type { Stage } from './engine/my-items.ts';
import type { PeopleFilterOptions } from './engine/people.ts';
import { SEARCH_KINDS, type SearchKindName } from './engine/search.ts';
import { shouldRunAsEntry } from './entry.ts';
import { err, exitCodeFor, toJson } from './output.ts';
import type { Envelope } from './types.ts';

/** The output flags every collection command accepts. */
function output(args: ParsedArgs): OutputOpts {
  const opts: OutputOpts = {};
  if (bool(args, 'raw')) opts.raw = true;
  if (bool(args, 'quiet')) opts.quiet = true;
  if (bool(args, 'retain')) opts.retain = true;
  if (bool(args, 'compact')) opts.compact = true;
  const fields = str(args, 'fields');
  if (fields !== undefined) opts.fields = fields;
  return opts;
}

/** A list flag, given comma-separated, repeated, or both. */
function many(args: ParsedArgs, name: string): string[] {
  return list(args, name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** `jobs` and `job-filters` flags. Pure, so the whole surface is testable. */
export function jobsRequest(args: ParsedArgs): JobsRequest {
  const filter: JobFilterOptions = {};
  const distance = num(args, 'distance');
  if (distance !== undefined) filter.distance = distance;
  const posted = str(args, 'posted');
  if (posted !== undefined) filter.posted = posted;
  const lists = [
    ['experience', 'experience'],
    ['type', 'type'],
    ['workplace', 'workplace'],
    ['company', 'company'],
    ['industry', 'industry'],
    ['function', 'function'],
    ['title', 'title'],
    ['place', 'place'],
  ] as const;
  for (const [flag, key] of lists) {
    const values = many(args, flag);
    if (values.length > 0) filter[key] = values;
  }
  const flags = [
    ['easy-apply', 'easyApply'],
    ['under-10', 'under10'],
    ['verified', 'verified'],
    ['in-network', 'inNetwork'],
    ['fair-chance', 'fairChance'],
  ] as const;
  for (const [flag, key] of flags) if (bool(args, flag)) filter[key] = true;
  const raw = list(args, 'filter');
  if (raw.length > 0) filter.raw = raw;
  const sort = str(args, 'sort');
  if (sort !== undefined) filter.sort = sort;

  const req: JobsRequest = { limit: num(args, 'limit') ?? 25, filter };
  // Every quoted argument is its own keyword set, searched and merged.
  if (args.positionals.length > 0) req.keywords = [...args.positionals];
  const location = str(args, 'location');
  if (location !== undefined) req.location = location;
  const geo = str(args, 'geo');
  if (geo !== undefined) req.geoId = geo;
  const start = num(args, 'start');
  if (start !== undefined) req.start = start;
  if (bool(args, 'details')) req.details = true;
  if (bool(args, 'description')) req.description = true;
  return req;
}

/**
 * A list of organisations: ids may be comma-separated, but a name keeps its
 * commas ("Ernst & Young, LLP"); repeat the flag for several names.
 */
function orgs(args: ParsedArgs, name: string): string[] {
  return list(args, name)
    .flatMap((v) => (/^[\d,\s]+$/.test(v) ? v.split(',') : [v]))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** `people` and `people-filters` flags. Pure, so the whole surface is testable. */
export function peopleRequest(args: ParsedArgs): PeopleRequest {
  const filter: PeopleFilterOptions = {};
  const network = many(args, 'network');
  if (network.length > 0) filter.network = network;
  for (const [flag, key] of [
    ['company', 'company'],
    ['past-company', 'pastCompany'],
    ['school', 'school'],
  ] as const) {
    const values = orgs(args, flag);
    if (values.length > 0) filter[key] = values;
  }
  for (const [flag, key] of [
    ['geo', 'geo'],
    ['industry', 'industry'],
    ['language', 'language'],
    ['service', 'service'],
  ] as const) {
    const values = many(args, flag);
    if (values.length > 0) filter[key] = values;
  }
  for (const [flag, key] of [
    ['connection-of', 'connectionOf'],
    ['follower-of', 'followerOf'],
    ['first-name', 'firstName'],
    ['last-name', 'lastName'],
    ['title', 'title'],
    ['company-text', 'companyText'],
    ['school-text', 'schoolText'],
  ] as const) {
    const value = str(args, flag);
    if (value !== undefined) filter[key] = value;
  }
  if (bool(args, 'open-to-volunteer')) filter.openToVolunteer = true;
  const raw = list(args, 'filter');
  if (raw.length > 0) filter.raw = raw;

  const req: PeopleRequest = { limit: num(args, 'limit') ?? 25, filter };
  if (args.positionals.length > 0) req.keywords = [...args.positionals];
  const location = str(args, 'location');
  if (location !== undefined) req.location = location;
  const start = num(args, 'start');
  if (start !== undefined) req.start = start;
  return req;
}

/** The kinds `search` and `search-filters` take. */
const KINDS = ['people', 'jobs', 'posts', ...Object.keys(SEARCH_KINDS)];

/** The arguments with the kind taken off, so keyword sets are what is left. */
const afterKind = (args: ParsedArgs): ParsedArgs => ({
  ...args,
  positionals: args.positionals.slice(1),
});

/** `search <kind>` flags for companies, groups, events, courses, products, services, schools. */
export function findRequest(args: ParsedArgs): FindRequest {
  const req: FindRequest = { limit: num(args, 'limit') ?? 25 };
  const keywords = args.positionals.slice(1);
  if (keywords.length > 0) req.keywords = keywords;
  const location = str(args, 'location');
  if (location !== undefined) req.location = location;
  const industry = many(args, 'industry');
  if (industry.length > 0) req.industry = industry;
  const network = many(args, 'network');
  if (network.length > 0) req.network = network;
  const raw = list(args, 'filter');
  if (raw.length > 0) req.raw = raw;
  const start = num(args, 'start');
  if (start !== undefined) req.start = start;
  return req;
}

/** `search posts` flags. */
export function postsRequest(args: ParsedArgs): PostsRequest {
  const req: PostsRequest = { limit: num(args, 'limit') ?? 20 };
  const keywords = args.positionals.slice(1);
  if (keywords.length > 0) req.keywords = keywords;
  for (const [flag, key] of [
    ['sort', 'sort'],
    ['posted', 'posted'],
    ['author-title', 'authorTitle'],
  ] as const) {
    const v = str(args, flag);
    if (v !== undefined) req[key] = v;
  }
  for (const [flag, key] of [
    ['type', 'type'],
    ['posted-by', 'postedBy'],
    ['from', 'from'],
    ['mentions', 'mentions'],
    ['author-industry', 'authorIndustry'],
  ] as const) {
    const v = many(args, flag);
    if (v.length > 0) req[key] = v;
  }
  for (const [flag, key] of [
    ['from-company', 'fromCompany'],
    ['mentions-company', 'mentionsCompany'],
    ['author-company', 'authorCompany'],
  ] as const) {
    const v = orgs(args, flag);
    if (v.length > 0) req[key] = v;
  }
  const raw = list(args, 'filter');
  if (raw.length > 0) req.raw = raw;
  const start = num(args, 'start');
  if (start !== undefined) req.start = start;
  return req;
}

/** `search <kind>` and `search-filters <kind>`: each kind to its own implementation. */
function search(args: ParsedArgs, filtersOnly: boolean): Promise<Envelope> | Envelope {
  const command = filtersOnly ? 'search-filters' : 'search';
  const kind = args.positionals[0];
  if (kind === undefined || !KINDS.includes(kind)) {
    return err(
      command,
      'INVALID_INPUT',
      `unknown search kind '${kind ?? ''}'`,
      `one of: ${KINDS.join(', ')} — e.g. lnrelay ${command} companies "<keywords>"`,
    );
  }
  const opts = output(args);
  if (kind === 'people')
    return filtersOnly
      ? runPeopleFilters(peopleRequest(afterKind(args)), opts)
      : runPeople(peopleRequest(afterKind(args)), opts);
  if (kind === 'jobs')
    return filtersOnly
      ? runJobFilters(jobsRequest(afterKind(args)), opts)
      : runJobs(jobsRequest(afterKind(args)), opts);
  if (kind === 'posts') {
    if (filtersOnly)
      return err(
        command,
        'INVALID_INPUT',
        'posts filters are fixed: see `lnrelay help search`',
        'sort, posted, type, posted-by, from, mentions, from-company, mentions-company, author-company, author-industry, author-title',
      );
    return runPostsSearch(postsRequest(args), opts);
  }
  return filtersOnly
    ? runFindFilters(kind as SearchKindName, findRequest(args), opts)
    : runFind(kind as SearchKindName, findRequest(args), opts);
}

/** `events`, `event`, `my-items`, `network`: the events page, events in full, the owner's items and network. */
function mine(command: string, args: ParsedArgs): Promise<Envelope> {
  if (command === 'events')
    return runEvents(
      { limit: num(args, 'limit') ?? 25, ...(bool(args, 'premium') ? { premium: true } : {}) },
      output(args),
    );
  if (command === 'event') return runEvent(args.positionals, output(args));
  if (command === 'my-items') {
    const stage = str(args, 'stage');
    return runMyItems(
      args.positionals[0],
      {
        limit: num(args, 'limit') ?? 50,
        ...(stage !== undefined ? { stage: stage as Stage } : {}),
      },
      output(args),
    );
  }
  const start = num(args, 'start');
  return runNetwork(
    args.positionals[0],
    { limit: num(args, 'limit') ?? 50, ...(start !== undefined ? { start } : {}) },
    output(args),
  );
}

/** `inbox`, `messages`, `draft`, `drafts`: reading messages and drafting replies, never sending. */
function messaging(command: string, args: ParsedArgs): Promise<Envelope> | Envelope {
  if (command === 'inbox')
    return runInbox(
      {
        folder: (str(args, 'folder') ?? 'inbox') as Folder,
        limit: num(args, 'limit') ?? 20,
        ...(bool(args, 'unread') ? { unread: true } : {}),
      },
      output(args),
    );
  if (command === 'messages') return runMessages(args.positionals[0], output(args));
  if (command === 'drafts') return runDrafts(output(args));
  if (args.positionals[0] === 'remove') return runDraftRemove(args.positionals[1]);
  return runDraft(
    args.positionals[0],
    draftText(args.positionals[1], str(args, 'file')),
    undefined,
    output(args),
  );
}

/**
 * Which surface a write goes over.
 *
 * A misspelled `--via` is REFUSED rather than ignored. Ignoring it would mean
 * `--via voyger` silently posts over whichever transport happened to be the
 * default — the user asked for a specific surface and would be given another.
 */
function via(args: ParsedArgs): 'oauth' | 'voyager' | 'invalid' | undefined {
  const value = str(args, 'via');
  if (value === undefined) return undefined;
  return value === 'oauth' || value === 'voyager' ? value : 'invalid';
}

/** `oauth` carries subcommands; bare `oauth` reports status and writes nothing. */
async function oauth(args: ParsedArgs): Promise<Envelope> {
  const sub = args.positionals[0] ?? 'status';
  if (sub === 'status') return runOauthStatus();
  if (sub === 'logout') return runOauthLogout();
  if (sub === 'login') {
    const opts: { clientId?: string; clientSecret?: string } = {};
    const id = str(args, 'client-id');
    const secret = str(args, 'client-secret');
    if (id !== undefined) opts.clientId = id;
    if (secret !== undefined) opts.clientSecret = secret;
    return runOauthLogin(opts);
  }
  return err(
    'oauth',
    'INVALID_INPUT',
    `unknown oauth subcommand '${sub}'`,
    'one of: login, status, logout',
  );
}

export async function dispatch(argv: string[], now: number): Promise<Envelope> {
  const args = parseArgs(argv);
  const { command } = args;

  if (command === undefined || command === 'help' || command === '--help') {
    process.stderr.write(`${helpText()}\n`);
    return { ok: true, command: 'help', data: { commands: helpText() } };
  }

  const def = findCommand(command);
  if (def === undefined) {
    return err(
      command,
      'UNKNOWN_COMMAND',
      `unknown command '${command}'`,
      'run `lnrelay help` to list commands',
    );
  }

  if (!def.implemented) {
    return err(
      command,
      'NOT_IMPLEMENTED',
      `'${command}' is specified but not yet built`,
      `Usage when it lands: ${def.usage.split('\n')[0]}. See docs/PLAN.md for the phase it belongs to.`,
    );
  }

  if (def.risk === 'write') return write(command, args, now);

  switch (command) {
    case 'approval':
      return args.positionals[0] === 'set'
        ? runApprovalSet(args.positionals[1], terminalDeps())
        : runApprovalShow();
    case 'doctor':
      return runDoctor(now, bool(args, 'offline'));
    case 'budget':
      return runBudget(now, bool(args, 'reset-cooldown'), bool(args, 'confirm'));
    case 'risk':
      return runRisk(now);
    case 'local':
      return runLocal(
        args.positionals[0],
        str(args, 'source'),
        str(args, 'since'),
        num(args, 'limit') ?? 25,
        output(args),
      );
    case 'purge':
      return runPurge(
        str(args, 'scope') ?? (bool(args, 'all') ? 'all' : undefined),
        bool(args, 'confirm'),
      );
    case 'cache-status':
      return runCacheStatus();
    case 'connections':
      return runSourceRead(
        'connections',
        args.positionals[0] ?? str(args, 'q'),
        num(args, 'limit') ?? 25,
        output(args),
      );
    case 'my-posts':
      return runSourceRead(
        'my-posts',
        args.positionals[0] ?? str(args, 'q'),
        num(args, 'limit') ?? 25,
        output(args),
      );
    case 'experience':
      return runExperience(bool(args, 'quiet'));
    case 'skills':
      return runSkills(bool(args, 'quiet'));
    case 'scheduled':
      return runScheduled(bool(args, 'quiet'));
    case 'sync':
      return runSync(args.positionals[0], num(args, 'limit') ?? 50, bool(args, 'force'), now);
    case 'login':
      return runLogin();
    case 'oauth':
      return oauth(args);
    case 'whoami':
      return runWhoami(bool(args, 'raw'));
    case 'profile':
      return runProfile(args.positionals[0], bool(args, 'raw'));
    case 'feed':
      return runFeed(num(args, 'limit') ?? 10, output(args));
    case 'post':
      return runPost(args.positionals[0], num(args, 'limit') ?? 20, output(args));
    case 'reactions':
      return runReactions(args.positionals[0], num(args, 'limit') ?? 20, output(args));
    case 'jobs':
      return runJobs(jobsRequest(args), output(args));
    case 'job':
      return runJob(args.positionals, output(args), undefined, { team: bool(args, 'team') });
    case 'job-filters':
      return runJobFilters(jobsRequest(args), output(args));
    case 'people':
      return runPeople(peopleRequest(args), output(args));
    case 'people-filters':
      return runPeopleFilters(peopleRequest(args), output(args));
    case 'events':
    case 'event':
    case 'my-items':
    case 'network':
      return mine(command, args);
    case 'inbox':
    case 'messages':
    case 'draft':
    case 'drafts':
      return messaging(command, args);
    case 'search':
      return search(args, false);
    case 'search-filters':
      return search(args, true);
    default:
      return err(command, 'NOT_IMPLEMENTED', `'${command}' has no runner wired`);
  }
}

const entry = shouldRunAsEntry(process.argv[1], import.meta.url, import.meta.main, [
  'lnrelay',
  'linkedin-relay-mcp',
]);

if (entry.run) {
  if (entry.warning !== undefined) process.stderr.write(`${entry.warning}\n`);
  // stdout carries ONLY a JSON envelope — including when something throws that
  // no runner anticipated. A stack trace on stdout would break every caller
  // that parses us, which is all of them.
  const envelope = await dispatch(process.argv.slice(2), Date.now()).catch((e: Error) =>
    err(
      process.argv[2] ?? 'unknown',
      'UNEXPECTED',
      e.message,
      'This is a bug in lnrelay, not a LinkedIn failure. The stack trace is on stderr.',
    ),
  );
  // stdout carries ONLY the JSON envelope. Help text and progress go to stderr.
  if (envelope.command !== 'help') process.stdout.write(`${toJson(envelope)}\n`);
  process.exit(exitCodeFor(envelope));
}

/**
 * Every write goes through here: it resolves how the write is approved (the
 * owner's mode, plus --plan / --confirm), runs it, and logs the outcome of
 * anything that was approved.
 */
async function write(command: string, args: ParsedArgs, now: number): Promise<Envelope> {
  if (args.flags.confirm === true) {
    return err(
      command,
      'INVALID_INPUT',
      '--confirm needs the token that --plan returned',
      `lnrelay ${command} … --plan, then the same command with --confirm <token>`,
    );
  }
  const mode = loadApprovalMode();
  if (!mode.ok) return err(command, 'CACHE_CORRUPT', mode.message, mode.hint);

  const deps: ConfirmDeps = {
    ...terminalDeps(),
    approval: { mode: mode.mode, token: str(args, 'confirm'), planOnly: bool(args, 'plan') },
  };
  const envelope = await runWrite(command, args, now, deps);
  if (wasApproved()) auditOutcome(command, mode.mode, envelope);
  return envelope;
}

/** `--file` carries text that does not fit a shell argument, like a multi-paragraph About. */
function edit(args: ParsedArgs, now: number, deps: ConfirmDeps): Promise<Envelope> | Envelope {
  const [target, inline] = args.positionals;
  if (args.flags.file === true) return err('edit', 'INVALID_INPUT', '--file needs a path');
  const file = str(args, 'file');
  if (file === undefined) return runEdit(target, inline, now, deps);
  if (inline !== undefined) {
    return err('edit', 'INVALID_INPUT', 'pass the new text inline or with --file, not both');
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf-8').replace(/\n$/, '');
  } catch {
    return err('edit', 'INVALID_INPUT', `cannot read ${file}`);
  }
  return runEdit(target, text, now, deps);
}

function role(args: ParsedArgs, now: number, deps: ConfirmDeps): Promise<Envelope> | Envelope {
  const [sub, target] = args.positionals;
  const valued = [
    'title',
    'company',
    'start',
    'end',
    'location',
    'description',
    'description-file',
  ];
  for (const flag of valued) {
    if (args.flags[flag] === true) return err('role', 'INVALID_INPUT', `--${flag} needs a value`);
  }
  const req: RoleRequest = {};
  for (const flag of ['title', 'company', 'start', 'end', 'location', 'description'] as const) {
    const v = str(args, flag);
    if (v !== undefined) req[flag] = v;
  }
  const file = str(args, 'description-file');
  if (file !== undefined) {
    if (req.description !== undefined) {
      return err('role', 'INVALID_INPUT', 'pass --description or --description-file, not both');
    }
    try {
      req.description = readFileSync(file, 'utf-8').replace(/\n$/, '');
    } catch {
      return err('role', 'INVALID_INPUT', `cannot read ${file}`);
    }
  }
  if (bool(args, 'current')) req.current = true;
  if (bool(args, 'notify')) req.notify = true;
  return runRole(sub, target, req, now, deps);
}

function runWrite(
  command: string,
  args: ParsedArgs,
  now: number,
  deps: ConfirmDeps,
): Promise<Envelope> | Envelope {
  const [first, second] = args.positionals;
  switch (command) {
    case 'share':
      return share(args, now, deps);
    case 'comment':
      return runComment(first, second, now, deps);
    case 'edit':
      return edit(args, now, deps);
    case 'reply':
      return runReply(first, second, now, deps);
    case 'react':
      return runReact(first, str(args, 'type') ?? 'LIKE', now, deps, bool(args, 'remove'));
    case 'delete':
      return runDelete(first, now, deps, bool(args, 'quiet'));
    case 'role':
      return role(args, now, deps);
    case 'skill':
      return runSkill(first, second, now, deps);
    default:
      return err(command, 'NOT_IMPLEMENTED', `'${command}' has no write runner`);
  }
}

/** `share` parses more flags than any other command; kept out of dispatch. */
function share(args: ParsedArgs, now: number, deps: ConfirmDeps): Promise<Envelope> | Envelope {
  const surface = via(args);
  if (surface === 'invalid') {
    return err(
      'share',
      'INVALID_INPUT',
      `unknown --via '${str(args, 'via') ?? ''}'`,
      'one of: oauth, voyager. Omit it to prefer OAuth and fall back to Voyager.',
    );
  }
  // A bare `--image` parses as `true`; ignoring it would publish the text
  // without the picture the user asked for. The same goes for every value flag.
  for (const flag of [
    'image',
    'video',
    'document',
    'alt',
    'title',
    'at',
    'poll',
    'option',
    'duration',
  ]) {
    if (args.flags[flag] === true) {
      return err('share', 'INVALID_INPUT', `--${flag} needs a value`);
    }
  }
  if (typeof args.flags['no-card'] === 'string') {
    return err(
      'share',
      'INVALID_INPUT',
      '--no-card takes no value',
      'put the text first: lnrelay share "<text>" --no-card',
    );
  }
  const kinds = (['image', 'video', 'document'] as const)
    .map((flag) => ({ flag, paths: list(args, flag) }))
    .filter((k) => k.paths.length > 0);
  if (kinds.length > 1) {
    return err(
      'share',
      'INVALID_INPUT',
      `a post carries ${kinds.map((k) => `${k.flag}s`).join(' or ')}, not both`,
      'pass --image <path> (repeatable), or a single --video <path>, or a single --document <path>',
    );
  }
  const alts = list(args, 'alt');
  const title = str(args, 'title');
  const chosen = kinds[0];
  let media: MediaRequest | undefined;
  if (chosen !== undefined) {
    media = { flag: chosen.flag, paths: chosen.paths, alts };
    if (title !== undefined) media.title = title;
  } else if (alts.length > 0 || title !== undefined) {
    return err(
      'share',
      'INVALID_INPUT',
      '--alt and --title describe an attached file, and none was given',
    );
  }
  const question = str(args, 'poll');
  const options = list(args, 'option');
  if (question === undefined && (options.length > 0 || str(args, 'duration') !== undefined)) {
    return err('share', 'INVALID_INPUT', '--option and --duration belong to a --poll "<question>"');
  }
  let poll: PollRequest | undefined;
  if (question !== undefined) {
    poll = { question, options };
    const duration = str(args, 'duration');
    if (duration !== undefined) poll.duration = duration;
  }
  return runShare(
    args.positionals[0],
    str(args, 'visibility') ?? 'public',
    now,
    deps,
    surface,
    media,
    str(args, 'at'),
    poll,
    { card: !bool(args, 'no-card') },
  );
}
