// learning-trigger.ts：隐式学习的触发条件与失败隔离（spec §7.6）。

import { describe, it, expect, vi } from 'vitest';

import type { CodeRunLifecycleObserver } from '../runtime/code-run-lifecycle';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { LearningPort } from './learning-port';
import { createLearningTriggerObserver, type LearningTriggerConfig } from './learning-trigger';

const SCOPE = {
  projectKey: 'ws-1',
  projectRoot: 'd:/repo',
  conversationId: 'sess-1',
  mode: 'code',
  runId: 'run-1',
  turnId: 'turn-1',
  startedAt: 1,
} as never;

const CONFIG: LearningTriggerConfig = {
  enabled: true,
  cli: { cliPath: 'd:/cli/trylo.js', cwd: 'd:/repo', apiModel: 'claude-sonnet-4' },
};

function record(): ConversationRecord {
  return {
    session: { id: 'sess-1', title: 'Demo', kind: 'code', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1 } as never,
    messages: [
      { id: 'u1', role: 'user', kind: 'text', text: 'fix the bug', createdAt: 1, turnId: 'turn-1' },
      { id: 'tool-1', toolCallId: 'call-1', role: 'assistant', kind: 'tool', tool: 'Bash', summary: 'Run npm test', status: 'done', createdAt: 1, turnId: 'turn-1' },
      { id: 'a1', role: 'assistant', kind: 'text', text: 'fixed it', createdAt: 2, turnId: 'turn-1' },
    ] as never,
    draft: '',
  };
}

function port() {
  return {
    reviewImplicit: vi.fn(async () => ({ ok: true, status: 'ok', candidateId: 'c1' })),
  } as unknown as LearningPort & { reviewImplicit: ReturnType<typeof vi.fn> };
}

function build(overrides: {
  port?: () => LearningPort | null;
  resolve?: () => unknown;
  config?: () => LearningTriggerConfig | null;
  log?: (m: string) => void;
  allowReview?: () => boolean;
}): CodeRunLifecycleObserver {
  return createLearningTriggerObserver({
    port: overrides.port ?? (() => port()),
    resolve: overrides.resolve as never ?? (() => ({ record: record(), workspacePath: 'd:/repo' })),
    config: overrides.config ?? (() => CONFIG),
    log: overrides.log,
    ...(overrides.allowReview ? { allowReview: overrides.allowReview } : {}),
  });
}

describe('createLearningTriggerObserver', () => {
  it('triggers a review for a completed turn and passes evidence only', async () => {
    const learning = port();
    const trigger = build({ port: () => learning });
    await trigger.onRunTerminal(SCOPE, 'completed');

    expect(learning.reviewImplicit).toHaveBeenCalledTimes(1);
    const params = learning.reviewImplicit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.workspaceRoot).toBe('d:/repo');
    expect(params.sessionId).toBe('sess-1');
    expect(params.turnId).toBe('turn-1');
    expect(params.resultText).toBe('fixed it');
    expect(params.taskGoal).toBe('fix the bug');
    expect(params.events).toEqual([{
      id: 'call-1',
      category: 'command',
      title: 'Run npm test',
      status: 'done',
    }]);
  });

  it('does not start a Hermes review when the dual-plane gate says no', async () => {
    const learning = port();
    const trigger = build({ port: () => learning, allowReview: () => false });
    await trigger.onRunTerminal(SCOPE, 'completed');
    expect(learning.reviewImplicit).not.toHaveBeenCalled();
  });

  it('does NOT trigger for cancelled or failed runs', async () => {
    const learning = port();
    const trigger = build({ port: () => learning });
    await trigger.onRunTerminal(SCOPE, 'cancelled');
    await trigger.onRunTerminal(SCOPE, 'failed');
    expect(learning.reviewImplicit).not.toHaveBeenCalled();
  });

  it('stays quiet when learning is disabled or the CLI is not configured', async () => {
    const learning = port();
    await build({ port: () => learning, config: () => ({ ...CONFIG, enabled: false }) })
      .onRunTerminal(SCOPE, 'completed');
    await build({ port: () => learning, config: () => null })
      .onRunTerminal(SCOPE, 'completed');
    await build({ port: () => learning, config: () => ({ enabled: true, cli: { cliPath: '', cwd: '' } }) })
      .onRunTerminal(SCOPE, 'completed');
    expect(learning.reviewImplicit).not.toHaveBeenCalled();
  });

  it('skips a turn that produced no answer (nothing to learn from)', async () => {
    const learning = port();
    const trigger = build({
      port: () => learning,
      resolve: () => ({
        record: {
          session: { id: 'sess-1', title: 'Demo', kind: 'code', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1 },
          messages: [{ id: 'u1', role: 'user', kind: 'text', text: 'hi', createdAt: 1, turnId: 'turn-1' }],
          draft: '',
        },
        workspacePath: 'd:/repo',
      }),
    });
    await trigger.onRunTerminal(SCOPE, 'completed');
    expect(learning.reviewImplicit).not.toHaveBeenCalled();
  });

  it('never throws when the port is missing, the record is gone, or the review fails', async () => {
    const logged: string[] = [];
    // The hook is synchronous and detached by design: it must never make the
    // run's terminal hook reject.
    expect(() => build({ port: () => null, log: (m) => logged.push(m) }).onRunTerminal(SCOPE, 'completed')).not.toThrow();
    expect(() => build({ resolve: () => null }).onRunTerminal(SCOPE, 'completed')).not.toThrow();

    const failing = { reviewImplicit: async () => { throw new Error('shadow run failed'); } } as unknown as LearningPort;
    const trigger = build({ port: () => failing, log: (m) => logged.push(m) });
    expect(() => trigger.onRunTerminal(SCOPE, 'completed')).not.toThrow();
    // The rejection is caught by the detached handler.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged.some((m) => m.includes('shadow run failed'))).toBe(true);
  });

  it('never throws when resolve fails', async () => {
    const logged: string[] = [];
    const trigger = build({
      resolve: () => { throw new Error('history gone'); },
      log: (m) => logged.push(m),
    });
    expect(() => trigger.onRunTerminal(SCOPE, 'completed')).not.toThrow();
    expect(logged[0]).toContain('history gone');
  });

  it('derives office mode from a Work record and forwards fileHints', async () => {
    const learning = port();
    const workRecord = record();
    (workRecord.session as { kind: string; mode: string }).kind = 'work';
    (workRecord.session as { mode: string }).mode = 'office';
    const trigger = createLearningTriggerObserver({
      port: () => learning,
      resolve: () => ({ record: workRecord, workspacePath: 'd:/repo' }),
      config: () => CONFIG,
      fileHints: () => ['.trylo/out/周报.pptx'],
    });
    await trigger.onRunTerminal(SCOPE, 'completed');
    expect(learning.reviewImplicit).toHaveBeenCalledTimes(1);
    const params = learning.reviewImplicit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.mode).toBe('office');
    expect(params.fileHints).toEqual(['.trylo/out/周报.pptx']);
  });

  it('keeps agent mode for a Code record', async () => {
    const learning = port();
    const codeRecord = record();
    (codeRecord.session as { kind: string; mode: string }).kind = 'code';
    (codeRecord.session as { mode: string }).mode = 'agent';
    const trigger = createLearningTriggerObserver({
      port: () => learning,
      resolve: () => ({ record: codeRecord, workspacePath: 'd:/repo' }),
      config: () => CONFIG,
    });
    await trigger.onRunTerminal(SCOPE, 'completed');
    const params = learning.reviewImplicit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.mode).toBe('agent');
  });
});
