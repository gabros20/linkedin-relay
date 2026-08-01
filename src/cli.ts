import { bool, num, parseArgs } from './args.ts';
import { runFeed, runLogin, runProfile, runSearch, runWhoami } from './commands/live.ts';
import { runBudget, runDoctor, runRisk } from './commands/local.ts';
import { findCommand, helpText } from './commands/registry.ts';
import { shouldRunAsEntry } from './entry.ts';
import { err, exitCodeFor, toJson } from './output.ts';
import type { Envelope } from './types.ts';

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
    case 'login':
      return runLogin();
    case 'whoami':
      return runWhoami(bool(args, 'raw'));
    case 'profile':
      return runProfile(args.positionals[0], bool(args, 'raw'));
    case 'feed':
      return runFeed(num(args, 'limit') ?? 10, bool(args, 'raw'));
    case 'search':
      return runSearch(
        args.positionals[0],
        args.positionals[1],
        num(args, 'limit') ?? 10,
        bool(args, 'raw'),
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
  const envelope = await dispatch(process.argv.slice(2), Date.now());
  // stdout carries ONLY the JSON envelope. Help text and progress go to stderr.
  if (envelope.command !== 'help') process.stdout.write(`${toJson(envelope)}\n`);
  process.exit(exitCodeFor(envelope));
}
