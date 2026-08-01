import { describe, expect, test } from 'bun:test';
import { ERROR_CODES, err, exitCodeFor, isRetryable, ok, toJson } from '../src/output.ts';

describe('envelope', () => {
  test('ok wraps data with the command name', () => {
    expect(ok('doctor', { healthy: true })).toEqual({
      ok: true,
      command: 'doctor',
      data: { healthy: true },
    });
  });

  test('err omits optional fields rather than emitting undefined keys', () => {
    const e = err('search', 'INVALID_INPUT', 'query required');
    expect(e).toEqual({
      ok: false,
      command: 'search',
      error: { code: 'INVALID_INPUT', message: 'query required' },
    });
    expect(Object.keys(e.error)).toEqual(['code', 'message']);
  });

  test('err carries hint, status and retryAfterMs when supplied', () => {
    const e = err('feed', 'RATE_LIMITED', 'throttled', 'wait it out', 429, 3_600_000);
    expect(e.error.hint).toBe('wait it out');
    expect(e.error.status).toBe(429);
    expect(e.error.retryAfterMs).toBe(3_600_000);
  });

  test('toJson pretty-prints for humans', () => {
    expect(toJson(ok('x', { a: 1 }))).toContain('\n  "ok": true');
  });
});

describe('exit codes', () => {
  test('success exits 0', () => {
    expect(exitCodeFor(ok('doctor', {}))).toBe(0);
  });

  test('a command error exits 1', () => {
    expect(exitCodeFor(err('search', 'INVALID_INPUT', 'nope'))).toBe(1);
  });

  test('an unknown command exits 2', () => {
    expect(exitCodeFor(err('wat', 'UNKNOWN_COMMAND', 'no such command'))).toBe(2);
  });
});

// The design's central rule: nothing about a throttle, block or challenge is
// ever automatically retried. `isRetryable` exists so that rule is asserted in
// tests rather than living only in a comment — if someone later adds a retry
// loop for RATE_LIMITED, this fails.
describe('retry policy', () => {
  test('throttles, blocks and challenges are never retryable', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(false);
    expect(isRetryable('REQUEST_DENIED')).toBe(false);
    expect(isRetryable('CHALLENGE_DETECTED')).toBe(false);
    expect(isRetryable('AUTH_FAILED')).toBe(false);
  });

  test('a transport timeout with no response received is the sole retryable case', () => {
    expect(isRetryable('FETCH_TIMEOUT')).toBe(true);
  });

  test('every declared error code has a defined retry stance', () => {
    for (const code of ERROR_CODES) {
      expect(typeof isRetryable(code)).toBe('boolean');
    }
  });
});
