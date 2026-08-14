import { bool, num, type ParsedArgs, parseArgs, str } from './args.ts';
import { runCacheStatus, runLocal, runPurge, runSourceRead } from './commands/cache.ts';
import { runDelete } from './commands/delete.ts';
import {
  type OutputOpts,
  runFeed,
  runLogin,
  runPost,
  runProfile,
  runReactions,
  runSearch,
  runWhoami,
} from './commands/live.ts';
import { runBudget, runDoctor, runRisk } from './commands/local.ts';
import { runOauthLogin, runOauthLogout, runOauthStatus } from './commands/oauth.ts';
import { findCommand, helpText } from './commands/registry.ts';
import { runSync } from './commands/sync.ts';
import { runComment, runEdit, runReact, runReply, runShare } from './commands/write.ts';
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

  switch (command) {
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
    case 'sync':
      return runSync(args.positionals[0], num(args, 'limit') ?? 50, bool(args, 'force'), now);
    case 'login':
      return runLogin();
    case 'oauth':
      return oauth(args);
    case 'share': {
      const surface = via(args);
      if (surface === 'invalid') {
        return err(
          'share',
          'INVALID_INPUT',
          `unknown --via '${str(args, 'via') ?? ''}'`,
          'one of: oauth, voyager. Omit it to prefer OAuth and fall back to Voyager.',
        );
      }
      return runShare(
        args.positionals[0],
        str(args, 'visibility') ?? 'public',
        now,
        undefined,
        surface,
      );
    }
    case 'comment':
      return runComment(args.positionals[0], args.positionals[1], now);
    case 'edit':
      return runEdit(args.positionals[0], args.positionals[1], now);
    case 'reply':
      return runReply(args.positionals[0], args.positionals[1], now);
    case 'react':
      return runReact(
        args.positionals[0],
        str(args, 'type') ?? 'LIKE',
        now,
        undefined,
        bool(args, 'remove'),
      );
    case 'delete':
      return runDelete(args.positionals[0], now, undefined, bool(args, 'quiet'));
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
    case 'search':
      return runSearch(
        args.positionals[0],
        args.positionals[1],
        num(args, 'limit') ?? 10,
        output(args),
      );
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
