import { describe, expect, test } from 'bun:test';
import {
  COMMANDS,
  commandNames,
  findCommand,
  helpText,
  mcpCommands,
} from '../src/commands/registry.ts';

describe('registry integrity', () => {
  test('command names are unique', () => {
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });

  test('every command declares a usage line naming itself', () => {
    for (const c of COMMANDS) {
      expect(c.usage).toContain(`lnrelay ${c.name}`);
    }
  });

  test('every command has a non-empty summary and cost hint', () => {
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.cost.length).toBeGreaterThan(0);
    }
  });

  test('findCommand resolves a known name and rejects an unknown one', () => {
    expect(findCommand('doctor')?.name).toBe('doctor');
    expect(findCommand('definitely-not-a-command')).toBeUndefined();
  });
});

// The single most important structural guarantee in the tool: an agent talking
// over MCP cannot reach a write. Not "disabled", not "gated" — not registered.
describe('MCP surface excludes writes structurally', () => {
  test('no write command is exposed over MCP', () => {
    for (const c of mcpCommands()) {
      expect(c.risk).not.toBe('write');
    }
  });

  test('the write commands really do exist — the test above is not vacuous', () => {
    expect(COMMANDS.filter((c) => c.risk === 'write').length).toBeGreaterThan(0);
  });

  test('every write command is CLI-only in its declared audience', () => {
    for (const c of COMMANDS.filter((c) => c.risk === 'write')) {
      expect(c.audience).toEqual(['cli']);
    }
  });

  test('purge is CLI-only — deletion is not an agent affordance', () => {
    expect(findCommand('purge')?.audience).toEqual(['cli']);
  });
});

describe('help', () => {
  test('lists every command', () => {
    const help = helpText();
    for (const name of commandNames) {
      expect(help).toContain(name);
    }
  });

  test('marks unimplemented commands so help never overpromises', () => {
    expect(helpText()).toContain('not yet implemented');
  });
});
