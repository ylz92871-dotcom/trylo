// TRYLO-DUAL-SURFACE-SPEC §3.2/§3.4/§3.5: Cognition evidence is isolated per
// product — a Work interview (or a Work Impact resolution) writes Evidence
// into the Work domain, never the Code domain.

import { describe, it, expect } from 'vitest';
import { memoryRuntime } from './hardening-fixtures';

describe('Cognition product isolation', () => {
  it('maybeCognitionPrompt returns null for a Code greeting (in_task)', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const q = runtime.maybeCognitionPrompt({ prompt: '你好', product: 'code' });
    expect(q).toBeNull();
  });

  it('Work in-task strong signal routes to a Work question, never q_verify_scope', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    // "先出一版" carries work_artifact_workflow semantics → strong signal.
    const q = runtime.maybeCognitionPrompt({ prompt: '帮我做一份周报，直接先出一版再改', product: 'work' });
    expect(q).not.toBeNull();
    expect(['work_artifact_workflow', 'tool_workflow', 'product_ux_acceptance']).toContain(q!.dimension);
  });

  it('Code in-task verification-correcting strong signal asks the verification dimension', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    // "审核"+ "不要" 同句 → strong correction on verification_audit.
    const q = runtime.maybeCognitionPrompt({ prompt: '改一下持久化迁移，以后不要每次都加独立审核', product: 'code' });
    expect(q).not.toBeNull();
    expect(q!.dimension).toBe('verification_audit');
  });

  it('a Work fifth-mode session is stamped product=work and writes Work Evidence', async () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const session = runtime.startCognitionConversation('D:/proj', 'work');
    expect(session.product).toBe('work');

    const resolved = runtime.answerCognition(session.id, '报告先出一版再改就行');
    expect(resolved.evidenceIds.length).toBeGreaterThan(0);
    const ev = runtime.snapshot().evidence.find((item) => item.id === resolved.evidenceIds[0]);
    expect(ev?.context.product).toBe('work');
  });

  it('confirmCognitionScope fallback scope follows the session product (M2)', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const session = runtime.startCognition({
      id: 'q_work',
      dimension: 'product_ux_acceptance',
      trigger: 'high_value_gap',
      prompt: '成品怎样算过关？',
      scopeHint: 'work',
    }, 'D:/proj', 'work');
    // Force a pending scope confirmation by an over-broad answer.
    const r1 = runtime.answerCognition(session.id, '都按同一个标准，不用区分');
    expect(r1.followUp).toBe('confirm_scope');
    const result = runtime.confirmCognitionScope(session.id, true);
    const ev = runtime.snapshot().evidence.find((item) => item.id === result.evidenceIds[0]);
    expect(ev?.context.product).toBe('work');
  });

  it('recordImpactResolution honours the surface product (never hardcoded)', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const before = runtime.snapshot().evidence.length;
    runtime.recordImpactResolution({
      workspaceRoot: 'D:/proj',
      acceptPersonalization: false,
      reason: 'impact on work',
      product: 'work',
    });
    const newEvidence = runtime.snapshot().evidence.slice(before);
    expect(newEvidence.length).toBeGreaterThan(0);
    expect(newEvidence[0]!.context.product).toBe('work');
  });

  it('recordImpactResolution records Code only when Code is explicit', () => {
    const runtime = memoryRuntime({ cognitionEnabled: true });
    const before = runtime.snapshot().evidence.length;
    runtime.recordImpactResolution({
      workspaceRoot: 'D:/proj',
      acceptPersonalization: true,
      reason: 'code impact',
      product: 'code',
    });
    const newEvidence = runtime.snapshot().evidence.slice(before);
    expect(newEvidence[0]!.context.product).toBe('code');
  });
});
