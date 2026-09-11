// Trylo Work — WorkContextAdapter unit tests.
//
// M4-C2 / M4-C3 (architecture doc §4.4 / §6.4; capability audit
// §5.4/5.5; test matrix §11.3). Covers:
//   - llm_usage.delta.inputTokens drives `used`, NOT totals;
//   - unknown model / missing usage renders as `—` (used undefined);
//   - compaction started / completed / failed projection;
//   - completed updates before/after/count;
//   - provider usage (priority 1) beats compaction estimate
//     (priority 2);
//   - restoreFromTaskGet (priority 3) survives refresh;
//   - extractWorkContextEvent pulls the right frames.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WorkContextAdapter,
  extractWorkContextEvent,
  DEFAULT_CONTEXT_WINDOW,
  type WorkContextEvent,
} from "../src/work-context-adapter.js";

function usage(over: Partial<WorkContextEvent> = {}): WorkContextEvent {
  return {
    taskId: "task-1",
    kind: "llm_usage",
    at: 1000,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    deltaInputTokens: 78_000,
    ...over,
  };
}

describe("WorkContextAdapter: llm_usage", () => {
  it("uses delta.inputTokens as used (never totals)", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume(usage());
    const snap = adapter.snapshot("task-1")!;
    assert.equal(snap.source, "provider_usage");
    assert.equal(snap.estimated, false);
    assert.equal(snap.usedTokens, 78_000);
    assert.equal(snap.contextWindowTokens, DEFAULT_CONTEXT_WINDOW);
    assert.ok(snap.ratio !== undefined);
    assert.equal(snap.ratio, 0.39);
    assert.equal(snap.modelId, "claude-sonnet-4-5");
    assert.equal(snap.compaction.state, "idle");
    assert.equal(snap.compaction.count, 0);
  });

  it("no delta → used stays undefined (render `—`)", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume(usage({ deltaInputTokens: undefined }));
    const snap = adapter.snapshot("task-1")!;
    assert.equal(snap.usedTokens, undefined);
    assert.equal(snap.ratio, undefined);
    assert.equal(snap.source, "unknown");
  });

  it("a negative / malformed delta degrades to `—`, not 0", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume(usage({ deltaInputTokens: -5 }));
    assert.equal(adapter.snapshot("task-1")!.usedTokens, undefined);
  });

  it("unknown model → no window, no % ratio (P2-2, never guesses 200k)", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume(usage({ model: "deepseek-v3-0324" }));
    const snap = adapter.snapshot("task-1")!;
    assert.equal(snap.usedTokens, 78_000);
    // Unknown model → contextWindowTokens undefined → ratio absent.
    assert.equal(snap.contextWindowTokens, undefined);
    assert.equal(snap.ratio, undefined);
  });

  it("snapshotOrEmpty returns an unknown snapshot when absent", () => {
    const adapter = new WorkContextAdapter();
    const empty = adapter.snapshotOrEmpty("nope");
    assert.equal(empty.source, "unknown");
    assert.equal(empty.usedTokens, undefined);
    assert.equal(empty.ratio, undefined);
    assert.equal(empty.compaction.count, 0);
  });
});

describe("WorkContextAdapter: compaction projection", () => {
  it("started → running with tokensBefore captured", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume({ taskId: "t", kind: "context_compaction_started", at: 200, tokensBefore: 180_000 });
    const compact = adapter.snapshot("t")!.compaction;
    assert.equal(compact.state, "running");
    assert.equal(compact.count, 0);
    assert.equal(compact.tokensBefore, 180_000);
  });

  it("completed → count+1 and before/after updated; used falls back to estimate", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume({ taskId: "t", kind: "context_compaction_completed", at: 300, tokensBefore: 180_000, tokensAfter: 86_000 });
    const snap = adapter.snapshot("t")!;
    assert.equal(snap.compaction.state, "completed");
    assert.equal(snap.compaction.count, 1);
    assert.equal(snap.compaction.tokensAfter, 86_000);
    assert.equal(snap.source, "compaction_event");
    assert.equal(snap.estimated, true);
    assert.equal(snap.usedTokens, 86_000);
  });

  it("failed → state failed + error, count unchanged", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume({ taskId: "t", kind: "context_compaction_started", at: 400 });
    adapter.consume({ taskId: "t", kind: "context_compaction_failed", at: 410, error: "ctx too big" });
    const compact = adapter.snapshot("t")!.compaction;
    assert.equal(compact.state, "failed");
    assert.equal(compact.count, 0);
    assert.equal(compact.error, "ctx too big");
  });

  it("provider usage (priority 1) beats a later compaction estimate", () => {
    const adapter = new WorkContextAdapter();
    adapter.consume(usage({ at: 500, deltaInputTokens: 40_000 })); // provider first
    adapter.consume({ taskId: "task-1", kind: "context_compaction_completed", at: 600, tokensAfter: 86_000 });
    const snap = adapter.snapshot("task-1")!;
    assert.equal(snap.source, "provider_usage");
    assert.equal(snap.estimated, false);
    assert.equal(snap.usedTokens, 40_000);
    // compaction still counted
    assert.equal(snap.compaction.count, 1);
  });
});

