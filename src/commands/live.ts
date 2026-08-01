// Runners for the commands that talk to LinkedIn. Thin: they resolve a
// session, call the engine, and shape the envelope. All the interesting
// behaviour lives in engine/.

import { createEngine, type EngineResult, type SearchKind } from '../engine/index.ts';
import type { ParseResult } from '../engine/parse.ts';
import {
  LAUNCH_HINT,
  loadSession,
  mintSessionFromBrowser,
  saveSession,
} from '../engine/session.ts';
import { shapeAll, shapeEntity, shapeProfile } from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';

function withSession(command: string): { engine: ReturnType<typeof createEngine> } | Envelope {
  const loaded = loadSession();
  if (loaded.state === 'corrupt') {
    return err(
      command,
      'CACHE_CORRUPT',
      'the stored session was unreadable and has been quarantined',
      `Moved to ${loaded.quarantinedTo}. Re-run \`lnrelay login\`.`,
    );
  }
  if (loaded.state === 'missing') {
    return err(command, 'AUTH_FAILED', 'no session — run `lnrelay login` first', LAUNCH_HINT);
  }
  return { engine: createEngine(loaded.session) };
}

/** Turn an engine failure into an envelope without losing its hint. */
function toEnvelope(
  command: string,
  result: Extract<EngineResult<never>, { ok: false }>,
): Envelope {
  return err(command, result.code, result.message, result.hint, undefined, result.retryAfterMs);
}

export async function runLogin(): Promise<Envelope> {
  const minted = await mintSessionFromBrowser();
  if (!minted.ok) return err('login', 'AUTH_FAILED', minted.message, minted.hint);

  saveSession(minted.session);
  // Never echo a credential — presence and length only.
  return ok('login', {
    stored: true,
    liAtLength: minted.session.liAt.length,
    userAgent: minted.session.userAgent,
    capturedAt: minted.session.capturedAt,
    notice:
      'Session stored with owner-only permissions. This tool breaches LinkedIn User Agreement ' +
      '§8.2 and the account can be restricted or banned.',
  });
}

export async function runWhoami(raw = false): Promise<Envelope> {
  const ctx = withSession('whoami');
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.whoami();
  if (!result.ok) return toEnvelope('whoami', result);
  if (result.value === undefined) {
    return err(
      'whoami',
      'SCHEMA_DRIFT',
      'LinkedIn returned no member entity',
      're-capture the `me` contract',
    );
  }
  return ok(
    'whoami',
    raw ? { ...shapeEntity(result.value), raw: result.value } : shapeEntity(result.value),
  );
}

export async function runProfile(memberId: string | undefined, raw = false): Promise<Envelope> {
  if (memberId === undefined || memberId === '') {
    return err(
      'profile',
      'INVALID_INPUT',
      'a member id or urn is required',
      'lnrelay profile <public-id|urn>',
    );
  }
  const ctx = withSession('profile');
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.profile(normaliseMemberId(memberId));
  if (!result.ok) return toEnvelope('profile', result);
  if (result.value === undefined) {
    return err('profile', 'NOT_FOUND', `no profile for '${memberId}'`);
  }
  const shaped = shapeProfile(result.value.profile, result.value.index);
  return ok('profile', raw ? { ...shaped, raw: result.value.profile } : shaped);
}

export async function runFeed(limit: number, raw = false): Promise<Envelope> {
  const ctx = withSession('feed');
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.feed(limit);
  if (!result.ok) return toEnvelope('feed', result);
  return ok('feed', collection(result.value, raw));
}

export async function runSearch(
  kind: string | undefined,
  query: string | undefined,
  limit: number,
  raw = false,
): Promise<Envelope> {
  if (kind === undefined || !['people', 'companies', 'jobs'].includes(kind)) {
    return err(
      'search',
      'INVALID_INPUT',
      'kind must be people, companies or jobs',
      'lnrelay search people "<query>"',
    );
  }
  if (query === undefined || query === '') {
    return err('search', 'INVALID_INPUT', 'a query is required', 'lnrelay search people "<query>"');
  }
  const ctx = withSession('search');
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.search(kind as SearchKind, query, limit);
  if (!result.ok) return toEnvelope('search', result);
  return ok('search', { query, kind, ...collection(result.value, raw) });
}

// ─── shaping ──────────────────────────────────────────────────────────────────

/** A URL, a public id, or a bare urn all reduce to the member identity. */
function normaliseMemberId(input: string): string {
  const fromUrl = input.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  const fromUrn = input.match(/urn:li:fsd?_(?:mini)?[Pp]rofile:([^,)]+)/);
  if (fromUrn?.[1] !== undefined) return fromUrn[1];
  return input;
}

/**
 * Collections are shaped by default — raw Voyager entities are enormous and
 * wrap every string in a TextViewModel. `--raw` keeps the original node
 * alongside, for when a shape has drifted and you need to see what arrived.
 */
function collection(parsed: ParseResult, raw: boolean): Record<string, unknown> {
  const items = raw
    ? parsed.items.map((node) => ({ ...shapeEntity(node), raw: node }))
    : shapeAll(parsed.items);
  return { items, meta: parsed.meta };
}
