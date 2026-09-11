import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { extractEvidenceFromTrace } from './evidence';
import { eventFromArtifact, eventFromLeaseGrant, eventFromWorkStop } from './runtime';
import { claimForWorkText, dimensionForWorkText, isWorkPreferenceText } from './work-signals';
import type { UserDecisionEvent, UserDecisionTrace } from './types';

describe('Work preference language', () => {
  it('recognises deliverable, desktop, and look-and-feel utterances', () => {
    expect(isWorkPreferenceText('PPT 太花了，收成咨询风')).toBe(true);
    expect(isWorkPreferenceText('电脑低风险你自己点，账号先问我')).toBe(true);
    expect(isWorkPreferenceText('只要结论，过程别写')).toBe(true);
    expect(isWorkPreferenceText('帮我做一份周报')).toBe(false);
    expect(isWorkPreferenceText('做 PPT 先出一版再改')).toBe(true);
    expect(dimensionForWorkText('PPT 太花了')).toBe('product_ux_acceptance');
    expect(dimensionForWorkText('你自己点，别每步问')).toBe('tool_workflow');
    expect(claimForWorkText('只要结论，不要过程，报告给我产物就行')).toMatch(/结论/);
  });

  it('extracts Work prompt preferences from a trace', () => {
    const trace: UserDecisionTrace = {
      id: 'tr1',
      userId: 'local-user',
      sessionId: 'w1',
      taskId: 't1',
      turnId: 't1',
      workspaceId: 'ws',
      projectId: 'p',
      product: 'work',
      initialRequest: '帮我做周报',
      agentDecisions: [],
      userEvents: [{
        id: 'e1', at: 1, actor: 'user', type: 'user_message', stage: 'task_context',
        text: 'PPT 太花了，收成咨询风，只要结论',
      }],
      createdAt: 1,
    };
    const items = extractEvidenceFromTrace(trace, { workspaceId: 'ws', projectId: 'p', product: 'work', scopeTags: ['work'] });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.origin.channel).toBe('work');
    expect(items[0]!.inference.claim).toMatch(/观感|结论|克制/);
  });

  it('plain Work task prompts without preference language stay empty', () => {
    const trace: UserDecisionTrace = {
      id: 'tr2',
      userId: 'local-user',
      sessionId: 'w1',
      taskId: 't1',
      turnId: 't1',
      workspaceId: 'ws',
      projectId: 'p',
      product: 'work',
      initialRequest: '帮我整理一下这个表格',
      agentDecisions: [],
      userEvents: [{
        id: 'e1', at: 1, actor: 'user', type: 'user_message', stage: 'task_context',
        text: '帮我整理一下这个表格',
      }],
      createdAt: 1,
    };
    expect(extractEvidenceFromTrace(trace, { workspaceId: 'ws', projectId: 'p', product: 'work', scopeTags: ['work'] })).toEqual([]);
  });

  it('artifact promote, lease grant, and Work stop become Evidence', () => {
    const events: UserDecisionEvent[] = [
      { id: 'a1', ...eventFromArtifact({ action: 'promote', fileName: '周报.pptx' }), at: 1 },
      { id: 'a2', ...eventFromLeaseGrant({ kind: 'windows-screen' }), at: 2 },
      { id: 'a3', ...eventFromWorkStop(3), at: 3 },
    ];
    const trace: UserDecisionTrace = {
      id: 'tr3',
      userId: 'local-user',
      sessionId: 'w1',
      taskId: 't1',
      turnId: 't1',
      workspaceId: 'ws',
      projectId: 'p',
      product: 'work',
      initialRequest: '做周报',
      agentDecisions: [],
      userEvents: events,
      createdAt: 1,
    };
    const items = extractEvidenceFromTrace(trace, { workspaceId: 'ws', projectId: 'p', product: 'work', scopeTags: ['work'] });
    expect(items.length).toBe(3);
    expect(items.some((e) => /交付件/.test(e.inference.claim))).toBe(true);
    expect(items.some((e) => /屏幕/.test(e.inference.claim))).toBe(true);
    expect(items.some((e) => /停止/.test(e.inference.claim))).toBe(true);
  });

  it('Work traces close into snapshot Evidence', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    const opened = runtime.openTrace({
      sessionId: 'w1', turnId: 'tw', workspaceRoot: 'C:/work/demo-ws', product: 'work',
      prompt: '电脑低风险你自己点，账号路径先问我',
    });
    runtime.recordEvent(opened.id, eventFromArtifact({ action: 'promote', fileName: '报告.pptx' }));
    runtime.closeTrace(opened.id, 'completed', 'wrote report');
    const snap = runtime.snapshot();
    expect(snap.traces[0]?.product).toBe('work');
    expect(snap.evidence.some((e) => e.origin.channel === 'work')).toBe(true);
    expect(snap.evidence.length).toBeGreaterThanOrEqual(2);
  });
});
