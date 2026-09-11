// PR-5 (§4.4) H2/P2-3 回归：终态后的迟到 Work 事件必须真的产出 Evidence，
// 且以稳定 sourceHash 幂等（重复摄入不叠加）。
//
// P1-2 背景：ingestLateEvent 建好后全仓零调用——promote 落在终态之后，
// 走 recordEvent(closedTrace) 只是回写 userEvents，从不抽 Evidence。此文件
// 锁住两条合同：(1) ingestLateEvent 直接产出 work 通道 Evidence；
// (2) 同一事件（traceId+eventType+text+dedupKey）重复摄入返回同一 id，
// evidence 不增长 —— 时间戳不得掺入哈希。

import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function runtimeWithCompletedWorkTrace() {
  const runtime = createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
  });
  const opened = runtime.openTrace({
    sessionId: 'w1',
    turnId: 'tw1',
    workspaceRoot: 'C:/work/demo-ws',
    product: 'work',
    prompt: '帮我做一份周报',
  });
  runtime.closeTrace(opened.id, 'completed', 'wrote report');
  const before = runtime.snapshot();
  return { runtime, traceId: opened.id, evidenceCount: before.evidence.length };
}

describe('ingestLateEvent (closed trace, H2)', () => {
  it('writes a NEW work-channel Evidence row for a late promote', () => {
    const { runtime, traceId, evidenceCount } = runtimeWithCompletedWorkTrace();
    const id = runtime.ingestLateEvent({
      traceId,
      eventType: 'choice',
      text: '提升产物 周报.pptx',
      claim: '用户把产物「周报.pptx」提升为正式交付件，倾向保留可复用的工作结果。',
      structured: { kind: 'artifact_promote', fileName: '周报.pptx' },
    });
    expect(id).not.toBeNull();
    const snap = runtime.snapshot();
    expect(snap.evidence.length).toBe(evidenceCount + 1);
    const ev = snap.evidence.find((e) => e.id === id);
    expect(ev).toBeTruthy();
    expect(ev!.origin.channel).toBe('work');
    expect(ev!.origin.stage).toBe('post_outcome');
    // §4.4: the late row carries the closed trace's identity.
    expect(ev!.source.traceId).toBe(traceId);
  });

  it('returns null for an unknown trace', () => {
    const { runtime } = runtimeWithCompletedWorkTrace();
    expect(runtime.ingestLateEvent({
      traceId: 'tr-nonexistent',
      eventType: 'choice',
      text: '提升产物',
      claim: 'x',
    })).toBeNull();
  });

  it('is idempotent: the same event twice returns the same id and stacks nothing (P2-3)', () => {
    const { runtime, traceId, evidenceCount } = runtimeWithCompletedWorkTrace();
    const input = {
      traceId,
      eventType: 'explicit_statement' as const,
      text: '把这份做成模板',
      claim: '用户要求将当前交付件做成模板，适用于重复性场景。',
      structured: { kind: 'template_request' },
      dedupKey: 'template:abc',
    };
    const first = runtime.ingestLateEvent(input);
    const second = runtime.ingestLateEvent(input);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(runtime.snapshot().evidence.length).toBe(evidenceCount + 1);
  });

  it('sourceHash is stable across wall-clock (no timestamp in the hash, P2-3)', () => {
    const { runtime, traceId } = runtimeWithCompletedWorkTrace();
    const base = {
      traceId,
      eventType: 'choice' as const,
      text: '提升产物 报告.docx',
      claim: '用户把当前产物提升为正式交付件。',
      dedupKey: 'promote:p1:报告.docx',
    };
    // Two ingestions far apart in wall-clock time must hash identically —
    // the OLD code hashed `String(now)` in, so different `now` values
    // produced two different rows.
    const first = runtime.ingestLateEvent({ ...base, structured: { packageId: 'p1' } });
    const ev1 = runtime.snapshot().evidence.find((e) => e.id === first);
    const second = runtime.ingestLateEvent({ ...base, structured: { packageId: 'p1' } });
    expect(second).toBe(first);
    const ev2 = runtime.snapshot().evidence.find((e) => e.id === second);
    expect(ev2!.source.sourceHash).toBe(ev1!.source.sourceHash);
  });

  it('a different dedupKey (or none) is a distinct event', () => {
    const { runtime, traceId, evidenceCount } = runtimeWithCompletedWorkTrace();
    const base = {
      traceId,
      eventType: 'choice' as const,
      text: '提升产物 报告.docx',
      claim: '用户把当前产物提升为正式交付件。',
    };
    const a = runtime.ingestLateEvent({ ...base, dedupKey: 'promote:p1' });
    const b = runtime.ingestLateEvent({ ...base, dedupKey: 'promote:p2' });
    expect(a).not.toBe(b);
    expect(runtime.snapshot().evidence.length).toBe(evidenceCount + 2);
  });

  it('recordEvent on a closed trace produces NO evidence (pins why the late path exists, P1-2)', () => {
    const { runtime, traceId, evidenceCount } = runtimeWithCompletedWorkTrace();
    // The pre-fix promote path: recordEvent onto the CLOSED trace. It only
    // re-appends the user event into the persisted trace — no extraction.
    runtime.recordEvent(traceId, {
      at: Date.now(),
      actor: 'user',
      type: 'choice',
      stage: 'post_outcome',
      text: '提升产物 周报.pptx',
      structured: { kind: 'artifact_promote', fileName: '周报.pptx' },
    });
    expect(runtime.snapshot().evidence.length).toBe(evidenceCount);
  });
});
