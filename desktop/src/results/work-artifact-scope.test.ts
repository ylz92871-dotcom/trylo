// Trylo Desktop — Work artifact event scope resolution tests (P2-1, spec
// §8.3; hardened by the 2026-08-27 final audit, P1-2).
//
// Pins the "fixed scope rule": the Work run registry binding is the ONLY
// ownership authority for an artifact event. The identity the event itself
// carries (conversationId / runId / turnId) is VALIDATION-ONLY — when both
// the event and the binding carry a field they must agree exactly, and the
// resolved scope takes every ownership field from the binding. A missing
// binding or any mismatch must DROP the event (the host surfaces a
// diagnostic); it must never project into an invented scope, and never fall
// back to "current workspace / current conversation".

import { describe, it, expect } from 'vitest';
import { TaskRegistry, type TaskRecord } from '@trylo/work';
import {
  resolveArtifactProjection,
  type WorkRunBinding,
} from './work-artifact-scope';
import { workspaceKey } from '../host-adapter/conversation-history';

const BINDING: WorkRunBinding = {
  projectRoot: 'D:/repo',
  conversationId: 'c-bound',
  runId: 'run:abc',
  taskId: 'task-x',
  turnId: 't-bound',
};

function bindingFor(binding: WorkRunBinding | undefined) {
  return (): WorkRunBinding | undefined => binding;
}

/** Resolve a happy-shaped event against a binding (test shorthand). */
function resolve(
  overrides: {
    taskId?: string;
    runId?: string;
    turnId?: string | undefined;
    conversationId?: string;
    binding?: WorkRunBinding | undefined;
  } = {},
) {
  return resolveArtifactProjection(
    overrides.taskId ?? 'task-x',
    overrides.runId ?? 'run:abc',
    'turnId' in overrides ? overrides.turnId : 't-bound',
    overrides.conversationId ?? 'c-bound',
    1000,
    'docs/plan.md',
    'document',
    'binding' in overrides ? bindingFor(overrides.binding) : bindingFor(BINDING),
  );
}

describe('resolveArtifactProjection (spec §8.3, audit P1-2)', () => {
  it('correct event happy path: every ownership field comes from the binding', () => {
    const res = resolve();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { scope } = res.projection;
    // All five identity levels resolve from the registry binding.
    expect(scope.projectKey).toBe(workspaceKey('D:/repo'));
    expect(scope.projectRoot).toBe('D:/repo');
    expect(scope.conversationId).toBe('c-bound');
    expect(scope.taskId).toBe('task-x');
    expect(scope.runId).toBe('run:abc');
    expect(scope.turnId).toBe('t-bound');
    expect(res.projection.rawPath).toBe('docs/plan.md');
  });

  it('drops on missing binding — never invents a scope', () => {
    const res = resolve({ taskId: 'task-unknown', binding: undefined });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('task-unknown');
  });

  it('drops on wrong conversation, even when run/task/turn all match', () => {
    const res = resolve({ conversationId: 'c-other' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('c-other');
    expect(res.droppedReason).toContain('c-bound');
  });

  it('drops when the event carries no conversationId to validate', () => {
    const res = resolve({ conversationId: '' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('no conversationId');
  });

  it('drops on wrong turn when both event and binding carry one', () => {
    const res = resolve({ turnId: 't-other' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('t-other');
    expect(res.droppedReason).toContain('t-bound');
  });

  it('event turnId is validation-only: the scope keeps the binding turnId', () => {
    // Same value on both sides is the only way an event turnId passes.
    const res = resolve({ turnId: 't-bound' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projection.scope.turnId).toBe('t-bound');
  });

  it('falls back to the binding turnId when the event has none', () => {
    const res = resolve({ turnId: undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projection.scope.turnId).toBe('t-bound');
  });

  it('drops when the event carries no runId to validate', () => {
    const res = resolve({ runId: '' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('no runId');
  });
});

// ── Registry-backed scenarios (audit P1-2) ────────────────────────────────
// Drive the resolver through a REAL TaskRegistry so the binding shape is the
// production one (TaskRecord structurally satisfies WorkRunBinding) and the
// stale/late-event cases reflect how follow-up re-binding actually happens.

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-x',
    runId: 'run:abc',
    turnId: 't-bound',
    delivery: 'create',
    workspaceId: 'ws-1',
    projectRoot: 'D:/repo',
    conversationId: 'c-bound',
    sessionId: 'c-bound',
    status: 'running',
    lastSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    terminalError: undefined,
    ...overrides,
  };
}

function registryGet(registry: TaskRegistry) {
  return (taskId: string): WorkRunBinding | undefined => registry.get(taskId);
}

describe('resolveArtifactProjection against a live TaskRegistry', () => {
  it('accepts an event validated by the registry binding', () => {
    const registry = new TaskRegistry();
    registry.register(makeRecord());
    const res = resolveArtifactProjection(
      'task-x', 'run:abc', 't-bound', 'c-bound', 1000, 'out/report.md', 'document',
      registryGet(registry),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projection.scope.conversationId).toBe('c-bound');
    expect(res.projection.scope.runId).toBe('run:abc');
  });

  it('stale task: an event emitted under the OLD run is dropped after re-binding', () => {
    const registry = new TaskRegistry();
    registry.register(makeRecord({ status: 'completed' }));
    // The same durable task starts a follow-up run with a NEW runId.
    registry.beginFollowUp({ taskId: 'task-x', runId: 'run:def', turnId: 't-next' });

    const stale = resolveArtifactProjection(
      'task-x', 'run:abc', 't-bound', 'c-bound', 1000, 'out/old.md', 'document',
      registryGet(registry),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.droppedReason).toContain('run:abc');
      expect(stale.droppedReason).toContain('run:def');
      expect(stale.droppedReason).toContain('stale run');
    }
  });

  it('late event from a previous run never pollutes the new run', () => {
    const registry = new TaskRegistry();
    registry.register(makeRecord({ status: 'completed' }));
    registry.beginFollowUp({ taskId: 'task-x', runId: 'run:def', turnId: 't-next' });

    // An event for the CURRENT run resolves under the new identity only.
    const current = resolveArtifactProjection(
      'task-x', 'run:def', 't-next', 'c-bound', 1000, 'out/new.md', 'document',
      registryGet(registry),
    );
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.projection.scope.runId).toBe('run:def');
    expect(current.projection.scope.turnId).toBe('t-next');

    // A late arrival from the superseded run is dropped, not merged.
    const late = resolveArtifactProjection(
      'task-x', 'run:abc', 't-bound', 'c-bound', 1000, 'out/old.md', 'document',
      registryGet(registry),
    );
    expect(late.ok).toBe(false);
  });

  it('wrong conversation against the registry binding is dropped', () => {
    const registry = new TaskRegistry();
    registry.register(makeRecord());
    const res = resolveArtifactProjection(
      'task-x', 'run:abc', 't-bound', 'c-attacker', 1000, 'out/x.md', 'document',
      registryGet(registry),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('c-attacker');
  });

  it('missing binding in the registry is dropped (no workspace fallback)', () => {
    const registry = new TaskRegistry();
    const res = resolveArtifactProjection(
      'task-ghost', 'run:abc', 't-bound', 'c-bound', 1000, 'out/x.md', 'document',
      registryGet(registry),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.droppedReason).toContain('task-ghost');
  });
});
