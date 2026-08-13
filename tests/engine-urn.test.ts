import { describe, expect, test } from 'bun:test';
import type { Session } from '../src/engine/auth.ts';
import { emptyLedger } from '../src/engine/budget.ts';
import { createEngine } from '../src/engine/index.ts';

const SESSION: Session = {
  liAt: 'a'.repeat(40),
  jsessionId: '"ajax:1"',
  userAgent: 'Mozilla/5.0',
  capturedAt: '2026-08-01',
};

/** Captures the URL the engine builds, without touching the network. */
function spy() {
  const urls: string[] = [];
  const engine = createEngine(
    SESSION,
    {
      fetch: (async (url: string) => {
        urls.push(String(url));
        return {
          status: 200,
          text: async () => '{"data":{},"included":[]}',
          headers: { forEach: () => {} },
        };
      }) as unknown as typeof fetch,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
      random: () => 0,
      loadLedger: () => emptyLedger(),
      saveLedger: () => {},
      loadCooldown: () => null,
      saveCooldown: () => {},
    },
    true,
  );
  return { engine, urls };
}

// `whoami` returns an `fs_miniProfile` urn. `myPosts` is a DASH endpoint
// (voyagerFeedDashProfileUpdates) and wants the `fsd_profile` form. Handing it
// the legacy namespace returns an empty result with HTTP 200 — no error, no
// warning, just nothing.
//
// This shipped as "verified" because the account had no posts when the
// contract was captured, so an empty response was indistinguishable from a
// working one. The first real post is what exposed it. canonicalUrn already
// existed and already handled this — it was applied when PARSING urns and
// never when sending one.
describe('outgoing urns are canonicalised, not just incoming ones', () => {
  test('myPosts converts a legacy miniProfile urn to the dash namespace', async () => {
    const { engine, urls } = spy();
    await engine.myPosts('urn:li:fs_miniProfile:ACoAABkU2Wk', 10);
    expect(urls[0]).toContain('fsd_profile');
    expect(urls[0]).not.toContain('fs_miniProfile');
  });

  test('an already-canonical urn is passed through unchanged', async () => {
    const { engine, urls } = spy();
    await engine.myPosts('urn:li:fsd_profile:ACoAABkU2Wk', 10);
    expect(urls[0]).toContain('fsd_profile%3AACoAABkU2Wk');
  });

  test('the member id itself survives the conversion intact', async () => {
    const { engine, urls } = spy();
    await engine.myPosts('urn:li:fs_miniProfile:ACoAABkU2WkBwVjyZrBxlHL0ykQ2sXWtJATrBww', 10);
    expect(urls[0]).toContain('ACoAABkU2WkBwVjyZrBxlHL0ykQ2sXWtJATrBww');
  });
});
