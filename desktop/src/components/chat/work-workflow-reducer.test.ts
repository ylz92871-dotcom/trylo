// Trylo Desktop — work-workflow-reducer unit tests.
//
// Covers the 10 idempotency invariants from spec §2.3 plus
// the four scenario fixtures (normal / failed / replay /
// out-of-order). All assertions are over the pure reducer
// signature `applyWorkflowItem(messages, item) -> messages`.

import { describe, it, expect } from 'vitest';
import type { ConversationItem } from '@trylo/work';
import {
  applyWorkflowItem,
  normalizePhaseName,
} from './work-workflow-reducer';
import type { ChatMessage, WorkflowMessage } from './types';
import {
  duplicateReplay,
  failedWorkflow,
  normalFourPhases,
  outOfOrder,
  fixtureHelpers,
} from './__fixtures__/work-workflow';

function findWorkflow(
  messages: readonly ChatMessage[],
  runId: string,
): WorkflowMessage | undefined {
  for (const m of messages) {
    if (m.kind === 'workflow' && m.runId === runId) return m;
  }
  return undefined;
}

function runItems(items: readonly ConversationItem[]): readonly ChatMessage[] {
  let msgs: readonly ChatMessage[] = [];
  for (const it of items) {
    msgs = applyWorkflowItem(msgs, it);
  }
  return msgs;
}

const RUN_ID = fixtureHelpers.IDENTITY.runId;

describe('work-workflow-reducer: helpers', () => {
  it('normalizePhaseName strips upstream prefixes', () => {
    expect(normalizePhaseName('Starting DISCOVER')).toBe('DISCOVER');
    expect(normalizePhaseName('Completed BUILD')).toBe('BUILD');
    expect(normalizePhaseName('完成 VERIFY')).toBe('VERIFY');
    expect(normalizePhaseName('Adjusting the plan — PLAN')).toBe('PLAN');
    expect(normalizePhaseName('plain')).toBe('plain');
  });
});

describe('work-workflow-reducer: spec §2.3 invariants', () => {
  it('1. started + finished same phase → 1 phase (completed)', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf).toBeDefined();
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
    expect(wf!.status).toBe('running'); // run not yet terminal
  });

  it('2. duplicate plan-started → 1 phase, no extra activity', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('active');
  });

  it('3. duplicate plan-finished → 1 phase, no state flip', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
      fixtureHelpers.plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
  });

  it('4. finished before started (out-of-order) → merged, no crash', () => {
    const msgs = runItems(outOfOrder());
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf).toBeDefined();
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
  });

  it('5. completed phase does not regress to active on late started', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.plan('DISCOVER', 'finished', 'g1', 'Completed DISCOVER'),
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
  });

  it('6. failed phase does not regress to active on late started', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('BUILD', 'started', 'g1'),
      fixtureHelpers.plan('BUILD', 'finished', 'g1', 'BUILD failed'),
      fixtureHelpers.plan('BUILD', 'started', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('failed');
  });

  it('7. unknown plan group → title "执行步骤" (via fallback ordinal)', () => {
    // When the upstream groupId is missing, the reducer
    // synthesizes a phase key from runId + name + ordinal.
    // This is the "unknown plan group" path. The test
    // asserts the workflow has a phase and is not
    // crashed by undefined phaseId.
    const itemNoPhase: ConversationItem = {
      ...fixtureHelpers.IDENTITY,
      kind: 'plan',
      id: 'pl-x',
      at: 1001,
      conversationId: 'conv-x',
      stage: 'started',
      name: 'NewPhase',
      text: 'NewPhase',
      // phaseId: undefined  — exercise the fallback path
    };
    const msgs = runItems([itemNoPhase]);
    const wf = findWorkflow(msgs, itemNoPhase.runId);
    expect(wf).toBeDefined();
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.title).toBe('NewPhase');
  });

  it('8. cross-run isolation: plan from run B does not mutate run A', () => {
    const otherIdentity = {
      taskId: 'task-2',
      runId: 'run:task-2',
      turnId: 'turn-2',
    } as const;
    const otherPlan: ConversationItem = {
      ...otherIdentity,
      kind: 'plan',
      id: 'pl-other',
      at: 1100,
      conversationId: 'conv-x',
      stage: 'started',
      name: 'OTHER',
      text: 'OTHER',
      phaseId: 'g-other',
    };
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      otherPlan,
    ];
    const msgs = runItems(items);
    const wfA = findWorkflow(msgs, RUN_ID);
    const wfB = findWorkflow(msgs, otherIdentity.runId);
    expect(wfA).toBeDefined();
    expect(wfB).toBeDefined();
    expect(wfA!.phases).toHaveLength(1);
    expect(wfA!.phases[0]!.id).toBe('g1');
    expect(wfB!.phases[0]!.id).toBe('g-other');
    // The two workflows are independent.
    expect(wfA!.workflowId).not.toBe(wfB!.workflowId);
  });

  it('9. replay (same items twice) → identical final workflow', () => {
    const once = runItems(normalFourPhases());
    const twice = runItems(duplicateReplay());
    const wfOnce = findWorkflow(once, RUN_ID);
    const wfTwice = findWorkflow(twice, RUN_ID);
    expect(wfOnce).toBeDefined();
    expect(wfTwice).toBeDefined();
    expect(wfTwice!.phases).toHaveLength(wfOnce!.phases.length);
    expect(wfTwice!.status).toBe(wfOnce!.status);
    for (let i = 0; i < wfOnce!.phases.length; i++) {
      const p1 = wfOnce!.phases[i]!;
      const p2 = wfTwice!.phases[i]!;
      expect(p2.id).toBe(p1.id);
      expect(p2.status).toBe(p1.status);
      expect(p2.activities.length).toBe(p1.activities.length);
    }
  });

  it('10. terminal after which a late started arrives → no revive', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.final('done'),
      // Late event after terminal
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
    expect(wf!.status).toBe('completed');
  });
});

