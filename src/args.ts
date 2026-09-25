// Minimal argv parsing. Pure — takes an argv array, returns a plain object.

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Every value a flag was given, in order — `flags` keeps only the last. */
  repeated: Record<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const keep = (key: string, value: string) => {
    flags[key] = value;
    const seen = repeated[key] ?? [];
    seen.push(value);
    repeated[key] = seen;
  };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;

    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      // A flag takes a value only when the next token isn't itself a flag.
      if (next !== undefined && !next.startsWith('--')) {
        keep(key, next);
        i++;
      } else {
        flags[key] = true;
      }
    } else if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        keep(key, next);
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags, repeated };
}

export function bool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

export function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function num(args: ParsedArgs, name: string): number | undefined {
  const v = str(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Every value given for a repeated flag, in order. Empty when absent or bare. */
export function list(args: ParsedArgs, name: string): string[] {
  return args.repeated[name] ?? [];
}
