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

  // The other direction: a read the registry offers over MCP but the shim
  // forgot to register is a tool the skill promises and the agent cannot call.
  test('every MCP command in the registry is registered', () => {
    const tools = registeredTools().map((t) => t.replace(/_/g, '-'));
    expect(mcpCommands().filter((c) => c.implemented && !tools.includes(c.name))).toEqual([]);
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

  // `cache_status` is the MCP spelling of the `cache-status` command — MCP tool
  // names conventionally use underscores. Normalise before comparing.
  test('every registered tool is a command the registry knows', () => {
    const known = new Set(COMMANDS.map((c) => c.name));
    for (const name of registeredTools()) {
      expect(known.has(name.replace(/_/g, '-'))).toBe(true);
    }
  });

  test('every registered tool is one the registry marks implemented', () => {
    const built = new Set(COMMANDS.filter((c) => c.implemented).map((c) => c.name));
    for (const name of registeredTools()) {
      expect(built.has(name.replace(/_/g, '-'))).toBe(true);
    }
  });
});

// The generic search returns no job cards; jobs have their own tool. Offering
// `kind: jobs` here would hand an agent an empty list that looks like success.
describe('people and jobs are searched through their own tools, not `search`', () => {
  const tool = (name: string) =>
    (
      buildServer() as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema: { safeParse(v: unknown): { success: boolean } } }
        >;
      }
    )._registeredTools[name];

  test('search does not take people or jobs, which have their own tools', () => {
    const parses = (kind: string) =>
      tool('search')?.inputSchema.safeParse({ kind, keywords: 'x' }).success;
    expect(parses('jobs')).toBe(false);
    expect(parses('people')).toBe(false);
    for (const kind of [
      'posts',
      'companies',
      'groups',
      'events',
      'courses',
      'products',
      'services',
      'schools',
    ])
      expect(parses(kind)).toBe(true);
  });

  test('jobs takes several keyword sets', () => {
    expect(tool('jobs')?.inputSchema.safeParse({ keywords: ['a', 'b'] }).success).toBe(true);
  });
});
