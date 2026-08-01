// ─── Main-module detection ────────────────────────────────────────────────
// Deciding whether an entry file was invoked directly (should run) vs merely
// imported (should stay silent). The naive `fileURLToPath(url) === argv[1]`
// check breaks under the npm bin symlink (…/bin/lnrelay → …/dist/cli.js): argv1
// is the symlink, the module url is the real file — unequal — so the CLI would
// silently exit 0. Resolving both through realpath fixes that. Pure + testable.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Decide whether the current module is the process entry point.
 * @param argv1 process.argv[1] — the invoked script path (may be a symlink).
 * @param moduleUrl import.meta.url of the entry module.
 * @param importMetaMain import.meta.main when the runtime provides it.
 */
export function isMainModule(
  argv1: string | undefined,
  moduleUrl: string,
  importMetaMain: boolean | undefined,
): boolean {
  // The runtime told us explicitly — trust it (Bun always sets this).
  if (importMetaMain === true) return true;
  if (importMetaMain === false) return false;

  if (argv1 === undefined) return false;

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    // realpath failed (path missing, permission, etc.) — fall back to a plain
    // string compare.
    return argv1 === modulePath;
  }
}

/**
 * Fail-loud heuristic: when isMainModule said "not entry" but argv1's basename
 * looks like one of our binaries, the user clearly invoked us and our detection
 * failed. Callers run anyway (after warning) rather than silently exiting.
 */
export function shouldForceEntry(argv1: string | undefined, binNames: string[]): boolean {
  if (argv1 === undefined) return false;
  return binNames.includes(basename(argv1));
}

export interface EntryDecision {
  /** Whether the entry file should run its main routine. */
  run: boolean;
  /** A stderr warning to print first, or undefined when detection was clean. */
  warning: string | undefined;
}

/**
 * Consolidated entry decision. Runs when detected as main. Otherwise, ONLY when
 * the runtime gave no definitive answer (import.meta.main === undefined) and the
 * basename looks like one of our binaries, force-runs with a fail-loud warning —
 * an explicit import.meta.main === false is authoritative and never overridden.
 * binNames[0] is used as the label in the warning (the user-facing bin name).
 */
export function shouldRunAsEntry(
  argv1: string | undefined,
  moduleUrl: string,
  importMetaMain: boolean | undefined,
  binNames: string[],
): EntryDecision {
  if (isMainModule(argv1, moduleUrl, importMetaMain)) {
    return { run: true, warning: undefined };
  }
  if (importMetaMain === undefined && shouldForceEntry(argv1, binNames)) {
    return {
      run: true,
      warning: `${binNames[0]}: entry detection failed — treating as main; report at github.com/gabros20/linkedin-relay/issues`,
    };
  }
  return { run: false, warning: undefined };
}
