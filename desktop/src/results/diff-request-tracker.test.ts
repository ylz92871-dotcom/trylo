// Trylo Desktop — diff request identity tests (P2-1 C-Core, audit P2-1).
//
// The diff panel is filled asynchronously; these tests pin the
// generation/identity rules that keep stale responses from overwriting a
// newer panel (path-only identity was the pre-C-Core bug).

import { describe, expect, it } from 'vitest';
import { DiffRequestTracker } from './diff-request-tracker';

describe('DiffRequestTracker (P2-1 C-Core)', () => {
  it('mints a unique generation per request', () => {
    const t = new DiffRequestTracker();
    const first = t.begin('D:/repo', 'c1', 'a.ts');
    const second = t.begin('D:/repo', 'c1', 'b.ts');
    expect(first.requestId).not.toBe(second.requestId);
    expect(t.isCurrent(first)).toBe(false);
    expect(t.isCurrent(second)).toBe(true);
  });

  it('the current identity is accepted exactly as issued', () => {
    const t = new DiffRequestTracker();
    const id = t.begin('D:/repo', 'c1', 'a.ts', 'old/a.ts');
    expect(t.isCurrent(id)).toBe(true);
    expect(t.active).toBe(id);
  });

  it('a newer diff invalidates an older in-flight request', () => {
    const t = new DiffRequestTracker();
    const older = t.begin('D:/repo', 'c1', 'a.ts');
    const newer = t.begin('D:/repo', 'c1', 'b.ts');
    // The stale response for `older` arrives AFTER the user opened `newer`.
    expect(t.isCurrent(older)).toBe(false);
    expect(t.isCurrent(newer)).toBe(true);
  });

  it('the same path is NOT current across a workspace switch', () => {
    const t = new DiffRequestTracker();
    const id = t.begin('D:/repo', 'c1', 'a.ts');
    // Workspace switch → App invalidates; even a re-issued identity for the
    // same path in the OTHER workspace must not match.
    t.invalidate();
    expect(t.isCurrent(id)).toBe(false);
    const other = t.begin('D:/other', 'c1', 'a.ts');
    expect(t.isCurrent(id)).toBe(false);
    expect(t.isCurrent(other)).toBe(true);
  });

  it('the same path is NOT current across a session switch', () => {
    const t = new DiffRequestTracker();
    const id = t.begin('D:/repo', 'c1', 'a.ts');
    t.invalidate();
    const nextSession = t.begin('D:/repo', 'c2', 'a.ts');
    expect(t.isCurrent(id)).toBe(false);
    expect(t.isCurrent(nextSession)).toBe(true);
  });

  it('invalidate() alone drops every in-flight response', () => {
    const t = new DiffRequestTracker();
    const id = t.begin('D:/repo', 'c1', 'a.ts');
    t.invalidate();
    expect(t.isCurrent(id)).toBe(false);
    expect(t.active).toBeNull();
  });

  it('rename origin (oldPath) is part of the identity', () => {
    const t = new DiffRequestTracker();
    // Same target path, different rename source — a DIFFERENT request.
    const r1 = t.begin('D:/repo', 'c1', 'src/a.ts', 'src/old-1.ts');
    const r2 = t.begin('D:/repo', 'c1', 'src/a.ts', 'src/old-2.ts');
    expect(t.isCurrent(r1)).toBe(false);
    expect(t.isCurrent(r2)).toBe(true);
    // And a forged echo without the rename origin does not pass either.
    const forged = { ...r2, oldPath: undefined };
    expect(t.isCurrent(forged)).toBe(false);
  });

  it('a tampered identity never passes the guard', () => {
    const t = new DiffRequestTracker();
    const id = t.begin('D:/repo', 'c1', 'a.ts');
    expect(t.isCurrent({ ...id, path: 'b.ts' })).toBe(false);
    expect(t.isCurrent({ ...id, workspaceRoot: 'D:/evil' })).toBe(false);
    expect(t.isCurrent({ ...id, conversationId: 'c9' })).toBe(false);
    expect(t.isCurrent({ ...id, requestId: 'diff-forged' })).toBe(false);
  });

  it('nothing is current before the first request', () => {
    const t = new DiffRequestTracker();
    expect(t.active).toBeNull();
    expect(
      t.isCurrent({ requestId: 'diff-x', workspaceRoot: 'D:/r', conversationId: 'c', path: 'a' }),
    ).toBe(false);
  });
});
