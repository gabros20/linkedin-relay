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
