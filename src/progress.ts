// Progress reporting for long-running / multi-step commands.
//
// The hard invariant: stdout carries ONLY the final JSON envelope. Progress is
// human-facing chatter, so it goes to STDERR (never stdout) and is silenced by
// --quiet. The write sink is injectable purely so tests can capture it without
// spying on process.stderr.

export type ProgressReporter = (msg: string) => void;

/**
 * Build a progress reporter. When `quiet` is true it drops every message;
 * otherwise it writes `msg + '\n'` to stderr (or the injected `write` sink).
 */
export function progressReporter(
  quiet: boolean,
  write: (s: string) => void = (s) => {
    process.stderr.write(s);
  },
): ProgressReporter {
  return (msg: string) => {
    if (!quiet) write(`${msg}\n`);
  };
}
