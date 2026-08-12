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
      'lnrelay search people|companies|jobs "<query>" [--limit N]\n' +
      '       [--compact | --fields a,b,c] [--retain] [--raw]',
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
    name: 'job',
    cost: '1 call',
    summary: 'A job posting detail.',
    usage: 'lnrelay job <job-id|url>',
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
    name: 'share',
    cost: '1 call — write',
    summary:
      "Post to your own feed. Prefers LinkedIn's official OAuth scope, falls back to the " +
      'private API when no token exists — the prompt always names which.',
    usage:
      'lnrelay share "<text>" [--visibility public|connections] [--via oauth|voyager]\n' +
      '       Stops and asks at an interactive terminal. No TTY = no write, and no network call.',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'comment',
    cost: '1 call — write',
    summary: 'Comment on a post via the official OAuth scope.',
    usage: 'lnrelay comment <activity-urn> "<text>"',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'delete',
    cost: '1 read + 1 write',
    summary:
      'Delete one of your own posts. Reads it first and shows you its text — this is the one ' +
      'action that cannot be undone.',
    usage: 'lnrelay delete <urn:li:share:… | urn:li:activity:…>',
    audience: ['cli'],
    risk: 'write',
    implemented: true,
  },
  {
    name: 'react',
    cost: '1 call — write',
    summary: 'React to a post via the official OAuth scope. Reversible.',
    usage: 'lnrelay react <activity-urn> [--type LIKE|PRAISE|EMPATHY|INTEREST|APPRECIATION]',
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