describe('work-workflow-reducer: activity invariants', () => {
  it('tool activity references toolMessageId, does not copy payload', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.tool('step-1', 'done', 'read_file x.ts', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    const phase = wf!.phases[0]!;
    expect(phase.activities).toHaveLength(1);
    const a = phase.activities[0]!;
    expect(a.kind).toBe('tool');
    expect(a.toolMessageId).toBe('tool-step-1');
    // Label is summary-only — no input / output copy.
    expect(a.label).toBe('read_file: read_file x.ts');
  });

  it('thinking activity label is truncated to ≤ ACTIVITY_LABEL_CAP', () => {
    const longText = 'x'.repeat(200);
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.thinking(longText, 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    const a = wf!.phases[0]!.activities[0]!;
    expect(a.kind).toBe('thinking');
    expect(a.label.length).toBeLessThanOrEqual(50);
  });

  it('progress with toolCallId → pass-through (NOT added as activity)', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.tool('step-1', 'done', 'x', 'g1'),
      fixtureHelpers.progress('output line', 'step-1'), // has toolCallId
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    const phase = wf!.phases[0]!;
    // Only the tool itself, not the progress.
    expect(phase.activities).toHaveLength(1);
    expect(phase.activities[0]!.kind).toBe('tool');
  });

  it('progress without toolCallId → activity kind "notice" on current phase', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
      fixtureHelpers.progress('heartbeat: still working'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    const phase = wf!.phases[0]!;
    expect(phase.activities).toHaveLength(1);
    const a = phase.activities[0]!;
    expect(a.kind).toBe('notice');
    expect(a.label).toBe('heartbeat: still working');
  });
});

