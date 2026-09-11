// §2.2 / §3.2 / §3.3 / §6.2–6.3 测试：
//  in-task 纯 gap 不再触发；strong signal 命中即触发且维度正确；
//  conflict/drift 保留；day/week 硬顶；sweep→ignored；streak=2 → demote。

import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { askStreak } from './cognition';

function rt() {
  return createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
}

const STRONG_VERIFY = '改一下持久化迁移，以后不要每次都加独立审核';
const STRONG_AUTONOMY = '以后都别再自动做，先问我';

describe('trigger layer (§2.2)', () => {
  it('in-task pure gap no longer triggers (q_verify_scope regression counter-example)', () => {
    expect(rt().maybeCognitionPrompt({ prompt: '帮我改一下数据库迁移的表结构', product: 'code' })).toBeNull();
  });

  it('a strong verification signal triggers explicit_signal with the right dimension', () => {
    const q = rt().maybeCognitionPrompt({ prompt: STRONG_VERIFY, product: 'code' });
    expect(q).not.toBeNull();
    expect(q!.trigger).toBe('explicit_signal');
    expect(q!.dimension).toBe('verification_audit');
  });

  it('a strong autonomy signal triggers agent_autonomy', () => {
    const q = rt().maybeCognitionPrompt({ prompt: STRONG_AUTONOMY, product: 'code' });
    expect(q?.dimension).toBe('agent_autonomy');
  });
});

describe('frequency layer (§3.2)', () => {
  it('day cap: one proactive ask today suppresses a later proactive ask (different dimension)', () => {
    const runtime = rt();
    runtime.startCognition({
      id: 'q_autonomy', dimension: 'agent_autonomy', trigger: 'explicit_signal',
      prompt: '自主？', scopeHint: 'a',
    });
    expect(runtime.maybeCognitionPrompt({ prompt: STRONG_VERIFY, product: 'code' })).toBeNull();
  });

  it('non-proactive triggers (bootstrap) are NOT counted toward the proactive day cap', () => {
    const runtime = rt();
    runtime.startCognitionConversation('C:/work/demo-ws', 'code');
    // user_opened entries never enter the ask log → caps untouched.
    expect(runtime.snapshot().cognitionAskLog.every((e) => !['user_opened'].includes(e.trigger))).toBe(true);
    expect(runtime.maybeCognitionPrompt({ prompt: STRONG_VERIFY, product: 'code' })).not.toBeNull();
  });
});

describe('ignore demote (§3.3 / §3.1)', () => {
  it('startCognition writes a pending ask entry for proactive triggers', () => {
    const runtime = rt();
    runtime.startCognition({
      id: 'q_verify', dimension: 'verification_audit', trigger: 'explicit_signal',
      prompt: '验证？', scopeHint: 'v',
    });
    const entry = runtime.snapshot().cognitionAskLog[0];
    expect(entry?.outcome).toBe('pending');
    expect(entry?.trigger).toBe('explicit_signal');
  });

  it('sweep: two stale pending entries → ignored, then demoted (7d) and rewritten ignored_demoted', () => {
    const runtime = rt();
    runtime.seedFixture({
      cognitionAskLog: [
        { id: 'a1', dimension: 'verification_audit', trigger: 'explicit_signal', askedAt: 1, outcome: 'pending' },
        { id: 'a2', dimension: 'verification_audit', trigger: 'explicit_signal', askedAt: 2, outcome: 'pending' },
      ],
    });
    runtime.sweepIgnoredAsks();
    const snap = runtime.snapshot();
    const demote = snap.cognitionCooldowns.find((c) => c.dimension === 'verification_audit' && c.reason === 'demoted');
    expect(demote).toBeTruthy();
    expect(demote!.until - 2).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 2);
    const log = snap.cognitionAskLog.filter((e) => e.dimension === 'verification_audit');
    expect(log.filter((e) => e.outcome === 'ignored_demoted')).toHaveLength(2);
    // Idempotent: a second sweep must NOT add another demote.
    runtime.sweepIgnoredAsks();
    expect(runtime.snapshot().cognitionCooldowns.filter((c) => c.reason === 'demoted')).toHaveLength(1);
  });

  it('answerCognition overwrites the pending ask to answered (resets streak)', () => {
    const runtime = rt();
    const session = runtime.startCognition({
      id: 'q_verify', dimension: 'verification_audit', trigger: 'explicit_signal',
      prompt: '验证？', scopeHint: 'v',
    });
    runtime.answerCognition(session.id, '低风险直接做，核心路径保留最终验证。');
    expect(runtime.snapshot().cognitionAskLog.find((e) => e.id === session.id)?.outcome).toBe('answered');
  });

  it('askStreak counts trailing ignored and resets on answered/dismissed', () => {
    const base = { dimension: 'verification_audit' as const, trigger: 'explicit_signal' as const, askedAt: 1, resolvedAt: 2 };
    expect(askStreak([
      { ...base, id: 'a', outcome: 'ignored' },
      { ...base, id: 'b', outcome: 'ignored' },
    ], 'verification_audit')).toBe(2);
    expect(askStreak([
      { ...base, id: 'a', outcome: 'ignored' },
      { ...base, id: 'b', outcome: 'answered' },
    ], 'verification_audit')).toBe(0);
    expect(askStreak([
      { ...base, id: 'a', outcome: 'ignored_demoted' },
    ], 'verification_audit')).toBe(0);
  });
});