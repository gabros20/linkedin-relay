// Single source of truth for command definitions. Drives CLI dispatch + help,
// the MCP tool surface, and the SKILL.md parity test.
//
// `audience` is load-bearing, not documentation: the MCP shim registers only
// commands marked `mcp`, so a write can never reach an agent by accident. The
// research half of this tool is the product; writes are a thin, human-gated
// layer that arrives last (docs/PLAN.md Phase 6).

export type Audience = 'cli' | 'mcp';
export type RiskClass = 'read' | 'local' | 'write';

export interface CommandDef {
  name: string;
  /** Funnel cost hint shown in help + skill. */
  cost: string;
  summary: string;
  usage: string;
  audience: Audience[];
  risk: RiskClass;
  /** false until the command is actually wired up. */
  implemented: boolean;
}

export const COMMANDS: CommandDef[] = [
  // ─── local / meta — no network, available today ────────────────────────────
  {
    name: 'doctor',
    cost: 'free with --offline',
    summary: 'Diagnose setup: entry point, cache dir, cookies, cooldown, budget.',
    usage: 'lnrelay doctor [--offline]',
    audience: ['cli', 'mcp'],
    risk: 'local',
    implemented: true,
  },
  {
    name: 'budget',
    cost: 'free',
    summary: "Spend ledger per class, with each cap's provenance. Reset a cooldown here.",
    usage: 'lnrelay budget [--reset-cooldown --confirm]',
    audience: ['cli', 'mcp'],
    risk: 'local',
    implemented: true,
  },
  {
    name: 'risk',
    cost: 'free',
    summary: 'Circuit-breaker state. Check this BEFORE spending budget on research.',
    usage: 'lnrelay risk',
    audience: ['cli', 'mcp'],
    risk: 'local',
    implemented: true,
  },

  // ─── session ───────────────────────────────────────────────────────────────
  {
    name: 'login',
    cost: 'free — local browser',
    summary: 'Mint a session from a logged-in Chrome via DevTools. Stores cookies owner-only.',
    usage:
      'lnrelay login\n' +
      '       Requires a Chrome started with remote debugging on port 9222 (see docs/PLAN.md).',
    audience: ['cli'],
    risk: 'local',
    implemented: true,
  },

  // ─── reads — verified live 2026-08-01 ─────────────────────────────────────
  {
    name: 'whoami',
    cost: '1 call',
    summary: 'The authenticated member: name, headline, URN.',
    usage: 'lnrelay whoami',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'profile',
    cost: '1 call (+1 per section)',
    summary: 'A member profile. Expensive sections are opt-in.',
    usage:
      'lnrelay profile <public-id|urn|url> [--raw]\n' +
      "       Returns headline, location, current title, company and school. LinkedIn's profile\n" +
      '       projections do not return a name — use the identifier you passed in.',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'search',
    cost: 'cheap — the net',
    summary: 'Search people, companies or jobs. Cast wide, then deep-read the finalists.',
    usage:
      'lnrelay search people|companies|jobs "<query>" [--limit N]   (jobs: see `jobs`)\n' +
      '       [--compact | --fields a,b,c] [--retain] [--raw]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'jobs',
    cost: '1 job-search call per 25 jobs; --details adds 1 job read per job',
    summary:
      'Job search with every filter the jobs page has. Cards carry id, title, company, place, ' +
      'workplace, listed date, Easy Apply. Read finalists with `job`.',
    usage:
      'lnrelay jobs "<keywords>" [--location "<place>" | --geo <id>] [--distance <miles>]\n' +
      '       [--posted 24h|week|month|<N>h|<N>d] [--experience internship,entry,associate,\n' +
      '       mid-senior,director,executive] [--type full-time,part-time,contract,temporary,\n' +
      '       volunteer,internship,other] [--workplace on-site,remote,hybrid] [--easy-apply]\n' +
      '       [--under-10] [--verified] [--in-network] [--fair-chance] [--company <ids>]\n' +
      '       [--industry <ids>] [--function <codes>] [--title <ids>] [--place <geo-ids>]\n' +
      '       [--filter key=v1,v2 ...] [--sort recent|relevant] [--limit N] [--start N]\n' +
      '       [--details [--description]] [--compact | --fields a,b,c]\n' +
      '       Ids for --company/--industry/--title/--place/--filter come from `job-filters`.\n' +
      '       The resolved place is in data.location: check it, "Vienna" may resolve narrow.',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'job',
    cost: '1 job read',
    summary: 'One job: description, apply link (external or Easy Apply), applicants, state.',
    usage: 'lnrelay job <id|job-url>',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'job-filters',
    cost: '1 job-search call',
    summary:
      'Every job filter for a query, with option ids and live counts: what `jobs --filter` and ' +
      '--company/--industry/--title/--place take.',
    usage: 'lnrelay job-filters "<keywords>" [--location "<place>" | --geo <id>] [jobs filters]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'post',
    cost: 'expensive — full read',
    summary: 'A post plus its comment thread, cursor-followed.',
    usage:
      'lnrelay post <activity-urn|url> [--limit N] [--compact | --fields a,b] [--retain]\n' +
      '       Check meta.returnedCount / claimedCount / state. claimedCount > 0 with\n' +
      '       returnedCount 0 is a FAILED FETCH, not an empty thread.',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'reactions',
    cost: 'medium',
    summary: 'Who reacted to a post, and with which reaction.',
    usage: 'lnrelay reactions <activity-urn|url> [--limit N] [--compact | --fields a,b]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'company',
    cost: 'medium',
    summary: 'A company page, optionally with a bounded sample of its updates.',
    usage: 'lnrelay company <universal-name|url> [--updates N]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: false,
  },
  {
    name: 'feed',
    cost: 'medium',
    summary: 'Your own chronological feed.',
    usage: 'lnrelay feed [--limit N] [--compact | --fields a,b,c] [--retain] [--raw]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },

  // ─── cache-backed — Phase 4 ────────────────────────────────────────────────
  {
    name: 'sync',
    cost: 'medium — 1-2 calls',
    summary: 'Pull your own posts or connections into the local cache for offline search.',
    usage: 'lnrelay sync my-posts|connections [--limit N] [--force]',
    audience: ['cli'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'connections',
    cost: 'free — local cache',
    summary: 'Your connections, from the local cache. Fill it with `sync connections`.',
    usage:
      'lnrelay connections [-q "<query>"] [--limit N] [--compact | --fields a,b]   # free; cache',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'my-posts',
    cost: 'free — local cache',
    summary: 'Your own authored posts, from the local cache. Fill it with `sync my-posts`.',
    usage:
      'lnrelay my-posts [-q "<query>"] [--limit N] [--compact | --fields a,b]      # free; cache',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'scheduled',
    cost: '1 call per 10 posts',
    summary: 'Your posts waiting to publish, with when. Not in `my-posts` until they go out.',
    usage:
      'lnrelay scheduled\n' +
      '       Each row: urn (cancel with `delete`, change with `edit`), scheduledAt, text. Links in\n' +
      '       the text show as lnkd.in short links, as LinkedIn lists them.',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'experience',
    cost: '2 calls',
    summary: 'The roles on your own profile, with the position id `role edit|remove` takes.',
    usage: 'lnrelay experience',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'skills',
    cost: '3 calls',
    summary: 'The skills on your own profile, with the skill id `skill remove` takes.',
    usage: 'lnrelay skills',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'local',
    cost: 'free — local cache',
    summary: 'Offline search across everything synced. The default research path after a sync.',
    usage:
      'lnrelay local "<query>" [--source connections,my-posts,third-party] [--since YYYY-MM-DD]\n' +
      '       [--limit N] [--compact | --fields a,b,c]',
    audience: ['cli', 'mcp'],
    risk: 'read',
    implemented: true,
  },
  {
    name: 'cache-status',
    cost: 'free — local cache',
    summary: 'What is cached, per source, with sync checkpoints and the retention policy.',
    usage: 'lnrelay cache-status',
    audience: ['cli', 'mcp'],
    risk: 'local',
    implemented: true,
  },
  {
    name: 'purge',
    cost: 'free',
    summary: 'Delete cached data. Never contacts LinkedIn.',
    usage: 'lnrelay purge [--all] --confirm     # default scope: third-party only',
    audience: ['cli'],
    risk: 'local',
    implemented: true,
  },

  // ─── writes — Phase 6, official OAuth only, never MCP ──────────────────────
  {
    name: 'oauth',
    cost: 'free',
    summary:
      "Obtain and inspect the write credential, over LinkedIn's own self-serve scope. " +
      'Never prints the token.',
    usage:
      'lnrelay oauth login --client-id <id> [--client-secret <secret>]\n' +
      '       lnrelay oauth status | logout\n' +
      '       The secret is prompted for if omitted; LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET also work.\n' +
      '       Needs an app you registered: see the hint printed when no token is stored.',
    audience: ['cli'],
    risk: 'local',
    implemented: true,
  },
  {
    name: 'approval',
    cost: 'free — local',
    summary:
      'Show or set how writes are approved: interactive (a human at a terminal), agent (the ' +
      'owner approves a --plan preview in chat), or unattended. Only a terminal can change it.',
    usage:
      'lnrelay approval [show]\n' +
      '       lnrelay approval set <interactive|agent|unattended>\n' +
      '       Setting needs an interactive terminal and a typed token. Every approval and outcome\n' +
      '       is appended to ~/.lnrelay/writes.jsonl.',
    audience: ['cli'],
    risk: 'local',
    implemented: true,
  },
  {
    name: 'share',
    cost: '1 call — write',
    summary:
      "Post to your own feed. Prefers LinkedIn's official OAuth scope, falls back to the " +
      'private API when no token exists — the prompt always names which.',
    usage:
      'lnrelay share "<text>" [--image <path> ... [--alt "<text>" ...] | --video <path>\n' +
      '       | --document <pdf> --title "<title>"] [--at "YYYY-MM-DD HH:MM"]\n' +
      '       [--poll "<question>" --option "<a>" --option "<b>" ... [--duration 1d|3d|1w|2w]]\n' +
      '       [--visibility public|connections] [--via oauth|voyager] [--no-card]\n' +
      '       [--plan | --confirm <token>]\n' +
      '       Approval follows `lnrelay approval`: --plan previews and returns a token without\n' +
      '       sending; --confirm <token> sends it in agent mode. In interactive mode it asks at a\n' +
      '       terminal. --image repeats for up to 20, --alt pairs with it by position (--alt ""\n' +
      '       skips one). --at schedules it (local time, or ISO 8601 with an offset; at least 10\n' +
      '       minutes out); LinkedIn publishes it then, and `lnrelay delete <urn>` cancels it.\n' +
      '       --poll takes 2-4 --option and cannot be scheduled yet. The first link in the text\n' +
      '       gets the preview card LinkedIn would show (one extra read, named in the preview);\n' +
      '       --no-card posts it as plain text. Files, documents, polls, cards and scheduling go\n' +
      '       over the private API only.',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'comment',
    cost: '1 call — write',
    summary:
      'Add a comment to a post. Harvests its binding tokens from the rendered page; no browser ' +
      'needed, but it costs one heavy read.',
    usage:
      'lnrelay comment <activity-urn> "<text>"\n' +
      '       Fetches the post page (~2.8 MB) to harvest a binding key and trackingId, and proves\n' +
      '       the key belongs to that post before asking. To change a comment, see `edit`.',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'delete',
    cost: '1 read + 1 write',
    summary:
      'Delete one of your own posts or comments. Reads a post back and shows its text first — ' +
      'this is the one action that cannot be undone.',
    usage:
      'lnrelay delete <activity-urn>     # a post; shows you its text before destroying it\n' +
      '       lnrelay delete <comment-urn>      # a comment; the server decides if you may',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'reply',
    cost: '1 read + 1 write',
    summary:
      'Reply to a comment, nested under it. Goes over Voyager — a different endpoint from ' +
      'commenting, with the parent named in threadUrn.',
    usage: 'lnrelay reply <comment-urn> "<text>"',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'edit',
    cost: '1 read + 1 write',
    summary:
      'Change the text of a comment or post you wrote, or your profile headline or About. Its ' +
      'own verb, so a comment urn can never be mistaken for something to comment ON.',
    usage:
      'lnrelay edit <comment-urn | share-urn | ugcPost-urn> "<text>"\n' +
      '       lnrelay edit headline|about ("<text>" | --file <path>)\n' +
      '       A post is edited by the urn it was created as (`share` prints it; `my-posts` lists\n' +
      '       it as shareUrn), not its activity urn. The whole text is replaced. A profile edit\n' +
      '       shows the current text beside the new one, sends every other profile field back as\n' +
      '       LinkedIn holds it, and reads the profile back to confirm. Headline max 220 characters.',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'role',
    cost: '3-4 reads + 1 write',
    summary:
      'Add, edit or remove a role in your Experience. Never rewrites your headline; notify network ' +
      'is off unless --notify.',
    usage:
      'lnrelay role add --title "<t>" --company "<c>" --start YYYY-MM [--end YYYY-MM | --current]\n' +
      '       [--location "<l>"] [--description "<d>" | --description-file <path>] [--notify]\n' +
      '       lnrelay role edit <position-id> [any of the flags above]\n' +
      '       lnrelay role remove <position-id>\n' +
      '       Position ids come from `lnrelay experience`. The preview shows the role as it is and\n' +
      '       as it will be; the result is read back from the profile. A role with media attached\n' +
      '       is refused. The company is free text (not linked to a company page).',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'skill',
    cost: '4-5 reads + 1 write',
    summary: 'Add a skill to your profile, or remove one.',
    usage:
      'lnrelay skill add "<name>"\n' +
      '       lnrelay skill remove <skill-id>\n' +
      '       Skill ids come from `lnrelay skills`. A skill is added as free text, linked to no role,\n' +
      '       school or project. Removing a skill removes its endorsements with it.',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'react',
    cost: '1 call — write',
    summary: "React to a post or comment, over LinkedIn's SDUI surface. Reversible with --remove.",
    usage:
      'lnrelay react <activity-urn | comment-urn> [--type LIKE|PRAISE|EMPATHY|INTEREST|APPRECIATION|ENTERTAINMENT]\n' +
      '       lnrelay react <urn> --remove          # take the reaction back',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
];

export const commandNames = COMMANDS.map((c) => c.name);

export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Commands the MCP shim may register. Writes are structurally excluded. */
export function mcpCommands(): CommandDef[] {
  return COMMANDS.filter((c) => c.audience.includes('mcp') && c.risk !== 'write');
}

export function helpText(): string {
  const lines = ['lnrelay — deep research over LinkedIn from your own account', '', 'Commands:'];
  const width = Math.max(...commandNames.map((n) => n.length));
  for (const c of COMMANDS) {
    const flag = c.implemented ? ' ' : '·'; // · = designed, not yet wired
    lines.push(`  ${flag} ${c.name.padEnd(width)}  ${c.summary}  [${c.cost}]`);
  }
  lines.push('', '  · = specified in docs/DESIGN.md, not yet implemented');
  lines.push('', 'Run `lnrelay <command> --help` for usage.');
  return lines.join('\n');
}
