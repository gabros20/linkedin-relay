import { describe, expect, test } from 'bun:test';
import { evaluate, findRequest, readModel, wireStates } from '../src/engine/sdui-form.ts';

const key = (id: string) => ({ key: { key: { value: { $case: 'id', id } } } });
const stream = (entries: unknown[], rest = '') =>
  `0:{"modelStates":${JSON.stringify(entries)}}\n${rest}`;

describe('initial values', () => {
  test('are read from modelStates, in the shape the save sends them', () => {
    const model = readModel(
      stream([
        { ...key('t'), value: { $case: 'stringValue', stringValue: 'x' } },
        {
          ...key('l'),
          value: { $case: 'stringListValue', stringListValue: { stringValues: ['a'] } },
        },
        // RSC encodes a bigint as "$n<digits>"; the browser sends it as {type, value}.
        { ...key('o'), value: { $case: 'signedLongValue', signedLongValue: '$n-1' } },
      ]),
    );
    if (model === null) throw new Error('no model');
    expect(model.get('t')).toEqual({ protoCase: 'stringValue', value: 'x' });
    expect(model.get('l')).toEqual({ protoCase: 'stringListValue', value: ['a'] });
    expect(model.get('o')).toEqual({
      protoCase: 'signedLongValue',
      value: { type: 'bigint', value: '-1' },
    });
  });

  test('no modelStates is null, not an empty form', () => {
    expect(readModel('0:{"other":[]}')).toBeNull();
  });
});

describe('finding an action', () => {
  test('returns its arguments verbatim', () => {
    const s = stream(
      [],
      '1:{"value":{"requestId":"x.save","requestedArguments":{"requestedStateKeys":[],"payload":{"a":1}}}}',
    );
    expect(findRequest(s, 'x.save')).toEqual({ requestedStateKeys: [], payload: { a: 1 } });
    expect(findRequest(s, 'x.other')).toBeNull();
  });
});

const bound = (id: string) => ({
  expression: {
    $case: 'bindableString',
    bindableString: { key: { key: { value: { $case: 'id', id } } } },
  },
});
const lit = (v: string) => ({ expression: { $case: 'stringValue', stringValue: v } });
// Captured: a company is required unless employment type is 3 or 20.
const companyRequired = {
  expression: {
    $case: 'booleanExpression',
    booleanExpression: {
      expression: {
        $case: 'notExpression',
        notExpression: {
          a: {
            expression: {
              $case: 'orExpression',
              orExpression: {
                a: {
                  expression: {
                    $case: 'stringEqualsExpression',
                    stringEqualsExpression: { a: bound('type'), b: lit('3') },
                  },
                },
                b: {
                  expression: {
                    $case: 'stringEqualsExpression',
                    stringEqualsExpression: { a: bound('type'), b: lit('20') },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe('computed values', () => {
  test('a boolean expression over other fields is evaluated', () => {
    const at = (type: string) =>
      evaluate(companyRequired, new Map([['type', { protoCase: 'stringValue', value: type }]]));
    expect(at('')).toEqual({ ok: true, value: true });
    expect(at('20')).toEqual({ ok: true, value: false });
  });

  // Guessing a computed value is how a save quietly sends the wrong thing.
  test('an expression it does not know is refused, not guessed', () => {
    const r = evaluate({ expression: { $case: 'somethingNew' } }, new Map());
    expect(r.ok).toBe(false);
  });

  test('a requested key that is computed is sent as an expression with its value', () => {
    const model = new Map([
      ['type', { protoCase: 'stringValue', value: '' }],
      ['req', { protoCase: 'expression', value: companyRequired }],
    ]);
    const states = wireStates(['type', 'req', 'absent'], model, () => undefined);
    if (!Array.isArray(states)) throw new Error(states.message);
    expect(states.map((s) => [s.key, s.value, s.originalProtoCase])).toEqual([
      ['type', '', 'stringValue'],
      ['req', true, 'expression'],
    ]);
  });
});
