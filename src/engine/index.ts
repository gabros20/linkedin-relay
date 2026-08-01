// The Engine interface and its real construction. This is the seam: everything
// above it is pure and testable, everything below it talks to LinkedIn.

import { cachePath, loadJson, saveJson } from '../cache/store.ts';
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
import { encodeVariables } from './restli.ts';

export interface Engine {
  whoami(): Promise<EngineResult<Entity | undefined>>;
  profile(memberId: string): Promise<EngineResult<ProfileResult | undefined>>;
  feed(limit: number): Promise<EngineResult<ParseResult>>;
  search(kind: SearchKind, query: string, limit: number): Promise<EngineResult<ParseResult>>;
}

export type SearchKind = 'people' | 'companies' | 'jobs';

/**
 * A profile plus the side-table it references. LinkedIn returns location,
 * current position and education as URN references into `included[]`, so the
 * caller needs the index to make sense of the profile node.
 */
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

export function createEngine(session: Session, deps?: Partial<ClientDeps>): Engine {
  const client: Client = createClient(session, {
    fetch: globalThis.fetch,
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
      return {
        ok: true,
        value: parseCollection(res.json, {
          operation: 'feed',
          contractCapturedAt: contract.capturedAt,
        }),
      };
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
      return { ok: true, value: parsed };
    },
  };
}

/** LinkedIn's own claimed total, used to detect a claimed-but-empty fetch. */
function totalResultCount(json: unknown): number | undefined {
  const found = JSON.stringify(json ?? {}).match(/"totalResultCount":(\d+)/);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}
