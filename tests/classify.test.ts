import { describe, expect, test } from 'bun:test';
import { classify } from '../src/engine/classify.ts';

const okBody = JSON.stringify({ data: { thing: 1 }, included: [{ entityUrn: 'urn:li:x:1' }] });

describe('success', () => {
  test('a 200 with a well-formed body succeeds', () => {
    expect(classify({ status: 200, body: okBody }).outcome).toBe('ok');
  });

  test('a genuinely empty collection is success, not failure', () => {
    // No references in `data`, nothing in `included` — LinkedIn is telling us
    // there is nothing, and that is a real answer.
    const body = JSON.stringify({ data: { '*elements': [] }, included: [] });
    expect(classify({ status: 200, body }).outcome).toBe('ok');
  });
});

// The design's central rule, asserted rather than commented: nothing here is
// ever retried, and each signal opens a cooldown proportional to how bad it is.
describe('throttles and blocks', () => {
  test('429 is RATE_LIMITED and opens a cooldown', () => {
    const r = classify({ status: 429, body: '{}' });
    expect(r.outcome).toBe('error');
    expect(r.code).toBe('RATE_LIMITED');
    expect(r.cooldown).toBe('RATE_LIMITED');
  });

  test('429 surfaces retry-after as milliseconds for the human to read', () => {
    const r = classify({ status: 429, body: '{}', headers: { 'retry-after': '120' } });
    expect(r.retryAfterMs).toBe(120_000);
  });

  test('HTTP 999 is REQUEST_DENIED with its own longer cooldown', () => {
    const r = classify({ status: 999, body: 'Request Denied' });
    expect(r.code).toBe('REQUEST_DENIED');
    expect(r.cooldown).toBe('REQUEST_DENIED');
  });

  test('no classification is ever marked retryable', () => {
    for (const status of [429, 999, 403, 401, 500, 503]) {
      expect(classify({ status, body: '{}' }).retry).toBe(false);
    }
  });
});

describe('challenges', () => {
  test('a checkpoint redirect is a challenge, not an auth failure', () => {
    const r = classify({
      status: 302,
      body: '',
      headers: { location: 'https://www.linkedin.com/checkpoint/challenge/verify' },
    });
    expect(r.code).toBe('CHALLENGE_DETECTED');
    expect(r.cooldown).toBe('CHALLENGE_DETECTED');
  });

  test('challenge markup in a 200 body still counts', () => {
    const r = classify({
      status: 200,
      body: '<html><body>Security Verification captcha</body></html>',
    });
    expect(r.code).toBe('CHALLENGE_DETECTED');
  });
});

describe('auth', () => {
  test('401 is a terminal auth failure with no cooldown', () => {
    const r = classify({ status: 401, body: '{}' });
    expect(r.code).toBe('AUTH_FAILED');
    expect(r.cooldown).toBeUndefined();
  });

  // Learned the hard way by others: this signature is expired cookies, not bot
  // detection. The hint says so, so nobody burns a day chasing fingerprints.
  test('a 302 to the login page is expired cookies, and says so', () => {
    const r = classify({
      status: 302,
      body: '',
      headers: { location: 'https://www.linkedin.com/login?session_redirect=%2Ffeed%2F' },
    });
    expect(r.code).toBe('AUTH_FAILED');
    expect(r.hint).toContain('expired');
  });
});

// Captured live 2026-08-01: profileView answers with an HTTP 410 whose body is
// a well-formed Voyager envelope. A parser that only looked at `included`
// would read this as "no data".
describe('endpoint drift', () => {
  test('410 is SCHEMA_DRIFT — the endpoint is gone, not the data', () => {
    const r = classify({ status: 410, body: '{"data":{"status":410},"included":[]}' });
    expect(r.code).toBe('SCHEMA_DRIFT');
    expect(r.message).toContain('410');
  });

  test('a 200 body carrying an inner 410 status is also drift', () => {
    const r = classify({ status: 200, body: '{"data":{"status":410},"included":[]}' });
    expect(r.code).toBe('SCHEMA_DRIFT');
  });

  test('a 400 naming an unknown queryId is drift, with a re-capture hint', () => {
    const r = classify({
      status: 400,
      body: '{"message":"Unknown queryId voyagerSearchDashClusters.deadbeef"}',
    });
    expect(r.code).toBe('SCHEMA_DRIFT');
    expect(r.hint).toContain('re-capture');
  });

  // The 336-analogue. data references URNs that included[] does not contain at
  // all — the decoration failed wholesale. Not an empty result.
  test('data references with a wholly empty included is drift, not emptiness', () => {
    const body = JSON.stringify({
      data: { '*elements': ['urn:li:activity:1', 'urn:li:activity:2'] },
      included: [],
    });
    expect(classify({ status: 200, body }).code).toBe('SCHEMA_DRIFT');
  });

  test('unparseable JSON on a 200 is drift rather than a crash', () => {
    expect(classify({ status: 200, body: 'not json at all' }).code).toBe('SCHEMA_DRIFT');
  });
});

