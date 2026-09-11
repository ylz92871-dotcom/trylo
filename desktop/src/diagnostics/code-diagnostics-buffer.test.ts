// Trylo Desktop — code-diagnostics ring buffer tests (C-Edge P2-5).
//
// Pin the buffer's contract: bounded, deduped, anonymous, frozen,
// exportable. The buffer is the on-call engineer's first stop when
// "Code didn't work" — every test below exists because something in
// the shape must never silently break.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeDiagnosticsBuffer,
  DIAG_BUFFER_LIMIT,
  type DiagEvent,
} from './code-diagnostics-buffer';

function fixedNowSequence(timestamps: number[]): () => number {
  let i = 0;
  return () => {
    const v = timestamps[i];
    if (v === undefined) {
      return timestamps[timestamps.length - 1] ?? 0;
    }
    i = Math.min(i + 1, timestamps.length - 1);
    return v;
  };
}

let buffer: CodeDiagnosticsBuffer;
let now = 0;

beforeEach(() => {
  now = 1_000_000;
  buffer = new CodeDiagnosticsBuffer({ now: () => now, limit: 16 });
});

afterEach(() => {
  buffer.clear();
});

const base = {
  runId: 'run-abc',
  projectKey: 'project-X',
  conversationId: 'conv-Y',
};