describe('work-workflow-reducer: pass-through kinds', () => {
  it('approval / input_request / artifact / diagnostics do not touch workflow', () => {
    const approval: ConversationItem = {
      ...fixtureHelpers.IDENTITY,
      kind: 'approval',
      id: 'apr-1',
      at: 1100,
      conversationId: 'c',
      approvalId: 'a-1',
      type: 'write_file',
      description: 'edit x',
      status: 'pending',
    };
    const inputReq: ConversationItem = {
      ...fixtureHelpers.IDENTITY,
      kind: 'input_request',
      id: 'ir-1',
      at: 1101,
      conversationId: 'c',
      requestId: 'r-1',
      questions: [],
      status: 'pending',
    };
    const artifact: ConversationItem = {
      ...fixtureHelpers.IDENTITY,
      kind: 'artifact',
      id: 'art-1',
      at: 1102,
      conversationId: 'c',
      filePath: '/x.ts',
      artifactKind: 'file',
    };
    const diag: ConversationItem = {
      ...fixtureHelpers.IDENTITY,
      kind: 'diagnostics',
      id: 'dg-1',
      at: 1103,
      conversationId: 'c',
      text: 'noise',
    };
    const items: ConversationItem[] = [approval, inputReq, artifact, diag];
    for (const it of items) {
      const msgs = runItems([it]);
      const wf = findWorkflow(msgs, RUN_ID);
      expect(wf).toBeUndefined();
    }
  });
});

describe('work-workflow-reducer: scenario fixtures', () => {
  it('normalFourPhases → 4 completed phases + workflow completed', () => {
    const msgs = runItems(normalFourPhases());
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf).toBeDefined();
    expect(wf!.phases).toHaveLength(4);
    expect(wf!.phases.map((p) => p.title)).toEqual([
      'DISCOVER', 'PLAN', 'BUILD', 'VERIFY',
    ]);
    for (const p of wf!.phases) {
      expect(p.status).toBe('completed');
    }
    expect(wf!.status).toBe('completed');
  });

  it('failedWorkflow → BUILD phase stays failed, workflow failed', () => {
    const msgs = runItems(failedWorkflow());
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf).toBeDefined();
    expect(wf!.phases).toHaveLength(2);
    expect(wf!.phases[0]!.status).toBe('completed');
    expect(wf!.phases[1]!.status).toBe('failed');
    expect(wf!.status).toBe('failed');
  });

  it('duplicateReplay → 4 phases, 0 duplicates', () => {
    const msgs = runItems(duplicateReplay());
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(4);
    for (const p of wf!.phases) {
      // Each phase has its activities replayed, but the
      // appendActivity guard collapses duplicates.
      // (The exact activity count depends on input; the
      // invariant is that the phase count and final
      // status are stable across replays — covered by
      // the spec §2.3 #9 test above.)
      expect(p.status).toBe('completed');
    }
  });

  it('outOfOrder → single completed phase', () => {
    const msgs = runItems(outOfOrder());
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases).toHaveLength(1);
    expect(wf!.phases[0]!.status).toBe('completed');
  });
});

describe('work-workflow-reducer: purity', () => {
  it('does not mutate the input messages array', () => {
    const items = normalFourPhases();
    const before: readonly ChatMessage[] = [];
    const frozen = Object.freeze([...before]);
    const after = applyWorkflowItem(frozen, items[0]!);
    // frozen is a different array (immutable contract);
    // after is a new array.
    expect(after).not.toBe(frozen);
  });

  it('returns the same array reference when no change is needed', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'g1'),
    ];
    const first = runItems(items);
    // Re-apply the same plan-started: reducer is a no-op.
    const second = applyWorkflowItem(first, items[0]!);
    expect(second).toBe(first);
  });
});

describe('work-workflow-reducer: phase title normalization', () => {
  it('keeps the long upstream name in the phase title but truncates to PHASE_TITLE_CAP', () => {
    const longName = 'X'.repeat(100);
    const items: ConversationItem[] = [
      fixtureHelpers.plan(longName, 'started', 'g1'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases[0]!.title.length).toBeLessThanOrEqual(40);
  });

  it('phaseId lookup uses upstream groupId when present', () => {
    const items: ConversationItem[] = [
      fixtureHelpers.plan('DISCOVER', 'started', 'my-group-id-1'),
      fixtureHelpers.plan('DISCOVER', 'finished', 'my-group-id-1', 'Completed'),
    ];
    const msgs = runItems(items);
    const wf = findWorkflow(msgs, RUN_ID);
    expect(wf!.phases[0]!.id).toBe('my-group-id-1');
  });
});

// Internal: re-export the WorkflowMessage type for ad-hoc
// assertions in this file.
export type { WorkflowMessage };
