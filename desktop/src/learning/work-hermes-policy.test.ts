// work-hermes-policy.ts：Work 表面 Hermes 双平面闸门（TRYLO-DUAL-SURFACE-SPEC §2.3/§2.4）。

import { describe, it, expect } from 'vitest';

import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { ChatMessage } from '../components/chat/types';
import type { TryloSettings } from '../settings/settings-store';
import {
  allowHermesReview,
  deriveReviewMode,
  pendingBlockingInterrupt,
  workHermesEnabled,
} from './work-hermes-policy';

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    session: {
      id: 'sess-1',
      title: 'Demo',
      kind: overrides.session?.kind ?? 'work',
      mode: overrides.session?.mode ?? 'office',
      createdAt: 1,
      updatedAt: 2,
      turnCount: 1,
    } as unknown as ConversationRecord['session'],
    messages: [],
    draft: '',
    ...overrides,
  };
}

function messages(...kinds: ChatMessage['kind'][]): ChatMessage[] {
  return kinds.map((kind, i) => ({
    id: `m${i}`,
    role: 'assistant',
    kind,
    status: 'pending',
    createdAt: 1,
  }) as unknown as ChatMessage);
}

function settings(overrides: Partial<TryloSettings> = {}): TryloSettings {
  return {
    apiKey: '',
    apiHost: '',
    apiModel: '',
    poolModel: '',
    apiFormat: 'anthropic',
    apiKeyHeader: '',
    apiKeyPrefix: '',
    extraHeadersText: '{}',
    providerId: '',
    systemPrompt: '',
    permissionMode: 'agent',
    permissionLevel: 'workspace_write',
    vision: {} as TryloSettings['vision'],
    summary: {} as TryloSettings['summary'],
    companion: { enabled: true },
    remote: {} as TryloSettings['remote'],
    workBrowserDebug: false,
    workCad: false,
    hermesWorkLearning: true,
    cliPath: '',
    workspace: 'd:/repo',
    userLearning: {
      enabled: true,
      defaultMode: 'shadow',
      dimensionMode: {},
      cognitionEnabled: true,
      inference: { mode: 'deterministic', enabled: false, allowExecutionContext: false, maxCallsPerHour: 1, maxCallsPerTrace: 0 },
      teamAccessEnabled: false,
      teamComposerEnabled: false,
    },
    ...overrides,
  };
}

describe('deriveReviewMode', () => {
  it('maps a Work conversation to office', () => {
    expect(deriveReviewMode(record())).toBe('office');
  });

  it('maps a Code conversation (agent session mode) to agent', () => {
    expect(deriveReviewMode(record({ session: { id: 's', title: '', kind: 'code', mode: 'agent', createdAt: 1, updatedAt: 2, turnCount: 1 } as unknown as ConversationRecord['session'] })))
      .toBe('agent');
  });

  it('maps office session mode to office (spec formula wins over kind)', () => {
    // The frozen formula is `kind === 'work' || mode === 'office' ? 'office'
    // : 'agent'` — an office session mode is office regardless of kind.
    expect(deriveReviewMode(record({ session: { id: 's', title: '', kind: 'code', mode: 'office', createdAt: 1, updatedAt: 2, turnCount: 1 } as unknown as ConversationRecord['session'] })))
      .toBe('office');
  });
});

describe('workHermesEnabled', () => {
  it('allows Code regardless of the flag', () => {
    const code = record({ session: { id: 's', title: '', kind: 'code', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1 } as unknown as ConversationRecord['session'] });
    expect(workHermesEnabled(settings({ hermesWorkLearning: false }), code)).toBe(true);
    expect(workHermesEnabled(settings({ hermesWorkLearning: true }), code)).toBe(true);
  });

  it('turns Work off when the flag is false', () => {
    expect(workHermesEnabled(settings({ hermesWorkLearning: false }), record())).toBe(false);
  });

  it('defaults Work to ON when the settings are unknown', () => {
    expect(workHermesEnabled(settings({ hermesWorkLearning: true }), record())).toBe(true);
  });
});

describe('pendingBlockingInterrupt', () => {
  it('treats a pending learning_impact as blocking', () => {
    expect(pendingBlockingInterrupt(messages('learning_impact'))).toBe(true);
  });

  it('does NOT treat a pending cognition_prompt as blocking', () => {
    expect(pendingBlockingInterrupt(messages('cognition_prompt'))).toBe(false);
  });

  it('ignores resolved / absent cards', () => {
    const resolved = messages('learning_impact');
    (resolved[0] as { status?: string }).status = 'resolved';
    expect(pendingBlockingInterrupt(resolved)).toBe(false);
    expect(pendingBlockingInterrupt(messages('text'))).toBe(false);
  });
});

describe('allowHermesReview', () => {
  it('allows a clean Work review', () => {
    expect(allowHermesReview({ record: record(), settings: settings(), codeMode: 'agent' })).toBe(true);
  });

  it('blocks Work review when the flag is off', () => {
    expect(allowHermesReview({ record: record(), settings: settings({ hermesWorkLearning: false }), codeMode: 'agent' })).toBe(false);
  });

  it('does NOT skip Work review for a pending in-task Cognition card', () => {
    const r = record({ messages: messages('cognition_prompt') });
    expect(allowHermesReview({ record: r, settings: settings(), codeMode: 'agent' })).toBe(true);
  });

  it('skips Work review for a pending Impact card', () => {
    const r = record({ messages: messages('learning_impact') });
    expect(allowHermesReview({ record: r, settings: settings(), codeMode: 'agent' })).toBe(false);
  });

  it('skips Code review for the fifth mode itself', () => {
    const code = record({ session: { id: 's', title: '', kind: 'code', mode: 'cognition', createdAt: 1, updatedAt: 2, turnCount: 1 } as unknown as ConversationRecord['session'] });
    expect(allowHermesReview({ record: code, settings: settings(), codeMode: 'cognition' })).toBe(false);
  });

  it('Code review is unaffected by the Work flag', () => {
    const code = record({ session: { id: 's', title: '', kind: 'code', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1 } as unknown as ConversationRecord['session'] });
    expect(allowHermesReview({ record: code, settings: settings({ hermesWorkLearning: false }), codeMode: 'agent' })).toBe(true);
  });
});