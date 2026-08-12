import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, loadJson, saveJson } from '../src/cache/store.ts';
import type { ConfirmDeps } from '../src/commands/confirm.ts';
import { runOauthStatus } from '../src/commands/oauth.ts';
import { saveToken } from '../src/commands/token.ts';
import { runComment, runReact, runShare } from '../src/commands/write.ts';

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
    const e = await runComment('urn:li:activity:1', 'nice', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('react refuses without a terminal', async () => {
    withToken();
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
    // 10 writes already today — the cap.
    saveJson(cachePath('budget.json'), {
      spends: { write: Array.from({ length: 10 }, (_, i) => T0 - 60_000 - i * 1000) },
    });
    const e = await runShare('hello', 'public', T0, noTty);
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('BUDGET_EXHAUSTED');
  });
});
