import { describe, expect, test } from 'bun:test';
import { confirmToken, confirmWrite, renderPlan, type WritePlan } from '../src/commands/confirm.ts';

const plan: WritePlan<{ text: string }> = {
  action: 'share',
  payload: { text: 'shipping something new today' },
  summary: ['as       Tamás Gábor', 'content  "shipping something new today"'],
  reversibility: 'deletable from the LinkedIn UI; the post may be seen first',
  transport: 'oauth',
};

function deps(isTty: boolean, answer: string) {
  const written: string[] = [];
  return {
    written,
    deps: {
      isTty,
      prompt: async (q: string) => {
        written.push(q);
        return answer;
      },
      write: (s: string) => written.push(s),
    },
  };
}

const BUDGET = '7 of 10 writes left today.';

describe('the token', () => {
  test('is derived from the payload, so it is stable for identical content', () => {
    expect(confirmToken('share', { text: 'a' })).toBe(confirmToken('share', { text: 'a' }));
  });

  // A token captured from one prompt must not approve a different write.
  test('changes when the content changes', () => {
    expect(confirmToken('share', { text: 'a' })).not.toBe(confirmToken('share', { text: 'b' }));
  });

  test('changes when the action changes', () => {
    expect(confirmToken('share', { text: 'a' })).not.toBe(confirmToken('comment', { text: 'a' }));
  });

  test('is short enough to type but not guessable in one go', () => {
    expect(confirmToken('share', { text: 'a' })).toHaveLength(4);
  });
});

describe('the prompt', () => {
  test('shows exactly what will be sent', () => {
    const rendered = renderPlan(plan, BUDGET);
    expect(rendered).toContain('shipping something new today');
  });

  test('states the ToS breach and the ban risk at the moment of the write', () => {
    const rendered = renderPlan(plan, BUDGET);
    expect(rendered).toContain('§8.2');
    expect(rendered).toMatch(/permanently restrict/i);
  });

  test('states reversibility honestly rather than implying a clean undo', () => {
    expect(renderPlan(plan, BUDGET)).toContain('may be seen first');
  });

  test('shows the remaining write budget', () => {
    expect(renderPlan(plan, BUDGET)).toContain('7 of 10 writes left');
  });

  test('names the transport, so an official write is distinguishable', () => {
    expect(renderPlan(plan, BUDGET)).toContain('w_member_social');
  });
});

// The load-bearing guarantee: an agent shelling out non-interactively cannot
// complete a write, whatever arguments it composes.
describe('no TTY, no write', () => {
  test('refuses without an interactive terminal', async () => {
    const { deps: d } = deps(false, 'anything');
    const r = await confirmWrite(plan, BUDGET, d);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('CONFIRMATION_REQUIRED');
  });

  test('does not even prompt when there is no terminal', async () => {
    const { written, deps: d } = deps(false, 'anything');
    await confirmWrite(plan, BUDGET, d);
    expect(written).toHaveLength(0);
  });

  test('says plainly that nothing was sent', async () => {
    const { deps: d } = deps(false, 'x');
    const r = await confirmWrite(plan, BUDGET, d);
    if (r.ok) throw new Error('unreachable');
    expect(r.hint).toMatch(/nothing was sent/i);
  });

  // There must be no escape hatch. If the ritual is intolerable the answer is
  // that this tool should not write for that user, not that it becomes optional.
  test('the hint explains why there is no --yes flag', async () => {
    const { deps: d } = deps(false, 'x');
    const r = await confirmWrite(plan, BUDGET, d);
    if (r.ok) throw new Error('unreachable');
    expect(r.hint).toContain('--yes');
  });
});

describe('confirming at a terminal', () => {
  test('the exact token confirms', async () => {
    const token = confirmToken(plan.action, plan.payload);
    const { deps: d } = deps(true, token);
    const r = await confirmWrite(plan, BUDGET, d);
    expect(r.ok).toBe(true);
  });

  test('tolerates surrounding whitespace', async () => {
    const token = confirmToken(plan.action, plan.payload);
    const { deps: d } = deps(true, `  ${token}\n`);
    expect((await confirmWrite(plan, BUDGET, d)).ok).toBe(true);
  });

  // `yes | lnrelay share …` must not work.
  test('a blind "y" does not confirm', async () => {
    const { deps: d } = deps(true, 'y');
    expect((await confirmWrite(plan, BUDGET, d)).ok).toBe(false);
  });

  test('an empty answer does not confirm', async () => {
    const { deps: d } = deps(true, '');
    expect((await confirmWrite(plan, BUDGET, d)).ok).toBe(false);
  });

  test("another plan's token does not confirm this one", async () => {
    const other = confirmToken('share', { text: 'a completely different post' });
    const { deps: d } = deps(true, other);
    expect((await confirmWrite(plan, BUDGET, d)).ok).toBe(false);
  });

  test('the confirmed value carries the exact payload that was shown', async () => {
    const token = confirmToken(plan.action, plan.payload);
    const { deps: d } = deps(true, token);
    const r = await confirmWrite(plan, BUDGET, d);
    if (!r.ok) throw new Error('expected confirmation');
    expect(r.confirmed.payload).toEqual(plan.payload);
    expect(r.confirmed.action).toBe('share');
  });
});
