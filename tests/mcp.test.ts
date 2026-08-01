import { describe, expect, test } from 'bun:test';
import { COMMANDS, mcpCommands } from '../src/commands/registry.ts';
import { buildServer } from '../src/mcp-shim.ts';

/** Tool names the shim actually registered, read back off the server. */
function registeredTools(): string[] {
  const server = buildServer();
  const internal = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(internal ?? {});
}

describe('the MCP surface is read-only by construction', () => {
  test('the server builds', () => {
    expect(() => buildServer()).not.toThrow();
  });

  // The load-bearing guarantee. An agent cannot post, comment, react, connect
  // or message through this server whatever arguments it composes, because
  // those tools were never registered.
  test('no write command is registered', () => {
    const writes = COMMANDS.filter((c) => c.risk === 'write').map((c) => c.name);
    const tools = registeredTools();
    for (const name of writes) {
      expect(tools).not.toContain(name);
    }
  });

  test('write commands really do exist — the assertion above is not vacuous', () => {
    expect(COMMANDS.filter((c) => c.risk === 'write').length).toBeGreaterThan(0);
  });

  test('the registry filter itself excludes writes', () => {
    for (const c of mcpCommands()) {
      expect(c.risk).not.toBe('write');
    }
  });

  test('purge is not exposed — deletion is not an agent affordance', () => {
    expect(registeredTools()).not.toContain('purge');
  });

  test('login is not exposed — minting credentials needs the human', () => {
    expect(registeredTools()).not.toContain('login');
  });
});

describe('the tools an agent gets', () => {
  test('registers the read and meta tools', () => {
    const tools = registeredTools();
    for (const name of ['risk', 'budget', 'doctor', 'whoami', 'search', 'profile', 'feed']) {
      expect(tools).toContain(name);
    }
  });

  test('every registered tool is a command the registry knows', () => {
    const known = new Set(COMMANDS.map((c) => c.name));
    for (const name of registeredTools()) {
      expect(known.has(name)).toBe(true);
    }
  });

  test('every registered tool is one the registry marks implemented', () => {
    const built = new Set(COMMANDS.filter((c) => c.implemented).map((c) => c.name));
    for (const name of registeredTools()) {
      expect(built.has(name)).toBe(true);
    }
  });
});
