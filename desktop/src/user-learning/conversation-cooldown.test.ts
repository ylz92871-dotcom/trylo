// §3.2 M4：per-conversation 6h 任务内卡硬顶（P2-5 回归）。
//
// 合同：
//  1. 上一张卡 resolve（followUp done）→ 写 `conversation:<id>` 冷却条目落
//     snapshot（跨重启生效），6h 内该会话不再弹卡（跨维度）。
//  2. dismiss 同样启动 6h 顶。
//  3. 顶只挡「同一会话」的任务内卡——第五模式、其他会话不受影响。
//  4. 键与 per-dimension 冷却不同构：`cooling(dimension)` 判定不看 key。

import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import {
  conversationCardCooling,
  conversationCooldownKey,
} from './cognition';

const QUESTION = {
  id: 'q_verify_scope',
  dimension: 'verification_audit' as const,
  trigger: 'high_value_gap' as const,
  prompt: '验证偏好？',
  scopeHint: 'v',
};

function runtime() {
  return createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
  });
}

describe('per-conversation 6h in-task card cap (M4)', () => {
  it('resolve writes a conversation:<id> cooldown entry into the snapshot', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-1');
    rt.answerCognition(session.id, '低风险直接做，核心路径保留最终验证。');
    const cooldowns = rt.snapshot().cognitionCooldowns;
    const entry = cooldowns.find((c) => c.key === conversationCooldownKey('conv-1'));
    expect(entry).toBeTruthy();
    const until = entry!.until;
    expect(until - Date.now()).toBeGreaterThan(5 * 60 * 60 * 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it('blocks a NEW card on the same conversation across dimensions for 6h', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-1');
    rt.answerCognition(session.id, '低风险直接做，核心路径保留最终验证。');
    // A different dimension's question must not insert into conv-1 now.
    expect(
      rt.maybeCognitionPrompt({ prompt: '帮我改一下数据库迁移的表结构', product: 'code', conversationId: 'conv-1' }),
    ).toBeNull();
    // ...and the pure gate helper agrees.
    expect(conversationCardCooling(rt.snapshot().cognitionCooldowns, 'conv-1', Date.now())).toBe(true);
  });

  it('does NOT block other conversations (cross-conversation isolation)', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-1');
    rt.answerCognition(session.id, '低风险直接做，核心路径保留最终验证。');
    // Another conversation is untouched (cross-conversation isolation).
    expect(conversationCardCooling(rt.snapshot().cognitionCooldowns, 'conv-2', Date.now())).toBe(false);
    // §3.1/§3.2: the ask above is a proactive entry (question reached
    // `conversation:<id>` cap → answered), so the GLOBAL day cap (≤1) now
    // suppresses further proactive questions earlier the same day — this is
    // the redesigned frequency behaviour, not a conversation-cap leak.
    expect(rt.snapshot().cognitionAskLog.some((e) => e.outcome === 'answered')).toBe(true);
    expect(
      rt.maybeCognitionPrompt({ prompt: '改一下持久化迁移，以后不要每次都加独立审核', product: 'code' }),
    ).toBeNull();
  });

  it('an open thread (confirm_scope follow-up) keeps the ask-time cap, then refreshes on resolve', () => {
    const rt = runtime();
    const first = rt.maybeCognitionPrompt({ prompt: '改一下持久化迁移，以后不要每次都加独立审核' })!;
    const session = rt.startCognition(first, 'C:/work/demo-ws', 'code', 'conv-1');
    const res = rt.answerCognition(session.id, '都直接做吧，不用再问我了，所有任务都是。');
    expect(res.followUp).toBe('confirm_scope');
    // Thread still open: the ask-time cap governs (a card WAS shown and is
    // unanswered), and the pending-card gate covers the visible surface.
    expect(conversationCardCooling(rt.snapshot().cognitionCooldowns, 'conv-1', Date.now())).toBe(true);
    // Confirming the scope resolves the thread → cap refreshed with the
    // user's signal (reason 'answered', fresh 6h from NOW).
    rt.confirmCognitionScope(session.id, true);
    const refreshed = rt.snapshot().cognitionCooldowns.find((c) => c.key === conversationCooldownKey('conv-1'))!;
    expect(refreshed.reason).toBe('answered');
    expect(refreshed.until).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
  });

  it('dismiss starts the 6h cap too', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-3');
    rt.dismissCognition(session.id, 'dismiss');
    expect(conversationCardCooling(rt.snapshot().cognitionCooldowns, 'conv-3', Date.now())).toBe(true);
  });

  it('the cap lives in the persisted snapshot shape (M4: 落 snapshot)', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-4');
    rt.answerCognition(session.id, '低风险直接做，核心路径保留最终验证。');
    const snap = rt.snapshot();
    // The entry is a plain CognitionCooldown in snapshot.cognitionCooldowns —
    // whatever persistence path the store uses covers it; no App-side ref.
    expect(
      snap.cognitionCooldowns.some((c) => c.key === conversationCooldownKey('conv-4')),
    ).toBe(true);
  });

  // ── P2-5 补充：'asked' 死代码修复 — 被无视的卡不得同题重弹 ──────────────

  it('asking itself writes both an asked cooldown and the conversation cap (P2-5)', () => {
    const rt = runtime();
    rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-5');
    const cooldowns = rt.snapshot().cognitionCooldowns;
    // Per-dimension 'asked' entry (reason was previously dead code).
    expect(cooldowns.some((c) => c.dimension === QUESTION.dimension && c.reason === 'asked')).toBe(true);
    // Per-conversation cap starts at ask time, not only at resolve time.
    expect(cooldowns.some((c) => c.key === conversationCooldownKey('conv-5') && c.reason === 'asked')).toBe(true);
  });

  it('an IGNORED card (never resolved/dismissed) cannot re-card the same question', () => {
    const rt = runtime();
    // Ask once; the card is then ignored (conversation switched / app
    // restarted / card swept away — no resolve, no dismiss).
    rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-6');
    // A later send on the same conversation must not resurrect the question:
    // the transient live-message check sees no pending card, so the
    // cooldowns are the ONLY defense. The per-dimension 'asked' gap blocks
    // the same question; the conversation cap blocks everything else.
    expect(
      rt.maybeCognitionPrompt({ prompt: '帮我改一下数据库迁移的表结构', product: 'code', conversationId: 'conv-6' }),
    ).toBeNull();
    expect(conversationCardCooling(rt.snapshot().cognitionCooldowns, 'conv-6', Date.now())).toBe(true);
  });

  it('resolve/dismiss overwrites the asked entries with the user signal', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws', 'code', 'conv-7');
    const askedAt = rt.snapshot().cognitionCooldowns.find(
      (c) => c.key === conversationCooldownKey('conv-7'),
    )!.until;
    rt.dismissCognition(session.id, 'dismiss');
    const entry = rt.snapshot().cognitionCooldowns.find(
      (c) => c.key === conversationCooldownKey('conv-7'),
    )!;
    // Exactly one conversation entry, and it now carries the dismiss signal
    // (a FRESH 6h window from the dismiss, not the leftover asked stamp).
    expect(entry.reason).toBe('dismiss');
    expect(entry.until).toBeGreaterThanOrEqual(askedAt);
    // No duplicate conversation entries accumulated.
    expect(
      rt.snapshot().cognitionCooldowns.filter((c) => c.key === conversationCooldownKey('conv-7')),
    ).toHaveLength(1);
  });

  it('asking without a conversation (fifth mode) writes only the dimension cooldown', () => {
    const rt = runtime();
    const session = rt.startCognition(QUESTION, 'C:/work/demo-ws');
    expect(
      rt.snapshot().cognitionCooldowns.some((c) => c.dimension === QUESTION.dimension && c.reason === 'asked'),
    ).toBe(true);
    expect(rt.snapshot().cognitionCooldowns.some((c) => c.reason === 'asked' && c.key !== undefined)).toBe(false);
    void session;
  });
});
