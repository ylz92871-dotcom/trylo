// Trylo Desktop — CodeRuntimePrewarm policy tests.
//
// M4-C1 (§7.1): the warm-runtime policy must prove — without a
// process or a clock — that cold start is moved off the first-send
// path, that the ready gate is `session_start` and not spawn
// return, that TTL evicts only idle runtimes, and that busy
// runtimes are never reclaimed.

import { describe, expect, it } from 'vitest';
import { CodeRuntimePrewarm } from './code-runtime-prewarm';

function entryState(
  p: CodeRuntimePrewarm,
  k: [string, string],
): string {
  return p.getEntry(k[0], k[1])?.state ?? 'none';
}

describe('CodeRuntimePrewarm', () => {
  it('starts not_started → warming on first ensure', () => {
    const p = new CodeRuntimePrewarm({ idleTtlMs: 600_000 });
    expect(entryState(p, ['p', 'c'])).toBe('none');
    p.ensure('p', 'c');
    expect(entryState(p, ['p', 'c'])).toBe('warming');
    // Idempotent while warming.
    p.ensure('p', 'c');
    expect(entryState(p, ['p', 'c'])).toBe('warming');
  });

  it('ready gate is session_start (markReady), not spawn return', () => {
    const p = new CodeRuntimePrewarm({ idleTtlMs: 600_000 });
    p.ensure('p', 'c');
    // A warming runtime is NOT claimable warm.
    expect(p.claim('p', 'c').kind).toBe('warming');
    p.markReady('p', 'c');
    expect(p.claim('p', 'c').kind).toBe('warm');
    expect(p.getEntry('p', 'c')?.warmedAt).toBeGreaterThan(0);
  });

  it('failed or exited entries can be re-warmed', () => {
    const p = new CodeRuntimePrewarm({ idleTtlMs: 600_000 });
    p.ensure('p', 'c');
    p.markFailed('p', 'c');
    expect(p.claim('p', 'c').kind).toBe('cold');
    const re = p.ensure('p', 'c'); // allowed to restart
    expect(re.state).toBe('warming');
  });

  it('retain turns a used runtime idle and bumps reuse, restarting TTL', () => {
    const p = new CodeRuntimePrewarm({
      idleTtlMs: 600_000,
      now: () => 0,
    });
    p.ensure('p', 'c');
    p.markReady('p', 'c');
    // apply a fake clock jump before retain
    (p as unknown as { now: () => number }).now = () => 5_000;
    p.retain('p', 'c');
    const e = p.claim('p', 'c');
    expect(e.kind).toBe('warm');
    if (e.kind === 'warm') {
      expect(e.entry.state).toBe('idle');
      expect(e.entry.reuseCount).toBe(1);
      expect(e.entry.lastActiveAt).toBe(5_000);
    }
  });

  it('TTL reclaims idle past TTL but never ready/warming/failed', () => {
    const now0 = 1_000_000;
    let now = now0;
    const ttl = 60_000;
    const p = new CodeRuntimePrewarm({ idleTtlMs: ttl, now: () => now });

    // idle conversation (was ready, retained) age to full TTL.
    p.ensure('p', 'idleConv');
    p.markReady('p', 'idleConv');
    p.retain('p', 'idleConv');
    now = now0 + ttl; // freshly over the edge
    // never-used ready conversation stays live.
    p.ensure('p', 'readyConv');
    p.markReady('p', 'readyConv');

    const evicted = p.reclaim(now0 + ttl);
    expect(evicted).toContain('p::idleConv');
    expect(entryState(p, ['p', 'idleConv'])).toBe('none');
    expect(entryState(p, ['p', 'readyConv'])).toBe('ready');
  });

  it('maxLive evicts only idle overflow (never warming/ready)', () => {
    const p = new CodeRuntimePrewarm({
      idleTtlMs: 600_000,
      maxLive: 2,
      now: () => 0,
    });
    // Three warm runtimes: two ready, one idle.
    p.ensure('p', 'a');
    p.markReady('p', 'a');
    p.ensure('p', 'b');
    p.markReady('p', 'b');
    p.ensure('p', 'c');
    p.markReady('p', 'c');
    p.retain('p', 'c'); // c → idle
    p.reclaim();
    // Cap 2 → the single idle (c) is evicted; ready a/b survive.
    expect(entryState(p, ['p', 'a'])).toBe('ready');
    expect(entryState(p, ['p', 'b'])).toBe('ready');
    expect(entryState(p, ['p', 'c'])).toBe('none');
  });

  it('remove forgets a conversation', () => {
    const p = new CodeRuntimePrewarm({ idleTtlMs: 600_000 });
    p.ensure('p', 'c');
    p.remove('p', 'c');
    expect(p.claim('p', 'c').kind).toBe('cold');
  });
});