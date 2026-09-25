import { describe, expect, test } from 'bun:test';
import {
  type ApprovalMode,
  canApprove,
  confirmToken,
  confirmWrite,
  planToken,
  renderPlan,
  type WritePlan,
} from '../src/commands/confirm.ts';

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

const BUDGET = '7 of 25 writes left today.';

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

  // A warning printed identically on every action stops being read. An OAuth
  // write really is sanctioned, so claiming §8.2 there would be crying wolf —
  // and would devalue the warning on the transport that has earned it.
  test('does not claim a ToS breach for a write that is actually sanctioned', () => {
    const rendered = renderPlan(plan, BUDGET);
    expect(rendered).not.toContain('§8.2');
    expect(rendered).toContain('sanctioned');
  });

  test('states the ToS breach and the ban risk for a Voyager write', () => {
    const rendered = renderPlan({ ...plan, transport: 'voyager' }, BUDGET);
    expect(rendered).toContain('§8.2');
    expect(rendered).toMatch(/permanently restrict/i);
  });

  // The transport line says what the SURFACE costs. Consequence — public, who
  // is notified, whether it can be undone — varies by action and belongs in
  // `reversibility`. Mixing them produced a delete prompt that warned the
  // deletion was "public under your name".
  test('the transport warning does not claim a consequence the action may not have', () => {
    const deletion = renderPlan(
      {
        action: 'delete a post',
        payload: { urn: 'urn:li:share:1' },
        summary: ['post     urn:li:share:1'],
        reversibility: 'NONE. A deleted post is gone.',
        transport: 'voyager',
      },
      BUDGET,
    );
    expect(deletion).toContain('§8.2');
    expect(deletion).not.toContain('public under your name');
  });

  test('the transport is visible before the token, not buried after it', () => {
    const rendered = renderPlan({ ...plan, transport: 'voyager' }, BUDGET);
    expect(rendered.indexOf('PRIVATE API')).toBeLessThan(rendered.indexOf('to confirm'));
  });

  test('states reversibility honestly rather than implying a clean undo', () => {
    expect(renderPlan(plan, BUDGET)).toContain('may be seen first');
  });

  test('shows the remaining write budget', () => {
    expect(renderPlan(plan, BUDGET)).toContain('7 of 25 writes left');
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

// ─── Approval modes ──────────────────────────────────────────────────────────
//
// Decided 2026-09-25: human-in-the-loop stays the default, but personal agents
// may act on the owner's word ("post it") without a terminal — `agent` mode —
// or on their own — `unattended` mode. Only a human at a terminal can switch
// modes (commands/approval.ts); these tests pin what each mode lets through.
function withApproval(
  mode: ApprovalMode,
  opts: { token?: string; planOnly?: boolean; isTty?: boolean } = {},
) {
  const prompted: string[] = [];
  return {
    prompted,
    deps: {
      isTty: opts.isTty ?? false,
      prompt: async (q: string) => {
        prompted.push(q);
        return '';
      },
      write: () => {},
      approval: { mode, token: opts.token, planOnly: opts.planOnly },
    },
  };
}

describe('--plan', () => {
  test('returns the preview and its token, in any mode, and approves nothing', async () => {
    for (const mode of ['interactive', 'agent', 'unattended'] as const) {
      const out = await confirmWrite(plan, BUDGET, withApproval(mode, { planOnly: true }).deps);
      if (out.ok || out.code !== 'PLANNED') throw new Error(`expected a plan in ${mode}`);
      expect(out.token).toBe(planToken(plan));
      expect(out.preview.join('\n')).toContain('shipping something new today');
    }
  });
});

describe('agent mode', () => {
  test('the token from --plan approves that exact content, with no terminal', async () => {
    const out = await confirmWrite(
      plan,
      BUDGET,
      withApproval('agent', { token: planToken(plan) }).deps,
    );
    if (!out.ok) throw new Error(out.message);
    expect(out.confirmed.payload).toEqual(plan.payload);
  });

  // The whole point of the token: what the owner saw in chat is what gets sent.
  test('a token for different content is refused, saying the content changed', async () => {
    const other = { ...plan, payload: { text: 'something else' } };
    const out = await confirmWrite(
      other,
      BUDGET,
      withApproval('agent', { token: planToken(plan) }).deps,
    );
    if (out.ok || out.code === 'PLANNED') throw new Error('expected refusal');
    expect(out.message).toContain('changed');
  });

  test('without a token and without a terminal, it explains the plan-then-confirm flow', async () => {
    const out = await confirmWrite(plan, BUDGET, withApproval('agent').deps);
    if (out.ok || out.code === 'PLANNED') throw new Error('expected refusal');
    expect(out.hint).toContain('--plan');
    expect(out.hint).toContain('--confirm');
  });

  test('at a terminal without a token, it still asks the human', async () => {
    const a = withApproval('agent', { isTty: true });
    await confirmWrite(plan, BUDGET, a.deps);
    expect(a.prompted).toHaveLength(1);
  });
});

describe('interactive mode', () => {
  // An agent must not be able to approve its own write by echoing the token
  // --plan gave it. In this mode only a terminal can approve.
  test('--confirm is refused, and names how the owner could allow it', async () => {
    const out = await confirmWrite(
      plan,
      BUDGET,
      withApproval('interactive', { token: planToken(plan) }).deps,
    );
    if (out.ok || out.code === 'PLANNED') throw new Error('expected refusal');
    expect(out.hint).toContain('lnrelay approval set');
  });
});

describe('unattended mode', () => {
  test('approves without a token or a terminal', async () => {
    const a = withApproval('unattended');
    const out = await confirmWrite(plan, BUDGET, a.deps);
    expect(out.ok).toBe(true);
    expect(a.prompted).toHaveLength(0);
  });

  test('a token that does not match is still refused — it means the content changed', async () => {
    const out = await confirmWrite(
      plan,
      BUDGET,
      withApproval('unattended', { token: 'ffff' }).deps,
    );
    expect(out.ok).toBe(false);
  });
});

describe('the token basis', () => {
  // A comment's payload carries a trackingId that changes on every page render,
  // so --plan and --confirm would never agree. Commands name a stable basis.
  test('a plan with a tokenBasis is tokenised on that, not on the payload', () => {
    const volatile = {
      ...plan,
      payload: { text: 'x', trackingId: 'r1' },
      tokenBasis: { text: 'x' },
    };
    const rerendered = { ...volatile, payload: { text: 'x', trackingId: 'r2' } };
    expect(planToken(volatile)).toBe(planToken(rerendered));
  });
});

describe('canApprove', () => {
  // Commands that must read before asking (comment harvests the page) check
  // this first, so a request that cannot end in approval makes no network call.
  test('interactive without a terminal cannot, unless it is only planning', () => {
    expect(canApprove(withApproval('interactive').deps)).toBe(false);
    expect(canApprove(withApproval('interactive', { planOnly: true }).deps)).toBe(true);
    expect(canApprove(withApproval('interactive', { isTty: true }).deps)).toBe(true);
  });

  test('agent without a token or terminal cannot; with a token it can', () => {
    expect(canApprove(withApproval('agent').deps)).toBe(false);
    expect(canApprove(withApproval('agent', { token: 'abcd' }).deps)).toBe(true);
  });

  test('unattended always can', () => {
    expect(canApprove(withApproval('unattended').deps)).toBe(true);
  });

  test('deps with no approval at all behave as interactive', () => {
    expect(canApprove({ isTty: false, prompt: async () => '', write: () => {} })).toBe(false);
  });
});
