// The Engine interface and its real construction. This is the seam: everything
// above it is pure and testable, everything below it talks to LinkedIn.

import { cachePath, loadJson, saveJson } from '../cache/store.ts';
import { progressReporter } from '../progress.ts';
import type { Session } from './auth.ts';
import { type Cooldown, emptyLedger, type Ledger } from './budget.ts';
import { type Client, type ClientDeps, createClient } from './client.ts';
import { contractFor } from './contracts.ts';
import {
  type Entity,
  indexIncluded,
  type ParseResult,
  parseCollection,
  parseSingle,
} from './parse.ts';
import { canonicalUrn, encodeVariables } from './restli.ts';

export interface Engine {
  whoami(): Promise<EngineResult<Entity | undefined>>;
  profile(memberId: string): Promise<EngineResult<ProfileResult | undefined>>;
  feed(limit: number): Promise<EngineResult<Collection>>;
  search(kind: SearchKind, query: string, limit: number): Promise<EngineResult<Collection>>;
  post(postUrn: string, limit: number): Promise<EngineResult<Collection>>;
  myPosts(profileUrn: string, limit: number): Promise<EngineResult<Collection>>;
  connections(limit: number): Promise<EngineResult<Collection>>;
  reactions(postUrn: string, limit: number): Promise<EngineResult<Collection>>;
}

export type SearchKind = 'people' | 'companies' | 'jobs';

/**
 * A profile plus the side-table it references. LinkedIn returns location,
 * current position and education as URN references into `included[]`, so the
 * caller needs the index to make sense of the profile node.
 */
/** A parsed collection plus the side-table its entities reference. */
export interface Collection {
  parsed: ParseResult;
  index: Map<string, Entity>;
}

export interface ProfileResult {
  profile: Entity;
  index: Map<string, Entity>;
}

export type EngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; hint?: string; retryAfterMs?: number };

const RESULT_TYPE: Record<SearchKind, string> = {
  people: 'PEOPLE',
  companies: 'COMPANIES',
  jobs: 'JOBS',
};

function missingContract(name: string): EngineResult<never> {
  return {
    ok: false,
    code: 'NOT_IMPLEMENTED',
    message: `no verified contract for '${name}'`,
    hint:
      'Only endpoints that returned 200 on this machine may back a command. ' +
      'Capture it with `bun run scripts/observe.ts`, verify it, then mark it verified in src/engine/contracts.ts.',
  };
}

/**
 * A live client on the real cache files. Exported because writes need a client
 * without needing an Engine — the write surface is not part of the read
 * contract, but it must share the same ledger, cooldown and pacing, and a
 * second construction of those would be a second breaker that agrees with the
 * first only by luck.
 */
export function createLiveClient(
  session: Session,
  deps?: Partial<ClientDeps>,
  quiet = false,
): Client {
  return createClient(session, {
    fetch: globalThis.fetch,
    // stdout stays JSON-only; progress is human chatter and goes to stderr.
    progress: progressReporter(quiet),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: () => Math.random(),
    loadLedger: () => {
      const r = loadJson<Ledger>(cachePath('budget.json'));
      return r.state === 'ok' ? r.value : emptyLedger();
    },
    saveLedger: (l) => saveJson(cachePath('budget.json'), l),
    loadCooldown: () => {
      const r = loadJson<Cooldown | null>(cachePath('cooldown.json'));
      return r.state === 'ok' ? r.value : null;
    },
    saveCooldown: (c) => saveJson(cachePath('cooldown.json'), c),
    ...deps,
  });
}