describe('other statuses', () => {
  test('404 is NOT_FOUND and opens no cooldown', () => {
    const r = classify({ status: 404, body: '{}' });
    expect(r.code).toBe('NOT_FOUND');
    expect(r.cooldown).toBeUndefined();
  });

  test('a 5xx is a fetch failure, still not retried automatically', () => {
    const r = classify({ status: 503, body: '' });
    expect(r.code).toBe('FETCH_FAILED');
    expect(r.retry).toBe(false);
  });
});

// Reads only ever return 200, so the classifier was written to accept only
// 200 — and then rejected the first real write with "unexpected status 201".
// The post had in fact been created. Reporting a success as a failure is the
// worst direction to be wrong in here: it invites a re-run, and the re-run
// posts a second time.
describe('write statuses are successes', () => {
  test('201 Created is a success — the first live share returned it', () => {
    expect(classify({ status: 201, body: '', headers: {} }).outcome).not.toBe('error');
  });

  test('204 No Content is a success — this is what delete returns', () => {
    expect(classify({ status: 204, body: '', headers: {} }).outcome).not.toBe('error');
  });

  test('200 still works, and reads are unaffected', () => {
    const res = { status: 200, body: '{"data":{},"included":[]}', headers: {} };
    expect(classify(res).outcome).not.toBe('error');
  });

  // An empty body is normal for 201/204 and must not be mistaken for the
  // "claimed but empty" drift that a 200 with no `included` would signal.
  test('an empty body on 204 is not treated as schema drift', () => {
    const c = classify({ status: 204, body: '', headers: {} });
    expect(c.code).toBeUndefined();
  });

  test('a 2xx we have never seen is still accepted rather than failed', () => {
    expect(classify({ status: 202, body: '', headers: {} }).outcome).not.toBe('error');
  });

  // The bug was a missing success case, not a missing failure case. Widening
  // it must not swallow the statuses the breaker depends on.
  test('the hostile statuses are still failures', () => {
    for (const status of [400, 401, 403, 404, 410, 429, 999]) {
      expect(classify({ status, body: '{}', headers: {} }).outcome).toBe('error');
    }
  });

  test('a 3xx redirect is still not a success', () => {
    expect(classify({ status: 302, body: '', headers: { location: '/login' } }).outcome).toBe(
      'error',
    );
  });
});

// THIRD instance of one root cause: response handling written for reads, then
// applied to writes. First 201 was rejected as an "unexpected status". Then 204
// would have been. Now a write that succeeded was reported as SCHEMA_DRIFT
// because its body is not JSON — LinkedIn's SDUI surface answers with a React
// Server Components stream. The reaction landed; the tool said it failed; the
// user retried three times and spent six writes.
//
// A read's body is a contract we validate. A write's body is a receipt.
describe('a write response is not validated like a read', () => {
  const rsc = { status: 200, body: '2:I[45613,[],""]\n0:["$@1",null]\n', headers: {} };

  test('a non-JSON 200 on a write is a success', () => {
    expect(classify(rsc, { expectJson: false }).outcome).not.toBe('error');
  });

  test('the same body on a READ is still schema drift — reads keep their contract', () => {
    const c = classify(rsc, { expectJson: true });
    expect(c.outcome).toBe('error');
    expect(c.code).toBe('SCHEMA_DRIFT');
  });

  test('reads validate by default, so nothing loosens by omission', () => {
    expect(classify(rsc).outcome).toBe('error');
  });

  test('a write that does return JSON still has it parsed', () => {
    const c = classify(
      { status: 200, body: '{"urn":"urn:li:share:1"}', headers: {} },
      {
        expectJson: false,
      },
    );
    expect((c.json as { urn: string }).urn).toBe('urn:li:share:1');
  });

  // Widening the success path must not swallow the signals the breaker needs.
  test('hostile statuses still fail on a write', () => {
    for (const status of [401, 429, 999]) {
      expect(classify({ status, body: 'x', headers: {} }, { expectJson: false }).outcome).toBe(
        'error',
      );
    }
  });

  test('a challenge page is still caught on a write path', () => {
    const challenge = { status: 200, body: '<html>checkpoint/challenge</html>', headers: {} };
    expect(classify(challenge, { expectJson: false }).outcome).toBe('error');
  });
});