describe("WorkContextAdapter: task.get restore (priority 3)", () => {
  it("restores compaction count / lastAt / before / after after refresh", () => {
    const adapter = new WorkContextAdapter();
    adapter.restoreFromTaskGet("t", {
      compactionCount: 3,
      lastCompactionAt: 900,
      lastCompactionTokensBefore: 180_000,
      lastCompactionTokensAfter: 86_000,
    }, 950);
    const snap = adapter.snapshot("t")!;
    assert.equal(snap.compaction.count, 3);
    assert.equal(snap.compaction.lastAt, 900);
    assert.equal(snap.compaction.tokensAfter, 86_000);
    // No live provider report yet → used stays `—` (source unknown).
    assert.equal(snap.usedTokens, undefined);
    assert.equal(snap.source, "unknown");
  });

  it("no metadata → snapshot stays absent (does not invent data)", () => {
    const adapter = new WorkContextAdapter();
    adapter.restoreFromTaskGet("t", {}, 950);
    assert.equal(adapter.snapshot("t"), undefined);
  });
});

describe("extractWorkContextEvent", () => {
  it("pulls llm_usage from a task.event frame with delta only", () => {
    // Fixture anchored to the REAL vendor payload shape (P1-1):
    // SessionRuntime emits `llm_usage { providerType, modelId, delta }`
    // — NOT `model` / `provider`. This test would fail (modelId
    // undefined) on the pre-fix adapter, proving the field mapping.
    // Source: work/vendor/cowork-os/src/electron/agent/runtime/
    //         __tests__/SessionRuntime.test.ts L455-474.
    const ev = extractWorkContextEvent({
      event: "task.event",
      payload: {
        taskId: "t1",
        type: "llm_usage",
        modelId: "claude-sonnet-4",
        providerType: "anthropic",
        delta: { inputTokens: 1200, outputTokens: 300, cachedTokens: 40 },
      },
    });
    assert.ok(ev);
    assert.equal(ev!.kind, "llm_usage");
    assert.equal(ev!.deltaInputTokens, 1200);
    assert.equal(ev!.model, "claude-sonnet-4");
    assert.equal(ev!.provider, "anthropic");
  });

  it("extracts compaction completed with before / after", () => {
    const ev = extractWorkContextEvent({
      event: "task.event",
      payload: { taskId: "t2", type: "context_compaction_completed", tokensBefore: 180_000, tokensAfter: 86_000 },
    });
    assert.equal(ev!.kind, "context_compaction_completed");
    assert.equal(ev!.tokensBefore, 180_000);
    assert.equal(ev!.tokensAfter, 86_000);
  });

  it("maps compaction_failed.reason → event.error (P1-1)", () => {
    // Vendor shape: `context_compaction_failed { ..., reason }`
    // (SessionRuntime.ts L1675-1679). The pre-fix adapter read
    // `error`, which is never set in the real payload.
    const ev = extractWorkContextEvent({
      event: "task.event",
      payload: { taskId: "t3", type: "context_compaction_failed", reason: "ctx too big", tokensBefore: 180_000 },
    });
    assert.ok(ev);
    assert.equal(ev!.kind, "context_compaction_failed");
    assert.equal(ev!.error, "ctx too big");
  });

  it("totals.inputTokens is never read as used (P1-1 shape)", () => {
    const ev = extractWorkContextEvent({
      event: "task.event",
      payload: {
        taskId: "t4",
        type: "llm_usage",
        modelId: "claude-sonnet-4",
        providerType: "anthropic",
        delta: { inputTokens: 1200 },
        totals: { inputTokens: 999999, outputTokens: 42 },
      },
    });
    assert.ok(ev);
    assert.equal(ev!.deltaInputTokens, 1200);
    assert.notEqual(ev!.deltaInputTokens, 999999);
  });

  it("returns null for non-context frames / missing taskId", () => {
    assert.equal(extractWorkContextEvent({ event: "other", payload: {} }), null);
    assert.equal(extractWorkContextEvent({ event: "task.event", payload: { type: "llm_usage" } }), null);
    assert.equal(extractWorkContextEvent({ event: "task.event", payload: { taskId: "x", type: "timeline_step_updated" } }), null);
  });

  it("subscribe fires on consume and unsubscribes", () => {
    const adapter = new WorkContextAdapter();
    let calls = 0;
    const unsub = adapter.subscribe(() => calls++);
    adapter.consume(usage());
    assert.equal(calls, 1);
    unsub();
    adapter.consume(usage({ at: 2000 }));
    assert.equal(calls, 1);
  });
});