export function createEngine(session: Session, deps?: Partial<ClientDeps>, quiet = false): Engine {
  const client: Client = createLiveClient(session, deps, quiet);

  return {
    async whoami() {
      const contract = contractFor('me');
      if (contract === undefined) return missingContract('me');

      const res = await client.request({
        url: contract.path,
        spendClass: 'profile',
        operation: 'me',
      });
      if (!res.ok) return res;
      return { ok: true, value: parseSingle(res.json) };
    },

    async profile(memberId) {
      const contract = contractFor('profile');
      if (contract === undefined) return missingContract('profile');

      const variables = encodeVariables({ memberIdentity: memberId });
      const url = `${contract.path}?includeWebMetadata=true&variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'profile', operation: 'profile' });
      if (!res.ok) return res;

      const envelope = res.json as { included?: unknown };
      const index = indexIncluded(envelope.included);
      const profile = [...new Set(index.values())].find((n) =>
        String(n.$type ?? '').endsWith('profile.Profile'),
      );
      if (profile === undefined) return { ok: true, value: undefined };
      return { ok: true, value: { profile, index } };
    },

    async feed(limit) {
      const contract = contractFor('feed');
      if (contract === undefined) return missingContract('feed');

      const url = `${contract.path}?q=chronFeed&count=${limit}&start=0`;
      const res = await client.request({ url, spendClass: 'page', operation: 'feed' });
      if (!res.ok) return res;
      const envelope = res.json as { included?: unknown };
      return {
        ok: true,
        value: {
          parsed: parseCollection(res.json, {
            operation: 'feed',
            contractCapturedAt: contract.capturedAt,
          }),
          index: indexIncluded(envelope.included),
        },
      };
    },

    async myPosts(profileUrn, limit) {
      const contract = contractFor('myPosts');
      if (contract === undefined) return missingContract('myPosts');

      // `whoami` answers with an `fs_miniProfile` urn; this is a DASH endpoint
      // and wants `fsd_profile`. The legacy form returns 200 with an empty
      // result — no error, no warning — which is why this shipped as
      // "verified": the account had no posts when the contract was captured,
      // so empty was indistinguishable from working.
      const variables = encodeVariables({
        count: Math.min(limit, 100),
        start: 0,
        profileUrn: canonicalUrn(profileUrn),
      });
      const url = `${contract.path}?includeWebMetadata=true&variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'page', operation: 'myPosts' });
      if (!res.ok) return res;

      const envelope = res.json as { included?: unknown };
      return {
        ok: true,
        value: {
          parsed: parseCollection(res.json, {
            operation: 'myPosts',
            contractCapturedAt: contract.capturedAt,
            truncated: true,
          }),
          index: indexIncluded(envelope.included),
        },
      };
    },

    /**
     * Connections are a FILTERED PEOPLE SEARCH, not a list endpoint — LinkedIn
     * exposes no change stream for them. That is why the cache stores them as a
     * snapshot and diffs, rather than pretending a watermark exists.
     */
    async connections(limit) {
      const contract = contractFor('search');
      if (contract === undefined) return missingContract('search');

      const variables = encodeVariables({
        start: 0,
        origin: 'FACETED_SEARCH',
        query: {
          flagshipSearchIntent: 'SEARCH_SRP',
          queryParameters: [
            { key: 'resultType', value: ['PEOPLE'] },
            { key: 'network', value: ['F'] },
          ],
          includeFiltersInResponse: false,
        },
      });
      const url = `${contract.path}?variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'search', operation: 'connections' });
      if (!res.ok) return res;

      const parsed = parseCollection(res.json, {
        operation: 'connections',
        contractCapturedAt: contract.capturedAt,
        claimedCount: totalResultCount(res.json),
        truncated: true,
      });
      parsed.items = parsed.items.slice(0, limit);
      parsed.meta.returnedCount = parsed.items.length;
      const envelope = res.json as { included?: unknown };
      return { ok: true, value: { parsed, index: indexIncluded(envelope.included) } };
    },

    async post(postUrn, limit) {
      const contract = contractFor('comments');
      if (contract === undefined) return missingContract('comments');

      const variables = encodeVariables({
        count: Math.min(limit, 100),
        numReplies: 1,
        socialDetailUrn: socialDetailUrn(postUrn),
        sortOrder: 'RELEVANCE',
        start: 0,
      });
      const url = `${contract.path}?includeWebMetadata=true&variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'page', operation: 'comments' });
      if (!res.ok) return res;

      const parsed = parseCollection(res.json, {
        operation: 'comments',
        contractCapturedAt: contract.capturedAt,
        // A page of many; we follow no cursor yet, so never claim exhaustion.
        truncated: true,
      });
      const envelope = res.json as { included?: unknown };
      return { ok: true, value: { parsed, index: indexIncluded(envelope.included) } };
    },

    async reactions(postUrn, limit) {
      const contract = contractFor('reactions');
      if (contract === undefined) return missingContract('reactions');

      const variables = encodeVariables({
        count: Math.min(limit, 100),
        start: 0,
        threadUrn: postUrn,
      });
      const url = `${contract.path}?includeWebMetadata=true&variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'page', operation: 'reactions' });
      if (!res.ok) return res;

      const parsed = parseCollection(res.json, {
        operation: 'reactions',
        contractCapturedAt: contract.capturedAt,
        truncated: true,
      });
      const envelope = res.json as { included?: unknown };
      return { ok: true, value: { parsed, index: indexIncluded(envelope.included) } };
    },

    async search(kind, query, limit) {
      const contract = contractFor('search');
      if (contract === undefined) return missingContract('search');

      const variables = encodeVariables({
        start: 0,
        origin: 'GLOBAL_SEARCH_HEADER',
        query: {
          keywords: query,
          flagshipSearchIntent: 'SEARCH_SRP',
          queryParameters: [{ key: 'resultType', value: [RESULT_TYPE[kind]] }],
          includeFiltersInResponse: false,
        },
      });
      const url = `${contract.path}?variables=${variables}&queryId=${contract.queryId}`;
      const res = await client.request({ url, spendClass: 'search', operation: 'search' });
      if (!res.ok) return res;

      const parsed = parseCollection(res.json, {
        operation: 'search',
        contractCapturedAt: contract.capturedAt,
        claimedCount: totalResultCount(res.json),
        truncated: true, // one page of many; we never claim exhaustion
      });
      parsed.items = parsed.items.slice(0, limit);
      parsed.meta.returnedCount = parsed.items.length;
      const envelope = res.json as { included?: unknown };
      return { ok: true, value: { parsed, index: indexIncluded(envelope.included) } };
    },
  };
}

/**
 * The composite urn the comments endpoint keys off: the post's own urn,
 * repeated, plus a highlightedReply placeholder. Assembled rather than fetched
 * — verified working with an `urn:li:activity:` urn, so `post` needs no prior
 * lookup to find the ugcPost form.
 */
function socialDetailUrn(postUrn: string): string {
  return `urn:li:fsd_socialDetail:(${postUrn},${postUrn},urn:li:highlightedReply:-)`;
}

/** LinkedIn's own claimed total, used to detect a claimed-but-empty fetch. */
function totalResultCount(json: unknown): number | undefined {
  const found = JSON.stringify(json ?? {}).match(/"totalResultCount":(\d+)/);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}
