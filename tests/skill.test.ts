import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, mcpCommands } from '../src/commands/registry.ts';
import { SKILL_MD } from '../src/generated/skill.ts';

const ON_DISK = readFileSync(
  join(import.meta.dir, '..', '.claude', 'skills', 'linkedin-relay', 'SKILL.md'),
  'utf-8',
);

describe('generated skill', () => {
  // The generated constant is what ships in the npm package; the markdown is
  // what a human edits. If they diverge, users get stale instructions.
  test('the baked constant matches the file on disk', () => {
    expect(SKILL_MD).toBe(ON_DISK);
  });

  test('carries frontmatter so the skill is discoverable', () => {
    expect(SKILL_MD.startsWith('---\nname: linkedin-relay\n')).toBe(true);
  });
});

// R5 records that the sibling projects keep registry and SKILL.md in agreement
// by process — someone remembers. On a tool where an agent inventing a flag has
// account consequences, that gap is worth ten lines of test.
describe('registry ↔ skill parity', () => {
  test('every MCP-exposed command is documented in the skill', () => {
    const undocumented = mcpCommands()
      .filter((c) => c.implemented)
      .filter((c) => !new RegExp(`\\b${c.name.replace(/-/g, '[-_]')}\\b`).test(SKILL_MD))
      .map((c) => c.name);
    expect(undocumented).toEqual([]);
  });

  // The reverse direction: the skill must not promise something that does not
  // exist, because the agent reads the skill and will confidently call it.
  test('the skill documents no command the registry lacks', () => {
    const documented = [...SKILL_MD.matchAll(/^### `([a-z-]+)`/gm)].map((m) => m[1]);
    const known = new Set(COMMANDS.map((c) => c.name));
    expect(documented.filter((name) => name !== undefined && !known.has(name))).toEqual([]);
  });

  test('the skill documents no command that is not yet built', () => {
    const documented = [...SKILL_MD.matchAll(/^### `([a-z-]+)`/gm)].map((m) => m[1]);
    const unbuilt = COMMANDS.filter((c) => !c.implemented).map((c) => c.name);
    expect(documented.filter((n) => n !== undefined && unbuilt.includes(n))).toEqual([]);
  });
});

// The skill is the agent's only briefing before it sees a response. These are
// the specific misreadings that would cause real harm.
describe('the skill teaches the load-bearing distinctions', () => {
  test('explains that an empty result differs from a failed fetch', () => {
    expect(SKILL_MD).toMatch(/failed fetch/i);
    expect(SKILL_MD).toMatch(/claimed/i);
  });

  test('tells the agent not to retry', () => {
    expect(SKILL_MD).toMatch(/do not (retry|loop)/i);
  });

  test('tells the agent to check the budget and stop', () => {
    expect(SKILL_MD).toMatch(/budget/i);
    expect(SKILL_MD).toMatch(/remaining/i);
  });

  test('explains that meta.state partial means incomplete, not small', () => {
    expect(SKILL_MD).toMatch(/partial/);
  });

  test('warns that unknown types mean the parser is behind LinkedIn', () => {
    expect(SKILL_MD).toMatch(/unknownTypes/);
  });

  test('states the ToS breach rather than claiming compliance', () => {
    expect(SKILL_MD).toMatch(/§8\.2/);
    expect(SKILL_MD).not.toMatch(/compliant with|fully compliant|ToS-safe/i);
  });

  test('tells the agent writes are unavailable and not to route around it', () => {
    expect(SKILL_MD).toMatch(/not on this surface|CLI-only/i);
  });
});

// The gap that let --compact and --fields drift: parity checked command NAMES
// but never the flags their usage strings advertise. A documented flag that
// does nothing is worse than an undocumented one — the user believes it worked.
describe('advertised flags actually exist', () => {
  /** Every `--flag` mentioned in any registry usage string. */
  function advertisedFlags(): { command: string; flag: string }[] {
    // Unimplemented commands cannot mislead: they refuse at runtime with
    // NOT_IMPLEMENTED and are marked in help, so their usage is a sketch of
    // what they WILL take rather than a promise about today.
    return COMMANDS.filter((c) => c.implemented).flatMap((c) =>
      [...c.usage.matchAll(/--([a-z][a-z-]*)/g)].map((m) => ({
        command: c.name,
        flag: m[1] as string,
      })),
    );
  }

  test('the audit finds flags at all — it is not vacuous', () => {
    expect(advertisedFlags().length).toBeGreaterThan(5);
  });

  test('every advertised flag is read somewhere in the source', () => {
    const missing = advertisedFlags()
      .filter(({ flag }) => !new RegExp(`['"\`]${flag}['"\`]`).test(runnerSource()))
      .map(({ command, flag }) => `${command} --${flag}`);

    expect(missing).toEqual([]);
  });
});

/** Every file that could parse a flag or print an instruction. */
function runnerSource(): string {
  const files = ['cli.ts', 'args.ts'].map((f) => join(import.meta.dir, '..', 'src', f));
  const commands = ['live', 'cache', 'local', 'sync', 'write', 'oauth', 'token', 'registry'].map(
    (f) => join(import.meta.dir, '..', 'src', 'commands', `${f}.ts`),
  );
  return [...files, ...commands].map((p) => readFileSync(p, 'utf-8')).join('\n');
}

// The flag audit above checks what the REGISTRY promises. It cannot see a hint
// string that tells the user to run something — which is exactly how `lnrelay
// oauth --client-id …` survived for a release pointing at a command that had
// never been written. Every invocation the tool prints must therefore resolve.
describe('printed instructions name real commands', () => {
  /** `lnrelay <word>` as it appears in any user-facing string in the source. */
  function invocations(): string[] {
    return [...runnerSource().matchAll(/lnrelay ([a-z][a-z-]*)/g)].map((m) => m[1] as string);
  }

  test('the audit finds invocations at all — it is not vacuous', () => {
    expect(invocations().length).toBeGreaterThan(5);
  });

  test('every command the tool tells you to run exists', () => {
    const known = new Set([...COMMANDS.map((c) => c.name), 'help']);
    expect([...new Set(invocations())].filter((name) => !known.has(name))).toEqual([]);
  });

  // `oauth` grew subcommands; a hint naming a subcommand that dispatch does not
  // handle fails the same way, one level down.
  test('every oauth subcommand the tool names is dispatched', () => {
    const cli = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf-8');
    const named = [...runnerSource().matchAll(/lnrelay oauth ([a-z]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const sub of new Set(named)) {
      expect(cli).toContain(`'${sub}'`);
    }
  });
});

// The skill tells an agent which write commands EXIST while refusing to expose
// them. That list drifted: `reply` and `edit` shipped and the skill still named
// four commands, so an agent would have told the user the wrong thing. The MCP
// parity test could not catch it, because writes are deliberately not MCP.
describe('the skill names every write command', () => {
  test('each CLI write command appears in the skill', () => {
    const writes = COMMANDS.filter((c) => c.risk === 'write' && c.implemented);
    const missing = writes
      .filter((c) => !SKILL_MD.includes(`lnrelay ${c.name}`))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });

  test('the audit is not vacuous — there are write commands to miss', () => {
    expect(COMMANDS.filter((c) => c.risk === 'write' && c.implemented).length).toBeGreaterThan(3);
  });

  // An agent that believes a withdrawn command works will tell the user to run
  // something that refuses.
  test('it does not advertise a command that is not implemented', () => {
    const unbuilt = COMMANDS.filter((c) => !c.implemented).map((c) => c.name);
    for (const name of unbuilt) {
      expect(SKILL_MD).not.toContain(`lnrelay ${name} `);
    }
  });
});
