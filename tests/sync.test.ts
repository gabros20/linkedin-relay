import { describe, expect, test } from 'bun:test';
import { diffSnapshot } from '../src/commands/sync.ts';

// Connections have no ordering, so sync is a snapshot and a set difference.
// The rule that matters is when a difference may be TRUSTED.
describe('diffSnapshot', () => {
  test('a complete snapshot yields removals', () => {
    const r = diffSnapshot(new Set(['a', 'b']), new Set(['a']), 1);
    expect(r.complete).toBe(true);
    expect(r.removed).toEqual(['b']);
  });

  test('nothing removed when the snapshot matches', () => {
    expect(diffSnapshot(new Set(['a']), new Set(['a']), 1).removed).toEqual([]);
  });

  // The load-bearing one. If LinkedIn claims 400 and a limit fetched 50, the
  // 350 unseen are not gone — they were never looked at. Reporting them as
  // removed would tell the user people had disconnected because of pagination.
  test('an incomplete snapshot infers NO removals', () => {
    const r = diffSnapshot(new Set(['a', 'b', 'c']), new Set(['a']), 400);
    expect(r.complete).toBe(false);
    expect(r.removed).toEqual([]);
  });

  test('an unknown claimed count is treated as complete', () => {
    // LinkedIn did not tell us a total, so the snapshot is all we can know.
    const r = diffSnapshot(new Set(['a', 'b']), new Set(['a']), undefined);
    expect(r.complete).toBe(true);
    expect(r.removed).toEqual(['b']);
  });

  test('a first sync with nothing stored removes nothing', () => {
    expect(diffSnapshot(new Set(), new Set(['a', 'b']), 2).removed).toEqual([]);
  });

  test('retrieving more than claimed still counts as complete', () => {
    // Claimed counts drift; seeing more than claimed is not a reason to refuse.
    expect(diffSnapshot(new Set(['a']), new Set(['a', 'b']), 1).complete).toBe(true);
  });
});
