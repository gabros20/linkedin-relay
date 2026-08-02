// Runners for the commands that talk to LinkedIn. Thin: they resolve a
// session, call the engine, and shape the envelope. All the interesting
// behaviour lives in engine/.

import {
  type Collection,
  createEngine,
  type EngineResult,
  type SearchKind,
} from '../engine/index.ts';

import {
  LAUNCH_HINT,
  loadSession,
  mintSessionFromBrowser,
  saveSession,
} from '../engine/session.ts';
import {
  compactRows,
  project,
  type Shaped,
  shapeAll,
  shapeEntity,
  shapeProfile,
} from '../format.ts';
import { err, ok } from '../output.ts';
import type { Envelope } from '../types.ts';
import { retain } from './cache.ts';

function withSession(
  command: string,
  quiet = false,
): { engine: ReturnType<typeof createEngine> } | Envelope {
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
  return { engine: createEngine(loaded.session, undefined, quiet) };
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

export async function runFeed(limit: number, opts: OutputOpts = {}): Promise<Envelope> {
  const ctx = withSession('feed', opts.quiet === true);
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.feed(limit);
  if (!result.ok) return toEnvelope('feed', result);
  return ok('feed', collection(result.value, opts));
}

export async function runSearch(
  kind: string | undefined,
  query: string | undefined,
  limit: number,
  opts: OutputOpts = {},
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
  const ctx = withSession('search', opts.quiet === true);
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.search(kind as SearchKind, query, limit);
  if (!result.ok) return toEnvelope('search', result);
  return ok('search', { query, kind, ...collection(result.value, opts) });
}

export async function runPost(
  urn: string | undefined,
  limit: number,
  opts: OutputOpts = {},
): Promise<Envelope> {
  const postUrn = normalisePostUrn(urn);
  if (postUrn === undefined) {
    return err(
      'post',
      'INVALID_INPUT',
      'a post urn or feed URL is required',
      'lnrelay post <activity-urn|https://www.linkedin.com/feed/update/...>',
    );
  }
  const ctx = withSession('post', opts.quiet === true);
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.post(postUrn, limit);
  if (!result.ok) return toEnvelope('post', result);
  return ok('post', { urn: postUrn, ...collection(result.value, opts) });
}

export async function runReactions(
  urn: string | undefined,
  limit: number,
  opts: OutputOpts = {},
): Promise<Envelope> {
  const postUrn = normalisePostUrn(urn);
  if (postUrn === undefined) {
    return err('reactions', 'INVALID_INPUT', 'a post urn or feed URL is required');
  }
  const ctx = withSession('reactions', opts.quiet === true);
  if ('ok' in ctx) return ctx;

  const result = await ctx.engine.reactions(postUrn, limit);
  if (!result.ok) return toEnvelope('reactions', result);
  return ok('reactions', { urn: postUrn, ...collection(result.value, opts) });
}

// ─── shaping ──────────────────────────────────────────────────────────────────

/** Accept a bare urn or a feed permalink; both carry the post identity. */
function normalisePostUrn(input: string | undefined): string | undefined {
  if (input === undefined || input === '') return undefined;
  const found = input.match(/urn:li:(?:activity|ugcPost|share):\d+/);
  if (found !== null) return found[0];
  return /^\d+$/.test(input) ? `urn:li:activity:${input}` : undefined;
}

/** A URL, a public id, or a bare urn all reduce to the member identity. */
function normaliseMemberId(input: string): string {
  const fromUrl = input.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  const fromUrn = input.match(/urn:li:fsd?_(?:mini)?[Pp]rofile:([^,)]+)/);
  if (fromUrn?.[1] !== undefined) return fromUrn[1];
  return input;
}

/** How the caller wants the rows rendered. */
export interface OutputOpts {
  raw?: boolean;
  retain?: boolean;
  compact?: boolean;
  fields?: string;
  quiet?: boolean;
}

/**
 * Collections are shaped by default — raw Voyager entities are enormous and
 * wrap every string in a TextViewModel. `--raw` keeps the original node
 * alongside, for when a shape has drifted and you need to see what arrived;
 * `--compact` and `--fields` go the other way, for when a page of results is
 * about to land in an agent's context and only the ranking signal matters.
 */
function collection(result: Collection, opts: OutputOpts = {}): Record<string, unknown> {
  const { parsed, index } = result;
  const shaped = shapeAll(parsed.items, index);

  const meta: Record<string, unknown> = { ...parsed.meta };
  // Retention always stores the FULL shaped row, never the projected one — a
  // display choice must not silently narrow what gets cached.
  if (opts.retain === true) meta.retained = retain('third-party', shaped);

  if (opts.raw === true) {
    return {
      items: parsed.items.map((node, i) => ({ ...(shaped[i] as Shaped), raw: node })),
      meta,
    };
  }
  if (opts.compact === true) return { items: compactRows(shaped), meta };
  if (opts.fields !== undefined && opts.fields !== '') {
    return { items: project(shaped, opts.fields), meta };
  }
  return { items: shaped, meta };
}
