// Trylo Desktop — companion projection table-driven tests (spec §6.3:
// 单一映射表，期望值来自老 WPF/bridge 协议词汇，不参考任何新实现).

import { describe, expect, it } from 'vitest';

import {
  AGENT_STATES,
  permissionRequestStatePayload,
  projectCodeBindingState,
  projectCodeOutcome,
  projectLoopEventToState,
  projectToolUseToState,
  workApprovalToPetRequest,
  type WorkApprovalItemLike,
} from './companion-projection';

describe('AGENT_STATES vocabulary', () => {
  it('pins the legacy AGENT_STATES strings exactly', () => {
    expect(AGENT_STATES).toEqual({
      idle: 'idle',
      thinking: 'thinking',
      planning: 'planning',
      writingFiles: 'writing_files',
      runningCommand: 'running_command',
      waitingOutput: 'waiting_output',
      programRunning: 'program_running',
      stalled: 'stalled',
      done: 'done',
      failed: 'failed',
    });
  });
});

describe('projectCodeBindingState (table)', () => {
  it('maps each binding state', () => {
    expect([
      projectCodeBindingState('spawning'),
      projectCodeBindingState('busy'),
      projectCodeBindingState('ready'),
      projectCodeBindingState('idle'),
      projectCodeBindingState('exited'),
    ]).toEqual(['planning', 'thinking', 'idle', 'idle', 'idle']);
  });
});

describe('projectToolUseToState (table)', () => {
  it('maps tool families to the legacy animation states', () => {
    expect(projectToolUseToState('Bash')).toBe('running_command');
    expect(projectToolUseToState('bash')).toBe('running_command');
    expect(projectToolUseToState('WebFetch')).toBe('thinking');
    expect(projectToolUseToState('Write')).toBe('writing_files');
    expect(projectToolUseToState('Edit')).toBe('writing_files');
    expect(projectToolUseToState('NotebookEdit')).toBe('writing_files');
    expect(projectToolUseToState('Grep')).toBe('thinking');
  });
});

describe('projectLoopEventToState (table)', () => {
  const base = { seq: 1, ts: 0 };
  it('refines the running state from loop events', () => {
    expect(projectLoopEventToState({ ...base, type: 'thinking', turn: 1, preview: '', summary: '', fullLength: 0 })).toBe('thinking');
    expect(projectLoopEventToState({ ...base, type: 'text', turn: 1, preview: '' })).toBe('thinking');
    expect(projectLoopEventToState({ ...base, type: 'tool_use', turn: 1, id: 't', tool: 'Bash', input: {} })).toBe('running_command');
    expect(projectLoopEventToState({ ...base, type: 'tool_use', turn: 1, id: 't', tool: 'Write', input: {} })).toBe('writing_files');
    expect(projectLoopEventToState({ ...base, type: 'tool_result', turn: 1, id: 't', tool: 'Bash', ok: true, output: '', durationMs: 1 })).toBe('thinking');
  });

  it('returns null for pet-irrelevant events', () => {
    expect(projectLoopEventToState({ ...base, type: 'session_start', sessionId: 's', model: 'm', cwd: '/x', permissionMode: 'default' })).toBeNull();
    expect(projectLoopEventToState({ ...base, type: 'todo_updated', todos: [] })).toBeNull();
  });
});

describe('projectCodeOutcome (table)', () => {
  it('maps the four terminal outcomes to bridge payloads', () => {
    expect(projectCodeOutcome('completed')).toEqual({ type: 'assistant' });
    expect(projectCodeOutcome('failed')).toEqual({ type: 'error', message: 'Code run failed' });
    expect(projectCodeOutcome('cancelled')).toEqual({ type: 'stopped' });
    expect(projectCodeOutcome('exited')).toEqual({ type: 'stopped' });
  });
});

describe('work approvals', () => {
  const pending: WorkApprovalItemLike = {
    kind: 'approval',
    approvalId: 'ap-1',
    type: 'bash',
    description: 'wants to run npm test',
    status: 'pending',
  };

  it('maps a pending approval to a pet request keyed by the approval id itself', () => {
    expect(workApprovalToPetRequest(pending)).toEqual({
      requestId: 'ap-1',
      title: 'bash',
      detail: 'wants to run npm test',
      description: 'wants to run npm test',
      category: 'edit',
      approvalState: 'pending',
    });
  });

  it('ignores resolved and auto-approved items', () => {
    expect(workApprovalToPetRequest({ ...pending, status: 'approved' })).toBeNull();
    expect(workApprovalToPetRequest({ ...pending, status: 'denied' })).toBeNull();
    expect(workApprovalToPetRequest({ ...pending, autoApproved: true })).toBeNull();
  });

  it('permissionRequestStatePayload carries the full set (empty clears)', () => {
    const requests = (workApprovalToPetRequest(pending) ? [workApprovalToPetRequest(pending)!] : []);
    expect(permissionRequestStatePayload(requests)).toEqual({ type: 'permissionRequestState', requests });
    expect(permissionRequestStatePayload([])).toEqual({ type: 'permissionRequestState', requests: [] });
  });
});

describe('workToolItemToState replaced by projectToolUseToState', () => {
  it('command-ish tools read as terminal, others as writing/thinking', () => {
    expect(projectToolUseToState('Bash')).toBe('running_command');
    expect(projectToolUseToState('Write')).toBe('writing_files');
  });
});
