import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, loadJson, saveJson } from '../src/cache/store.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { gateWrite } from '../src/commands/gate.ts';
import { runOauthStatus } from '../src/commands/oauth.ts';
import { saveToken } from '../src/commands/token.ts';
import { runComment, runReact, runShare } from '../src/commands/write.ts';
import { CAPS } from '../src/engine/budget.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-write-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const noTty: ConfirmDeps = { isTty: false, prompt: async () => '', write: () => {} };

function withToken() {
  saveToken({ accessToken: 'x', memberUrn: 'urn:li:person:ME', expiresAt: T0 + 86_400_000 });
}

/**
 * A browser session. `react` needs one specifically: reacting was found to go
 * over LinkedIn's SDUI surface with cookie auth, not over OAuth, so a token
 * alone no longer reaches that gate.
 */
function withSession() {
  saveJson(cachePath('session.json'), {
    liAt: 'a'.repeat(40),
    jsessionId: '"ajax:1"',
    userAgent: 'Mozilla/5.0',
    capturedAt: '2026-08-01',
  });
}

describe('writes need OAuth, and say how to get it', () => {
  test('share without a token explains the self-serve setup', async () => {
    const e = await runShare('hello', 'public', T0, noTty);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('AUTH_FAILED');
    expect(e.error.hint).toContain('Share on LinkedIn');
  });

  test('oauth status without a token is honest rather than empty', async () => {
    const e = runOauthStatus();
    if (e.ok) throw new Error('expected failure');
    expect(e.error.hint).toContain('developers/apps/new');
  });

  test('oauth status never prints the token itself', () => {
    withToken();
    const e = runOauthStatus();
    if (!e.ok) throw new Error('expected ok');
    expect(JSON.stringify(e.data)).not.toContain('accessToken');
  });
});

// The guarantee that matters: an agent shelling out cannot complete a write.
describe('no TTY, no write', () => {
  test('share refuses without a terminal', async () => {
    withToken();
    const e = await runShare('hello world', 'public', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('comment refuses without a terminal', async () => {
    withToken();
    withSession();
    const e = await runComment('urn:li:activity:1', 'nice', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('react refuses without a terminal', async () => {
    withSession();
    const e = await runReact('urn:li:activity:1', 'LIKE', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  // An aborted write must not consume budget — otherwise refusing to confirm
  // would still cost the user their daily allowance.
  // Refusing to confirm must not cost the user their daily allowance. A ledger
  // that was never written is equally good proof as one showing zero writes.
  test('a refused write spends nothing', async () => {
    withToken();
    await runShare('hello', 'public', T0, noTty);
    const ledger = loadJson<{ spends: Record<string, number[]> }>(cachePath('budget.json'));
    const spent = ledger.state === 'ok' ? (ledger.value.spends.write ?? []) : [];
    expect(spent).toHaveLength(0);
  });
});

describe('argument validation happens before anything else', () => {
  test('share rejects empty text without touching OAuth', async () => {
    const e = await runShare('   ', 'public', T0, noTty);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('INVALID_INPUT');
  });

  test('react rejects an unknown reaction type and lists the valid ones', async () => {
    withToken();
    const e = await runReact('urn:li:activity:1', 'SHRUG', T0, noTty);
    if (e.ok) throw new Error('expected failure');
    expect(e.error.code).toBe('INVALID_INPUT');
    expect(e.error.hint).toContain('PRAISE');
  });
});

describe('the write budget is enforced before the prompt', () => {
  test('an exhausted write budget refuses without asking', async () => {
    withToken();
    // Exactly the cap, read from CAPS rather than hardcoded — this test broke
    // when the cap moved, which meant it was asserting the number and not the
    // behaviour.
    saveJson(cachePath('budget.json'), {
      spends: {
        write: Array.from({ length: CAPS.write.perDay }, (_, i) => T0 - 60_000 - i * 1000),
      },
    });
    const e = await runShare('hello', 'public', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('BUDGET_EXHAUSTED');
  });
});

// The gate commits a write spend, and the client commits another for the same
// operation, so every Voyager/SDUI write cost TWO. Observed live: the prompt
// counted down 6 → 4 → 2 across three reactions. It went unnoticed because
// OAuth writes bypass the client entirely and therefore spend once.
//
// A budget that over-counts is not a safe-side error: it locks the user out of
// their own tool early, and it did.
describe('a write spends exactly once', () => {
  function writesSpent(): number {
    const r = loadJson<{ spends: Record<string, number[]> }>(cachePath('budget.json'));
    return r.state === 'ok' ? (r.value.spends.write?.length ?? 0) : 0;
  }

  const yes: ConfirmDeps = {
    isTty: true,
    prompt: async (q: string) => /Type (\w+) to confirm/.exec(q)?.[1] ?? '',
    write: () => {},
  };
  const plan = {
    action: 'react to a post',
    payload: { urn: 'urn:li:activity:1' },
    summary: [],
    reversibility: 'x',
    transport: 'voyager' as const,
  };

  // The client is documented as "the only place that spends budget". For a
  // transport that goes through it, the gate must therefore only ASK, never
  // account — or the same write is billed twice.
  test('the gate does not account for a write the client will account for', async () => {
    withSession();
    await gateWrite('react', plan, T0, yes, { commitSpend: false });
    expect(writesSpent()).toBe(0);
  });

  // OAuth writes never touch the client, so there the gate is the only place
  // that can account for them and must.
  test('the gate does account when nothing else will', async () => {
    withSession();
    await gateWrite('share', plan, T0, yes);
    expect(writesSpent()).toBe(1);
  });

  test('an aborted write still costs nothing', async () => {
    withSession();
    const before = writesSpent();
    await runReact('urn:li:activity:1', 'LIKE', T0, noTty);
    expect(writesSpent()).toBe(before);
  });
});

// Commenting must fetch the rendered post page to harvest its binding tokens.
// That is a network call, so the TTY check has to come BEFORE it — not merely
// before the send — or an agent shelling out non-interactively causes LinkedIn
// traffic it can never use.
describe('no TTY means no network, not just no write', () => {
  test('comment refuses before fetching anything', async () => {
    withSession();
    let fetched = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const e = await runComment('urn:li:activity:7493711068700033024', 'hi', T0, noTty);
      expect(e.ok).toBe(false);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The comment harvest is a ~2.8 MB HTML GET — the heaviest single request this
// tool makes — and it went through raw `fetch`, bypassing the ledger, the
// cooldown and the pacing entirely. Unaccounted traffic is exactly what the
// Permit type exists to make impossible, and this walked around it.
describe('the comment harvest is accounted for', () => {
  test('a harvest spends page budget rather than being invisible', async () => {
    withSession();
    const before = loadJson<{ spends: Record<string, number[]> }>(cachePath('budget.json'));
    const beforeN = before.state === 'ok' ? (before.value.spends.page?.length ?? 0) : 0;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html>no key here</html>', { status: 200 })) as typeof fetch;
    const yes: ConfirmDeps = { isTty: true, prompt: async () => 'no', write: () => {} };
    try {
      await runComment('urn:li:activity:7493711068700033024', 'hi', T0, yes);
    } finally {
      globalThis.fetch = realFetch;
    }

    const after = loadJson<{ spends: Record<string, number[]> }>(cachePath('budget.json'));
    const afterN = after.state === 'ok' ? (after.value.spends.page?.length ?? 0) : 0;
    expect(afterN).toBeGreaterThan(beforeN);
  });
});