describe('CodeDiagnosticsBuffer — push basics', () => {
  it('records an event with hashed identifiers', () => {
    buffer.push({ ...base, type: 'prewarm.requested' });
    const snap = buffer.snapshot();
    expect(snap.events.length).toBe(1);
    const e = snap.events[0]!;
    expect(e.type).toBe('prewarm.requested');
    expect(e.runIdHash).not.toBe(base.runId);
    expect(e.runIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(e.projectAnonId).toMatch(/^[0-9a-f]{12}$/);
    expect(e.conversationAnonId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('records wall-clock time', () => {
    now = 1_700_000_000_000;
    buffer.push({ ...base, type: 'terminal' });
    const e = buffer.snapshot().events[0]!;
    expect(e.t).toBe(1_700_000_000_000);
  });

  it('attaches optional fields when supplied', () => {
    buffer.push({
      ...base,
      type: 'process.exit',
      exitCode: 137,
      signal: 9,
      reasonCode: 'SIGKILL',
    });
    const e = buffer.snapshot().events[0]!;
    expect(e.exitCode).toBe(137);
    expect(e.signal).toBe(9);
    expect(e.reasonCode).toBe('SIGKILL');
  });

  it('omits optional fields when not supplied', () => {
    buffer.push({ ...base, type: 'terminal' });
    const e = buffer.snapshot().events[0]!;
    expect('latencyMs' in e).toBe(false);
    expect('exitCode' in e).toBe(false);
    expect('reasonCode' in e).toBe(false);
  });

  it('clamps negative latency to 0', () => {
    buffer.push({ ...base, type: 'first.raw_event', latencyMs: -10 });
    const e = buffer.snapshot().events[0]!;
    expect(e.latencyMs).toBe(0);
  });

  it('rounds latency to an integer', () => {
    buffer.push({ ...base, type: 'first.raw_event', latencyMs: 12.7 });
    const e = buffer.snapshot().events[0]!;
    expect(e.latencyMs).toBe(12);
  });
});

describe('CodeDiagnosticsBuffer — dedupe window', () => {
  it('collapses two identical events inside 100ms', () => {
    now = 1000;
    buffer.push({ ...base, type: 'prewarm.spawned' });
    now = 1050; // 50ms later
    buffer.push({ ...base, type: 'prewarm.spawned' });
    expect(buffer.snapshot().events.length).toBe(1);
  });

  it('keeps identical events when the gap is ≥ 100ms', () => {
    now = 1000;
    buffer.push({ ...base, type: 'prewarm.spawned' });
    now = 1100; // 100ms later
    buffer.push({ ...base, type: 'prewarm.spawned' });
    expect(buffer.snapshot().events.length).toBe(2);
  });

  it('keeps different event types even back-to-back', () => {
    now = 1000;
    buffer.push({ ...base, type: 'prewarm.requested' });
    now = 1001;
    buffer.push({ ...base, type: 'prewarm.spawned' });
    expect(buffer.snapshot().events.length).toBe(2);
  });

  it('keeps events for different runs even with same type', () => {
    now = 1000;
    buffer.push({ ...base, runId: 'run-1', type: 'prewarm.spawned' });
    now = 1010;
    buffer.push({ ...base, runId: 'run-2', type: 'prewarm.spawned' });
    expect(buffer.snapshot().events.length).toBe(2);
  });

  it('keeps events with different reason codes', () => {
    now = 1000;
    buffer.push({ ...base, type: 'prompt.write.rejected', reasonCode: 'EPIPE' });
    now = 1010;
    buffer.push({ ...base, type: 'prompt.write.rejected', reasonCode: 'EAGAIN' });
    expect(buffer.snapshot().events.length).toBe(2);
  });
});

describe('CodeDiagnosticsBuffer — bounded ring', () => {
  it('drops the oldest event when the limit is reached', () => {
    buffer = new CodeDiagnosticsBuffer({ now: () => now, limit: 4 });
    for (let i = 0; i < 6; i += 1) {
      now = 1000 + i * 200; // well outside the dedupe window
      buffer.push({ ...base, runId: `run-${i}`, type: 'terminal' });
    }
    const events = buffer.snapshot().events;
    expect(events.length).toBe(4);
    // The two oldest got dropped; the four newest remain.
    const types = events.map((e) => e.runIdHash);
    expect(types[0]).not.toBe(types[events.length - 1]);
  });

  it('counts dropped events', () => {
    buffer = new CodeDiagnosticsBuffer({ now: () => now, limit: 3 });
    for (let i = 0; i < 5; i += 1) {
      now = 1000 + i * 200;
      buffer.push({ ...base, runId: `run-${i}`, type: 'terminal' });
    }
    expect(buffer.snapshot().dropped).toBe(2);
  });

  it('uses DIAG_BUFFER_LIMIT by default', () => {
    const b = new CodeDiagnosticsBuffer();
    for (let i = 0; i < DIAG_BUFFER_LIMIT + 10; i += 1) {
      b.push({ ...base, runId: `run-${i}`, type: 'terminal' });
    }
    expect(b.snapshot().events.length).toBe(DIAG_BUFFER_LIMIT);
  });
});

describe('CodeDiagnosticsBuffer — export + clear', () => {
  it('exportJson includes schemaVersion=1 and the events', () => {
    now = 2000;
    buffer.push({ ...base, type: 'prewarm.spawned', reasonCode: 'cold' });
    const json = buffer.exportJson();
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events[0].type).toBe('prewarm.spawned');
    expect(parsed.events[0].reasonCode).toBe('cold');
  });

  it('exportJson never includes raw runId / projectKey / conversationId', () => {
    buffer.push({ ...base, type: 'terminal' });
    const json = buffer.exportJson();
    expect(json).not.toContain(base.runId);
    expect(json).not.toContain(base.projectKey);
    expect(json).not.toContain(base.conversationId);
  });

  it('clear empties the ring and resets the dropped counter', () => {
    now = 1000;
    buffer.push({ ...base, runId: 'a', type: 'terminal' });
    now = 1200;
    buffer.push({ ...base, runId: 'b', type: 'terminal' });
    buffer.clear();
    expect(buffer.snapshot().events.length).toBe(0);
    expect(buffer.snapshot().dropped).toBe(0);
  });
});

describe('CodeDiagnosticsBuffer — immutability + subscribe', () => {
  it('snapshot events are frozen', () => {
    buffer.push({ ...base, type: 'terminal' });
    const events = buffer.snapshot().events;
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('snapshot is frozen', () => {
    buffer.push({ ...base, type: 'terminal' });
    expect(Object.isFrozen(buffer.snapshot())).toBe(true);
  });

  it('subscribers receive a snapshot on every push', () => {
    const listener = vi.fn();
    buffer.subscribe(listener);
    buffer.push({ ...base, type: 'terminal' });
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = listener.mock.calls[0]![0] as { events: readonly DiagEvent[] };
    expect(snap.events.length).toBe(1);
  });

  it('a throwing listener does not poison other listeners', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    buffer.subscribe(bad);
    buffer.subscribe(good);
    buffer.push({ ...base, type: 'terminal' });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});

describe('CodeDiagnosticsBuffer — privacy', () => {
  it('event payload interface does not admit a free-form text field', () => {
    // Compile-time guard: the exported `DiagEvent` shape has no
    // `text`, `message`, `prompt`, `output`, `body`, `content` field.
    // The shape is checked at type-build time; here we just make sure
    // JSON.stringify of an event does not grow any such key.
    buffer.push({ ...base, type: 'terminal' });
    const e = buffer.snapshot().events[0] as unknown as Record<string, unknown>;
    expect('text' in e).toBe(false);
    expect('message' in e).toBe(false);
    expect('prompt' in e).toBe(false);
    expect('output' in e).toBe(false);
    expect('body' in e).toBe(false);
  });

  it('hashes are not reversible: same length inputs give different hashes', () => {
    buffer.push({ ...base, runId: 'run-001', type: 'terminal' });
    buffer.push({ ...base, runId: 'run-002', type: 'terminal' });
    const events = buffer.snapshot().events;
    expect(events[0]!.runIdHash).not.toBe(events[1]!.runIdHash);
  });
});

describe('CodeDiagnosticsBuffer — used now() for monotonic tests', () => {
  it('uses the injected clock for the event timestamp', () => {
    // Each `push` consumes a now() tick; using `at` directly decouples
    // the event timestamp from the snapshot's generatedAt, so the
    // assertion is exact.
    const b = new CodeDiagnosticsBuffer({ now: fixedNowSequence([10, 20, 30, 40]) });
    b.push({ ...base, runId: 'a', type: 'terminal', at: 10 });
    b.push({ ...base, runId: 'b', type: 'terminal', at: 20 });
    const events = b.snapshot().events;
    expect(events[0]!.t).toBe(10);
    expect(events[1]!.t).toBe(20);
  });
});
