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
    const source = [
      readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'live.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'cache.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'local.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf-8'),
      readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'write.ts'), 'utf-8'),
    ].join('\n');

    const missing = advertisedFlags()
      .filter(({ flag }) => !new RegExp(`['"\`]${flag}['"\`]`).test(source))
      .map(({ command, flag }) => `${command} --${flag}`);

    expect(missing).toEqual([]);
  });
});
