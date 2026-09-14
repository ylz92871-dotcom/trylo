import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import { prepareLearningInteraction } from './learning-interaction-coordinator';

function runtime() {
  return createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
  });
}

describe('prepareLearningInteraction', () => {
  it('creates non-blocking Cognition under Shadow for a strong Code signal', () => {
    const rt = runtime();
    const result = prepareLearningInteraction(rt, {
      workspaceRoot: 'D:/project',
      conversationId: 'code-conversation',
      turnId: 'turn-1',
      product: 'code',
      prompt: '改一下持久化迁移，以后不要每次都加独立审核',
      baseSystemPrompt: 'base',
      settings: rt.settings(),
      hasPendingLearningUi: false,
    });

    expect(result.prepared.start).toBe('ready');
    expect(result.cognition?.product).toBe('code');
    expect(result.cognition?.conversationId).toBe('code-conversation');
    expect(result.cognition?.dimension).toBe('verification_audit');
  });

  it('routes Work signals to a Work Cognition session', () => {
    const rt = runtime();
    const result = prepareLearningInteraction(rt, {
      workspaceRoot: 'D:/project',
      conversationId: 'work-conversation',
      product: 'work',
      prompt: '帮我做周报，以后都先出一版完整稿再改',
      settings: rt.settings(),
      hasPendingLearningUi: false,
    });

    expect(result.cognition?.product).toBe('work');
    expect(result.cognition?.conversationId).toBe('work-conversation');
    expect(result.cognition?.dimension).toBe('work_artifact_workflow');
  });

  it('does not create a second Cognition when the conversation has pending learning UI', () => {
    const rt = runtime();
    const result = prepareLearningInteraction(rt, {
      workspaceRoot: 'D:/project',
      conversationId: 'code-conversation',
      product: 'code',
      prompt: '改一下持久化迁移，以后不要每次都加独立审核',
      settings: rt.settings(),
      hasPendingLearningUi: true,
    });

    expect(result.prepared.start).toBe('ready');
    expect(result.cognition).toBeUndefined();
    expect(rt.snapshot().cognitionSessions).toHaveLength(0);
  });

  it('does not ask an in-task learning question when collection is disabled for the trace', () => {
    const rt = runtime();
    const result = prepareLearningInteraction(rt, {
      workspaceRoot: 'D:/project',
      conversationId: 'private-conversation',
      turnId: 'turn-private',
      product: 'code',
      prompt: '改一下持久化迁移，以后不要每次都加独立审核',
      settings: rt.settings(),
      hasPendingLearningUi: false,
      learningDirective: {
        applyExistingPreferences: true,
        collectNewLearning: false,
        retention: 'normal',
      },
    });

    expect(result.prepared.start).toBe('ready');
    expect(result.cognition).toBeUndefined();
    expect(rt.snapshot().cognitionSessions).toHaveLength(0);
  });
});
