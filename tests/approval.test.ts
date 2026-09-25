import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachePath, loadJson } from '../src/cache/store.ts';
import {
  auditOutcome,
  loadApprovalMode,
  runApprovalSet,
  runApprovalShow,
  setToken,
} from '../src/commands/approval.ts';
import { planToken, type WritePlan } from '../src/commands/confirm.ts';
import { gateWrite } from '../src/commands/gate.ts';

const T0 = 1_800_000_000_000;

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lnrelay-approval-'));
  prev = process.env.LNRELAY_CACHE_DIR;
  process.env.LNRELAY_CACHE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LNRELAY_CACHE_DIR;
  else process.env.LNRELAY_CACHE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function terminal(answer: string, isTty = true) {
  return { isTty, prompt: async () => answer, write: () => {} };
}

const audit = (): Record<string, unknown>[] => {
  const p = cachePath('writes.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('the stored mode', () => {
  test('defaults to interactive when nothing was ever set', () => {
    expect(loadApprovalMode()).toEqual({ ok: true, mode: 'interactive' });
  });

  // Never degrade to a permissive default: an unreadable setting refuses writes.
  test('an unrecognised value is an error, not a silent default', () => {
    writeFileSync(cachePath('config.json'), JSON.stringify({ approval: 'yolo' }));
    expect(loadApprovalMode().ok).toBe(false);
  });

  test('a corrupt file is an error, not a silent default', () => {
    writeFileSync(cachePath('config.json'), '{not json');
    expect(loadApprovalMode().ok).toBe(false);
  });
});

describe('setting the mode', () => {
  // The guarantee the whole scheme rests on: an agent cannot promote itself.
  test('refuses without a terminal and leaves the mode unchanged', async () => {
    const e = await runApprovalSet('unattended', terminal(setToken('unattended'), false));
    expect(e.ok).toBe(false);
    expect(loadApprovalMode()).toEqual({ ok: true, mode: 'interactive' });
  });

  test('the typed token switches it', async () => {
    const e = await runApprovalSet('agent', terminal(setToken('agent')));
    expect(e.ok).toBe(true);
    expect(loadApprovalMode()).toEqual({ ok: true, mode: 'agent' });
  });

  test('a wrong answer leaves it unchanged', async () => {
    await runApprovalSet('unattended', terminal('y'));
    expect(loadApprovalMode()).toEqual({ ok: true, mode: 'interactive' });
  });

  test('an unknown mode is refused and lists the valid ones', async () => {
    const e = await runApprovalSet('auto', terminal('x'));
    if (e.ok) throw new Error('expected refusal');
    expect(e.error.code).toBe('INVALID_INPUT');
    expect(e.error.hint).toContain('unattended');
  });

  test('a mode change is itself audited', async () => {
    await runApprovalSet('agent', terminal(setToken('agent')));
    expect(audit().at(-1)).toMatchObject({ event: 'mode', mode: 'agent' });
  });

  test('show reports the mode and what it means', () => {
    const e = runApprovalShow();
    if (!e.ok) throw new Error('expected ok');
    expect(e.data).toMatchObject({ mode: 'interactive' });
  });
});

const plan: WritePlan<{ text: string }> = {
  action: 'post to your feed',
  payload: { text: 'hello' },
  summary: ['content  "hello"'],
  reversibility: 'deletable',
  transport: 'voyager',
};

describe('the gate', () => {
  test('--plan answers ok with the preview and token, and spends nothing', async () => {
    const e = await gateWrite('share', plan, T0, {
      ...terminal('', false),
      approval: { mode: 'agent', planOnly: true },
    });
    if (!('ok' in e) || !e.ok) throw new Error('expected an ok envelope');
    expect(e.data).toMatchObject({ planned: true, token: planToken(plan) });
    const ledger = loadJson<{ spends: Record<string, number[]> }>(cachePath('budget.json'));
    expect(ledger.state).toBe('missing');
    expect(audit()).toHaveLength(0);
  });

  test('an approval is audited with its mode and content', async () => {
    await gateWrite(
      'share',
      plan,
      T0,
      { ...terminal('', false), approval: { mode: 'agent', token: planToken(plan) } },
      { commitSpend: false },
    );
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ event: 'approved', command: 'share', mode: 'agent' });
    expect(JSON.stringify(audit()[0])).toContain('hello');
  });

  test('a refusal is not audited as an approval', async () => {
    await gateWrite('share', plan, T0, { ...terminal('', false), approval: { mode: 'agent' } });
    expect(audit()).toHaveLength(0);
  });

  test('the outcome of a write is audited after it', () => {
    auditOutcome('share', 'unattended', {
      ok: true,
      command: 'share',
      data: { id: 'urn:li:share:1' },
    });
    expect(audit()[0]).toMatchObject({ event: 'outcome', ok: true, mode: 'unattended' });
    expect(JSON.stringify(audit()[0])).toContain('urn:li:share:1');
  });
});
